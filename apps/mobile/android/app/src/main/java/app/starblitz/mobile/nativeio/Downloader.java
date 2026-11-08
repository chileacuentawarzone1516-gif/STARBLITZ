package app.starblitz.mobile.nativeio;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.Map;

/**
 * Descarga de archivos grandes (modelos) con las mismas reglas que {@code core/download.py} del PC y
 * {@code platform/transfer.ts}:
 * <ul>
 *   <li>se escribe en {@code <destino>.part}; el nombre final solo existe con el archivo completo y verificado;</li>
 *   <li>una descarga interrumpida (red, cierre de la app, cancelación) continúa donde se quedó con {@code Range};</li>
 *   <li>si se conoce el SHA-256 o el tamaño se comprueban, y un archivo corrupto se borra;</li>
 *   <li>las credenciales (Authorization) solo viajan al servidor original: se retiran al redirigir a otro dominio.</li>
 * </ul>
 */
public final class Downloader {
    public interface Progress { void onProgress(long done, long total); }

    public static final class Cancel {
        private volatile boolean cancelled;
        public void cancel() { cancelled = true; }
        public boolean isCancelled() { return cancelled; }
    }

    /** Error de descarga con un código estable que la interfaz traduce a un mensaje. */
    public static final class DownloadException extends IOException {
        public final String code;
        public final int status;
        public DownloadException(String code, int status, String message) { super(message); this.code = code; this.status = status; }
    }

    private static final int MAX_REDIRECTS = 6;
    private static final int BUFFER = 64 * 1024;

    private final int retries;
    private final long backoffMs;
    private final int connectTimeoutMs;
    private final int idleTimeoutMs;

    public Downloader() { this(4, 2000, 20_000, 60_000); }

    public Downloader(int retries, long backoffMs, int connectTimeoutMs, int idleTimeoutMs) {
        this.retries = retries;
        this.backoffMs = backoffMs;
        this.connectTimeoutMs = connectTimeoutMs;
        this.idleTimeoutMs = idleTimeoutMs;
    }

    public void download(String url, File dest, Map<String, String> headers, long expectedSize, String sha256, Cancel cancel, Progress progress) throws IOException {
        String sha = sha256 == null || sha256.isEmpty() ? null : sha256.toLowerCase(Locale.ROOT);
        File parent = dest.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs()) throw new IOException("No se pudo crear la carpeta de destino");

        if (dest.isFile()) {
            long size = dest.length();
            if ((expectedSize <= 0 || size == expectedSize) && (sha == null || sha256Of(dest).equals(sha))) {
                if (progress != null) progress.onProgress(size, size);
                return;
            }
            if (!dest.delete()) throw new IOException("No se pudo reemplazar el archivo incompleto");
        }

        File part = new File(dest.getPath() + ".part");
        int lastStatus = 0;
        boolean ok = false;
        for (int attempt = 0; attempt < retries && !ok; attempt++) {
            try {
                stream(url, part, headers, expectedSize, cancel, progress);
                // Si el servidor cortó antes de tiempo sin avisar, se reintenta (y se reanuda) en vez de dar la descarga por buena.
                if (expectedSize > 0 && part.length() < expectedSize) throw new IOException("La conexión se cortó antes de terminar");
                ok = true;
            } catch (DownloadException e) {
                if (e.code.equals("cancelled") || e.code.equals("disk_full") || e.code.equals("insecure")) throw e;
                lastStatus = e.status;
                if (e.status == 401 || e.status == 403 || e.status == 404 || e.status == 410) break;
            } catch (IOException e) {
                if (cancel != null && cancel.isCancelled()) throw new DownloadException("cancelled", 0, "Descarga cancelada");
                if (isDiskFull(e)) throw new DownloadException("disk_full", 0, "No queda espacio en el teléfono");
                lastStatus = 0;
            }
            if (!ok) sleep(Math.min(backoffMs * (attempt + 1), 8000), cancel);
        }
        if (!ok) throw failure(lastStatus);

        long size = part.length();
        if (expectedSize > 0 && size != expectedSize) {
            part.delete();
            throw new DownloadException("integrity", 0, "La descarga quedó incompleta (" + size + " de " + expectedSize + " bytes).");
        }
        if (sha != null && !sha256Of(part).equals(sha)) {
            part.delete();
            throw new DownloadException("integrity", 0, "La descarga está corrupta (huella SHA-256 distinta).");
        }
        Files.move(part.toPath(), dest.toPath(), StandardCopyOption.REPLACE_EXISTING);
    }

    private static DownloadException failure(int status) {
        if (status == 401 || status == 403) return new DownloadException("auth_required", status, "El archivo exige iniciar sesión");
        if (status == 404 || status == 410) return new DownloadException("not_found", status, "El archivo ya no existe");
        return new DownloadException("download_failed", status, "No se pudo descargar el archivo");
    }

    private static boolean isDiskFull(IOException e) {
        String m = String.valueOf(e.getMessage()).toLowerCase(Locale.ROOT);
        return m.contains("no space left") || m.contains("enospc");
    }

    private static void sleep(long ms, Cancel cancel) throws DownloadException {
        long end = System.currentTimeMillis() + ms;
        while (System.currentTimeMillis() < end) {
            if (cancel != null && cancel.isCancelled()) throw new DownloadException("cancelled", 0, "Descarga cancelada");
            try { Thread.sleep(Math.min(100, Math.max(1, end - System.currentTimeMillis()))); } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new DownloadException("cancelled", 0, "Descarga cancelada");
            }
        }
    }

    private void stream(String url, File part, Map<String, String> headers, long expected, Cancel cancel, Progress progress) throws IOException {
        long offset = part.isFile() ? part.length() : 0;
        if (expected > 0 && offset > expected) { part.delete(); offset = 0; }
        if (expected > 0 && offset == expected) return;

        HttpURLConnection conn = open(url, headers, offset);
        try {
            int status = conn.getResponseCode();
            if (status == 416) return; // el servidor dice que ya tenemos todo: se verifica después
            if (status < 200 || status >= 300) throw new DownloadException("http", status, "HTTP " + status);
            boolean resumed = status == 206 && offset > 0;
            if (offset > 0 && !resumed) offset = 0; // el servidor no admite reanudar: se empieza de cero
            long length = conn.getContentLengthLong();
            long total = expected > 0 ? expected : (length > 0 ? length + offset : 0);
            long written = offset, lastReport = 0, start = offset;
            try (InputStream in = conn.getInputStream(); FileOutputStream out = new FileOutputStream(part, offset > 0)) {
                byte[] buf = new byte[BUFFER];
                int n;
                while ((n = in.read(buf)) > 0) {
                    if (cancel != null && cancel.isCancelled()) throw new DownloadException("cancelled", 0, "Descarga cancelada");
                    out.write(buf, 0, n);
                    written += n;
                    long now = System.currentTimeMillis();
                    if (progress != null && now - lastReport > 250) { lastReport = now; progress.onProgress(written, total > 0 ? total : written); }
                }
                out.getFD().sync();
            }
            // HttpURLConnection no avisa siempre de un cierre prematuro: se compara con lo que anunció el servidor.
            if (length > 0 && written - start < length) throw new IOException("La conexión se cortó antes de terminar");
            if (progress != null) progress.onProgress(written, total > 0 ? total : written);
        } catch (SocketTimeoutException e) {
            throw new IOException("Sin datos del servidor", e);
        } finally {
            conn.disconnect();
        }
    }

    /** Abre la conexión siguiendo las redirecciones a mano para poder retirar las credenciales al cambiar de dominio. */
    private HttpURLConnection open(String url, Map<String, String> headers, long offset) throws IOException {
        URL current = new URL(url);
        String originHost = current.getHost();
        for (int hop = 0; hop <= MAX_REDIRECTS; hop++) {
            if (!current.getProtocol().equals("https") && !isLoopback(current.getHost())) {
                throw new DownloadException("insecure", 0, "Solo se permiten descargas por HTTPS");
            }
            HttpURLConnection c = (HttpURLConnection) current.openConnection();
            c.setInstanceFollowRedirects(false);
            c.setConnectTimeout(connectTimeoutMs);
            c.setReadTimeout(idleTimeoutMs);
            c.setRequestProperty("User-Agent", "STARBLITZ-Mobile");
            if (headers != null) {
                for (Map.Entry<String, String> h : headers.entrySet()) {
                    boolean secret = h.getKey().equalsIgnoreCase("Authorization") || h.getKey().equalsIgnoreCase("Cookie");
                    if (!secret || current.getHost().equalsIgnoreCase(originHost)) c.setRequestProperty(h.getKey(), h.getValue());
                }
            }
            if (offset > 0) c.setRequestProperty("Range", "bytes=" + offset + "-");
            int status = c.getResponseCode();
            if (status == 301 || status == 302 || status == 303 || status == 307 || status == 308) {
                String loc = c.getHeaderField("Location");
                c.disconnect();
                if (loc == null) throw new DownloadException("http", status, "Redirección sin destino");
                current = new URL(current, loc);
                continue;
            }
            return c;
        }
        throw new DownloadException("http", 310, "Demasiadas redirecciones");
    }

    private static boolean isLoopback(String host) { return host.equals("127.0.0.1") || host.equals("localhost") || host.equals("[::1]"); }

    public static String sha256Of(File f) throws IOException {
        try (InputStream in = Files.newInputStream(f.toPath())) {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] buf = new byte[BUFFER];
            int n;
            while ((n = in.read(buf)) > 0) md.update(buf, 0, n);
            StringBuilder sb = new StringBuilder();
            for (byte b : md.digest()) sb.append(String.format("%02x", b));
            return sb.toString();
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IOException(e);
        }
    }
}
