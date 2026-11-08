package app.starblitz.mobile.nativeio;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.Base64;

/**
 * Escritura por trozos de archivos exportados (PDF/ZIP de cientos de MB no caben de una vez en el puente WebView↔Java)
 * y saneado de nombres. Es Java puro: se prueba en la JVM sin Android.
 */
public final class ExportIo {
    private ExportIo() {}

    /** Añade los bytes (base64) al archivo; {@code truncate} lo vacía antes. Devuelve el tamaño resultante. */
    public static long appendBase64(File file, String data, boolean truncate) throws IOException {
        final byte[] bytes;
        try {
            bytes = Base64.getDecoder().decode(data == null ? "" : data);
        } catch (IllegalArgumentException e) {
            throw new IOException("Datos de exportación no válidos.");
        }
        File parent = file.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs()) throw new IOException("No se pudo crear la carpeta de exportación.");
        try (FileOutputStream out = new FileOutputStream(file, !truncate)) {
            out.write(bytes);
        }
        return file.length();
    }

    /** Nombre de archivo apto para la carpeta Descargas: sin rutas, sin caracteres de control ni reservados. */
    public static String safeDisplayName(String name) {
        String n = name == null ? "" : name.replace('\\', '/');
        n = n.substring(n.lastIndexOf('/') + 1).replaceAll("[\\p{Cntrl}:*?\"<>|]+", " ").trim();
        while (n.startsWith(".")) n = n.substring(1).trim();
        if (n.length() > 120) {
            int dot = n.lastIndexOf('.');
            String ext = dot > 0 && n.length() - dot <= 8 ? n.substring(dot) : "";
            n = n.substring(0, 120 - ext.length()) + ext;
        }
        return n.isEmpty() ? "starblitz" : n;
    }
}
