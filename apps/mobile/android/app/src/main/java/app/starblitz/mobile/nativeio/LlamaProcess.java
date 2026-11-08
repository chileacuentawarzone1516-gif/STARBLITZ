package app.starblitz.mobile.nativeio;

import java.io.BufferedReader;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;

/**
 * Proceso local de {@code llama-server} (llama.cpp) dentro del teléfono. Escucha solo en 127.0.0.1, en un puerto libre,
 * y se inicia bajo demanda: aquí solo se lanza, se espera a que responda {@code /health} y se detiene; QUÉ opciones usar
 * lo decide la parte web ({@code models/runtime.ts}).
 *
 * El ejecutable es {@code libllama-server-exe.so} (Android solo extrae como ejecutables los archivos lib*.so de la app) y
 * sus bibliotecas están en la misma carpeta; se localizan con LD_LIBRARY_PATH porque el binario oficial no lleva RUNPATH.
 */
public final class LlamaProcess {
    public static final String EXE_NAME = "libllama-server-exe.so";
    private static final int LOG_LINES = 400;

    /** Fallo al iniciar: {@code reason} es exited | timeout | cancelled | missing. */
    public static final class StartException extends IOException {
        public final String reason;
        public final List<String> log;
        public StartException(String reason, String message, List<String> log) { super(message); this.reason = reason; this.log = log; }
    }

    public static final class Started {
        public final String baseUrl;
        public final long pid;
        Started(String baseUrl, long pid) { this.baseUrl = baseUrl; this.pid = pid; }
    }

    private final File exe;
    private final File libDir;
    private final Map<String, String> extraEnv;
    private final Object lock = new Object();
    private final Deque<String> log = new ArrayDeque<>();
    private Process proc;
    private Thread reader;

    public LlamaProcess(File libDir, Map<String, String> extraEnv) {
        this.libDir = libDir;
        this.exe = new File(libDir, EXE_NAME);
        this.extraEnv = extraEnv;
    }

    public boolean available() { return exe.isFile() && new File(libDir, "libllama-server-impl.so").isFile(); }

    public boolean isRunning() {
        synchronized (lock) { return proc != null && proc.isAlive(); }
    }

    public List<String> logTail(int lines) {
        synchronized (log) {
            List<String> all = new ArrayList<>(log);
            return all.subList(Math.max(0, all.size() - Math.max(1, lines)), all.size());
        }
    }

    /** Inicia el servidor y espera a que esté listo. Solo hay uno a la vez: un inicio nuevo detiene el anterior. */
    public Started start(String model, List<String> args, long timeoutMs, Downloader.Cancel cancel) throws IOException {
        if (!available()) throw new StartException("missing", "Esta versión de STARBLITZ no incluye el motor de lenguaje para este teléfono.", logTail(20));
        if (!new File(model).isFile()) throw new StartException("missing", "No se encuentra el archivo del modelo.", logTail(20));
        stop();
        int port = freePort();
        List<String> cmd = new ArrayList<>();
        cmd.add(exe.getPath());
        cmd.add("-m"); cmd.add(model);
        cmd.add("--host"); cmd.add("127.0.0.1");
        cmd.add("--port"); cmd.add(String.valueOf(port));
        cmd.addAll(args);

        ProcessBuilder pb = new ProcessBuilder(cmd);
        pb.directory(libDir);
        pb.redirectErrorStream(true);
        Map<String, String> env = pb.environment();
        String old = env.get("LD_LIBRARY_PATH");
        env.put("LD_LIBRARY_PATH", libDir.getPath() + (old == null || old.isEmpty() ? "" : ":" + old));
        if (extraEnv != null) env.putAll(extraEnv);

        synchronized (log) { log.clear(); }
        Process p;
        try {
            p = pb.start();
        } catch (IOException e) {
            throw new StartException("missing", "No se pudo ejecutar el motor de lenguaje: " + e.getMessage(), logTail(20));
        }
        synchronized (lock) {
            proc = p;
            reader = new Thread(() -> pump(p.getInputStream()), "llama-log");
            reader.setDaemon(true);
            reader.start();
        }

        String base = "http://127.0.0.1:" + port;
        long deadline = System.currentTimeMillis() + timeoutMs;
        while (true) {
            if (cancel != null && cancel.isCancelled()) { stop(); throw new StartException("cancelled", "Inicio cancelado", logTail(20)); }
            if (!p.isAlive()) {
                List<String> tail = logTail(40);
                synchronized (lock) { if (proc == p) proc = null; }
                throw new StartException("exited", "El motor de lenguaje se cerró al iniciar (código " + exitCode(p) + ").", tail);
            }
            if (healthy(base)) return new Started(base, pidOf(p));
            if (System.currentTimeMillis() > deadline) { stop(); throw new StartException("timeout", "El motor de lenguaje tardó demasiado en cargar el modelo.", logTail(20)); }
            try { Thread.sleep(250); } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                stop();
                throw new StartException("cancelled", "Inicio cancelado", logTail(20));
            }
        }
    }

    public void stop() {
        Process p;
        synchronized (lock) { p = proc; proc = null; }
        if (p == null) return;
        p.destroy();
        try {
            if (!p.waitFor(3, TimeUnit.SECONDS)) { p.destroyForcibly(); p.waitFor(2, TimeUnit.SECONDS); }
        } catch (InterruptedException e) {
            p.destroyForcibly();
            Thread.currentThread().interrupt();
        }
    }

    private void pump(InputStream in) {
        try (BufferedReader r = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8))) {
            String line;
            while ((line = r.readLine()) != null) {
                synchronized (log) {
                    if (log.size() >= LOG_LINES) log.removeFirst();
                    log.addLast(line);
                }
            }
        } catch (IOException ignored) { /* el proceso terminó */ }
    }

    private static int exitCode(Process p) {
        try { return p.exitValue(); } catch (IllegalThreadStateException e) { return -1; }
    }

    private static int freePort() throws IOException {
        try (ServerSocket s = new ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))) { return s.getLocalPort(); }
    }

    private static boolean healthy(String base) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(base + "/health").openConnection();
            c.setConnectTimeout(800);
            c.setReadTimeout(1500);
            return c.getResponseCode() == 200;
        } catch (IOException e) {
            return false;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    /** Quien puede terminar un proceso por PID (en Android, {@code android.os.Process.killProcess}). */
    public interface Killer { void kill(int pid); }

    /**
     * Si la app se cerró a la fuerza, un {@code llama-server} anterior puede seguir ocupando la memoria del modelo.
     * Se buscan los procesos del propio usuario con este ejecutable y se terminan. Devuelve cuántos encontró.
     */
    public static int killStale(Killer killer) {
        File[] entries = new File("/proc").listFiles();
        if (entries == null) return 0;
        int found = 0;
        for (File e : entries) {
            String name = e.getName();
            if (!name.matches("\\d+")) continue;
            try {
                byte[] raw = java.nio.file.Files.readAllBytes(new File(e, "cmdline").toPath());
                if (new String(raw, StandardCharsets.UTF_8).contains(EXE_NAME)) { found++; killer.kill(Integer.parseInt(name)); }
            } catch (IOException | RuntimeException ignored) { /* otro usuario o ya terminó */ }
        }
        return found;
    }

    /** PID del proceso: {@code Process.pid()} (API 33+) o, en versiones anteriores, el campo interno; -1 si no se puede. */
    public static long pidOf(Process p) {
        try {
            Method m = Process.class.getMethod("pid");
            return ((Number) m.invoke(p)).longValue();
        } catch (Throwable ignored) { /* versión anterior */ }
        try {
            Field f = p.getClass().getDeclaredField("pid");
            f.setAccessible(true);
            return ((Number) f.get(p)).longValue();
        } catch (Throwable ignored) {
            return -1;
        }
    }
}
