package app.starblitz.mobile.nativeio;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.File;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Pruebas de la parte nativa que no depende de Android (descargas, rutas seguras, proceso del servidor de modelos).
 * Se ejecutan en cualquier JDK: {@code javac} + {@code java app.starblitz.mobile.nativeio.NativeIoSelfTest <python> <fake_llama_server.py>}.
 * Son de INTEGRACIÓN (sockets y procesos reales) pero no ejercitan la API de Android.
 */
public final class NativeIoSelfTest {
    private static int failures = 0;
    private static int checks = 0;

    private static void check(boolean ok, String what) {
        checks++;
        if (!ok) { failures++; System.out.println("  FALLO: " + what); } else System.out.println("  ok: " + what);
    }

    private static String hex(byte[] d) throws Exception {
        StringBuilder sb = new StringBuilder();
        for (byte b : MessageDigest.getInstance("SHA-256").digest(d)) sb.append(String.format("%02x", b));
        return sb.toString();
    }

    public static void main(String[] args) throws Exception {
        safePath();
        downloads();
        export();
        if (args.length >= 2) llama(args[0], args[1]);
        System.out.println(checks + " comprobaciones, " + failures + " fallos");
        System.exit(failures == 0 ? 0 : 1);
    }

    // -- exportación ---------------------------------------------------------------------------------------------
    private static void export() throws Exception {
        System.out.println("exportación");
        File dir = java.nio.file.Files.createTempDirectory("sb-export").toFile();
        File out = new File(dir, "exports/cap.pdf");
        byte[] data = new byte[3 * 1024 * 1024 * 2 + 1234];
        new java.util.Random(7).nextBytes(data);
        long size = 0;
        int chunk = 3 * 1024 * 1024;
        for (int off = 0; off < data.length; off += chunk) {
            byte[] part = java.util.Arrays.copyOfRange(data, off, Math.min(data.length, off + chunk));
            size = ExportIo.appendBase64(out, java.util.Base64.getEncoder().encodeToString(part), off == 0);
        }
        check(size == data.length && out.length() == data.length, "los trozos se concatenan en un archivo del tamaño exacto");
        check(Downloader.sha256Of(out).equals(hex(data)), "el contenido exportado es idéntico bit a bit");
        ExportIo.appendBase64(out, java.util.Base64.getEncoder().encodeToString(new byte[] {1, 2, 3}), true);
        check(out.length() == 3, "truncate vacía el archivo antes de escribir");
        boolean bad = false;
        try { ExportIo.appendBase64(out, "esto no es base64!!", false); } catch (java.io.IOException e) { bad = true; }
        check(bad && out.length() == 3, "base64 inválido se rechaza sin tocar el archivo");
        check(ExportIo.safeDisplayName("../../etc/pas:swd.pdf").equals("pas swd.pdf"), "el nombre pierde rutas y caracteres reservados");
        check(ExportIo.safeDisplayName("...oculto").equals("oculto") && ExportIo.safeDisplayName("").equals("starblitz"), "sin puntos iniciales y con nombre por defecto");
        String longName = "a".repeat(300) + ".pdf";
        String shortened = ExportIo.safeDisplayName(longName);
        check(shortened.length() == 120 && shortened.endsWith(".pdf"), "un nombre largo se acorta conservando la extensión");
    }

    // -- rutas ---------------------------------------------------------------------------------------------------
    private static void safePath() throws Exception {
        System.out.println("SafePath");
        check(SafePath.normalize("llm/qwen3-4b/model.gguf").equals("llm/qwen3-4b/model.gguf"), "ruta normal");
        check(SafePath.normalize("a//b/./c").equals("a/b/c"), "se normalizan barras y puntos");
        for (String bad : new String[] {"../x", "a/../../x", "/etc/passwd", "a\\b", "", ".", "a/..", "a/.hidden", "a/b c/\u0000", "a/;rm"}) {
            boolean rejected = false;
            try { SafePath.normalize(bad); } catch (IllegalArgumentException e) { rejected = true; }
            check(rejected, "rechaza «" + bad.replace("\u0000", "\\0") + "»");
        }
        File root = Files.createTempDirectory("sb-root").toFile();
        File outside = Files.createTempDirectory("sb-outside").toFile();
        Files.createSymbolicLink(new File(root, "link").toPath(), outside.toPath());
        boolean rejected = false;
        try { SafePath.resolve(root, "link/secret"); } catch (IllegalArgumentException e) { rejected = true; }
        check(rejected, "un enlace simbólico hacia fuera no se sigue");
        check(SafePath.resolve(root, "ok/file").getPath().startsWith(root.getCanonicalPath()), "ruta válida dentro de la raíz");
    }

    // -- descargas -----------------------------------------------------------------------------------------------
    private static final class Fixture {
        final byte[] data = new byte[3_000_000];
        final Map<String, String> seenAuth = new HashMap<>();
        final AtomicInteger requests = new AtomicInteger();
        final AtomicInteger cutAfter = new AtomicInteger(-1);   // bytes tras los que se corta la primera respuesta
        volatile boolean noRange;
        volatile boolean corrupt;
        HttpServer origin, cdn;
        int originPort, cdnPort;

        Fixture() throws Exception {
            new Random(7).nextBytes(data);
            origin = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            cdn = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            originPort = origin.getAddress().getPort();
            cdnPort = cdn.getAddress().getPort();
            // El «origen» (127.0.0.1) redirige al «CDN» usando otro nombre de host (localhost): las credenciales no deben viajar allí.
            origin.createContext("/resolve", ex -> {
                seenAuth.put("origin", String.valueOf(ex.getRequestHeaders().getFirst("Authorization")));
                ex.getResponseHeaders().add("Location", "http://localhost:" + cdnPort + "/blob");
                ex.sendResponseHeaders(302, -1);
                ex.close();
            });
            origin.createContext("/missing", ex -> { ex.sendResponseHeaders(404, -1); ex.close(); });
            origin.createContext("/private", ex -> { ex.sendResponseHeaders(403, -1); ex.close(); });
            cdn.createContext("/blob", ex -> {
                requests.incrementAndGet();
                seenAuth.put("cdn", String.valueOf(ex.getRequestHeaders().getFirst("Authorization")));
                serve(ex);
            });
            origin.start();
            cdn.start();
        }

        void serve(HttpExchange ex) throws IOException {
            String range = ex.getRequestHeaders().getFirst("Range");
            int start = 0;
            if (range != null && !noRange) start = Integer.parseInt(range.replaceAll("[^0-9-]", "").split("-")[0]);
            byte[] body = Arrays.copyOfRange(data, start, data.length);
            if (corrupt) body[body.length / 2] ^= 0x55;
            if (start > 0) ex.getResponseHeaders().add("Content-Range", "bytes " + start + "-" + (data.length - 1) + "/" + data.length);
            int cut = cutAfter.getAndSet(-1);
            ex.sendResponseHeaders(start > 0 ? 206 : 200, body.length);
            try (OutputStream os = ex.getResponseBody()) {
                if (cut >= 0 && cut < body.length) { os.write(body, 0, cut); os.flush(); ex.getHttpContext(); throw new IOException("corte simulado"); }
                os.write(body);
            }
        }

        String url() { return "http://127.0.0.1:" + originPort + "/resolve"; }
        void stop() { origin.stop(0); cdn.stop(0); }
    }

    private static void downloads() throws Exception {
        System.out.println("Downloader");
        Fixture fx = new Fixture();
        try {
            Downloader dl = new Downloader(3, 20, 3000, 3000);
            File dir = Files.createTempDirectory("sb-dl").toFile();
            String sha = hex(fx.data);
            Map<String, String> auth = new HashMap<>();
            auth.put("Authorization", "Bearer secreto");

            // 1) descarga normal con redirección entre dominios: verifica tamaño y SHA, y no filtra credenciales
            File a = new File(dir, "a/model.gguf");
            List<Long> progress = Collections.synchronizedList(new ArrayList<>());
            dl.download(fx.url(), a, auth, fx.data.length, sha, null, (d, t) -> progress.add(d));
            check(a.length() == fx.data.length && Downloader.sha256Of(a).equals(sha), "descarga completa y verificada");
            check(!new File(a.getPath() + ".part").exists(), "no queda archivo .part");
            check("Bearer secreto".equals(fx.seenAuth.get("origin")), "el origen recibe la credencial");
            check("null".equals(fx.seenAuth.get("cdn")), "el otro dominio NO recibe la credencial (" + fx.seenAuth.get("cdn") + ")");
            check(!progress.isEmpty() && progress.get(progress.size() - 1) == fx.data.length, "el progreso termina en el 100 %");

            // 2) ya existe y es correcta: no vuelve a descargar
            int before = fx.requests.get();
            dl.download(fx.url(), a, auth, fx.data.length, sha, null, null);
            check(fx.requests.get() == before, "un archivo completo no se descarga otra vez");

            // 3) corte a mitad: reintenta y reanuda con Range sin repetir lo ya recibido
            File b = new File(dir, "b/model.gguf");
            fx.cutAfter.set(1_200_000);
            fx.requests.set(0);
            dl.download(fx.url(), b, null, fx.data.length, sha, null, null);
            check(Downloader.sha256Of(b).equals(sha), "tras un corte la descarga se reanuda y queda íntegra");
            check(fx.requests.get() == 2, "hicieron falta 2 peticiones (" + fx.requests.get() + ")");

            // 4) continúa un .part existente (cierre de la app)
            File c = new File(dir, "c/model.gguf");
            c.getParentFile().mkdirs();
            Files.write(new File(c.getPath() + ".part").toPath(), Arrays.copyOf(fx.data, 1_000_000));
            fx.requests.set(0);
            dl.download(fx.url(), c, null, fx.data.length, sha, null, null);
            check(Downloader.sha256Of(c).equals(sha) && fx.requests.get() == 1, "continúa desde un .part previo con una sola petición");

            // 5) el servidor ignora Range: se empieza de cero sin corromper
            File d = new File(dir, "d/model.gguf");
            d.getParentFile().mkdirs();
            Files.write(new File(d.getPath() + ".part").toPath(), Arrays.copyOf(fx.data, 500_000));
            fx.noRange = true;
            dl.download(fx.url(), d, null, fx.data.length, sha, null, null);
            fx.noRange = false;
            check(Downloader.sha256Of(d).equals(sha), "si el servidor no admite Range se reinicia sin corromper");

            // 6) contenido corrupto: se detecta, se borra y se informa
            File e = new File(dir, "e/model.gguf");
            fx.corrupt = true;
            String code = "";
            try { dl.download(fx.url(), e, null, fx.data.length, sha, null, null); } catch (Downloader.DownloadException ex) { code = ex.code; }
            fx.corrupt = false;
            check(code.equals("integrity") && !e.exists() && !new File(e.getPath() + ".part").exists(), "archivo corrupto: error 'integrity' y nada queda en disco");

            // 7) errores HTTP sin reintentos inútiles
            String c404 = "", c403 = "";
            try { dl.download("http://127.0.0.1:" + fx.originPort + "/missing", new File(dir, "f"), null, 0, null, null, null); } catch (Downloader.DownloadException ex) { c404 = ex.code; }
            try { dl.download("http://127.0.0.1:" + fx.originPort + "/private", new File(dir, "g"), null, 0, null, null, null); } catch (Downloader.DownloadException ex) { c403 = ex.code; }
            check(c404.equals("not_found"), "404 → not_found");
            check(c403.equals("auth_required"), "403 → auth_required");

            // 8) HTTP en claro hacia Internet: rechazado
            String insecure = "";
            try { dl.download("http://example.com/x.gguf", new File(dir, "h"), null, 0, null, null, null); } catch (Downloader.DownloadException ex) { insecure = ex.code; }
            check(insecure.equals("insecure"), "HTTP sin cifrar fuera del equipo → insecure");

            // 9) cancelación: conserva el .part
            File k = new File(dir, "k/model.gguf");
            Downloader.Cancel cancel = new Downloader.Cancel();
            String cc = "";
            try { dl.download(fx.url(), k, null, fx.data.length, sha, cancel, (dn, t) -> cancel.cancel()); } catch (Downloader.DownloadException ex) { cc = ex.code; }
            check(cc.equals("cancelled") && !k.exists() && new File(k.getPath() + ".part").exists(), "cancelar conserva el .part para continuar después");
            // y continúa
            dl.download(fx.url(), k, null, fx.data.length, sha, null, null);
            check(Downloader.sha256Of(k).equals(sha), "tras cancelar, la descarga continúa y queda íntegra");
        } finally {
            fx.stop();
        }
    }

    // -- servidor de modelos -------------------------------------------------------------------------------------
    private static void llama(String python, String fakeServer) throws Exception {
        System.out.println("LlamaProcess");
        File libDir = Files.createTempDirectory("sb-lib").toFile();
        File exe = new File(libDir, LlamaProcess.EXE_NAME);
        Files.write(exe.toPath(), ("#!/bin/sh\nexec \"" + python + "\" \"" + fakeServer + "\" \"$@\"\n").getBytes());
        exe.setExecutable(true);
        Files.write(new File(libDir, "libllama-server-impl.so").toPath(), new byte[] {1});
        File model = File.createTempFile("model", ".gguf");
        Map<String, String> env = new HashMap<>();
        File logFile = File.createTempFile("fake", ".jsonl");
        env.put("FAKE_LLAMA_LOG", logFile.getPath());
        LlamaProcess p = new LlamaProcess(libDir, env);

        check(p.available(), "motor disponible cuando están las bibliotecas");
        check(!new LlamaProcess(Files.createTempDirectory("sb-empty").toFile(), env).available(), "sin bibliotecas → no disponible");

        LlamaProcess.Started s = p.start(model.getPath(), Arrays.asList("-c", "4096", "--jinja"), 15_000, null);
        check(s.baseUrl.startsWith("http://127.0.0.1:") && p.isRunning(), "arranca y responde /health en 127.0.0.1");
        String log = new String(Files.readAllBytes(logFile.toPath()));
        check(log.contains("--jinja") && log.contains("\"--host\"") == false || log.contains("--jinja"), "recibe las opciones que decide la parte web");
        p.stop();
        check(!p.isRunning(), "stop() detiene el proceso");

        // arranque con una opción desconocida: el servidor se cierra → StartException(exited) con el registro
        Map<String, String> env2 = new HashMap<>(env);
        env2.put("FAKE_LLAMA_REJECT", "--reasoning-budget");
        LlamaProcess q = new LlamaProcess(libDir, env2);
        String reason = "";
        try { q.start(model.getPath(), Arrays.asList("--reasoning-budget", "0"), 15_000, null); } catch (LlamaProcess.StartException e) { reason = e.reason; }
        check(reason.equals("exited"), "una opción rechazada se informa como 'exited' (" + reason + ")");

        // modelo inexistente
        String miss = "";
        try { p.start("/no/existe.gguf", Collections.emptyList(), 2000, null); } catch (LlamaProcess.StartException e) { miss = e.reason; }
        check(miss.equals("missing"), "modelo inexistente → 'missing'");

        // cancelación durante la carga
        Map<String, String> env3 = new HashMap<>(env);
        env3.put("FAKE_LLAMA_DELAY", "30");
        LlamaProcess r = new LlamaProcess(libDir, env3);
        Downloader.Cancel cancel = new Downloader.Cancel();
        new Thread(() -> { try { Thread.sleep(700); } catch (InterruptedException ignored) { /* nada */ } cancel.cancel(); }).start();
        String cr = "";
        long t0 = System.currentTimeMillis();
        try { r.start(model.getPath(), Collections.emptyList(), 60_000, cancel); } catch (LlamaProcess.StartException e) { cr = e.reason; }
        check(cr.equals("cancelled") && !r.isRunning() && System.currentTimeMillis() - t0 < 10_000, "cancelar durante la carga detiene el proceso");

        // tiempo agotado
        String to = "";
        try { r.start(model.getPath(), Collections.emptyList(), 1500, null); } catch (LlamaProcess.StartException e) { to = e.reason; }
        check(to.equals("timeout") && !r.isRunning(), "si no responde a tiempo → 'timeout' y no deja procesos");
    }
}
