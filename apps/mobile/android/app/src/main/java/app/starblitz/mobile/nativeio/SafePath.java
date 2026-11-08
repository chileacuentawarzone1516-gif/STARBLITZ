package app.starblitz.mobile.nativeio;

import java.io.File;
import java.io.IOException;
import java.util.regex.Pattern;

/**
 * Todas las rutas que llegan desde la interfaz son relativas a la carpeta de datos de STARBLITZ y se validan aquí:
 * ninguna puede salir de ella (sin «..», sin rutas absolutas, sin caracteres raros ni enlaces simbólicos hacia fuera).
 */
public final class SafePath {
    private static final Pattern SEGMENT = Pattern.compile("^[\\w][\\w .()+@=,-]*$");

    private SafePath() {}

    /** Devuelve la ruta normalizada («a/b/c») o lanza IllegalArgumentException. */
    public static String normalize(String path) {
        if (path == null || path.isEmpty() || path.startsWith("/") || path.contains("\\")) {
            throw new IllegalArgumentException("Ruta de archivo no válida.");
        }
        StringBuilder out = new StringBuilder();
        for (String part : path.split("/")) {
            if (part.isEmpty() || part.equals(".")) continue;
            if (part.equals("..") || !SEGMENT.matcher(part).matches()) {
                throw new IllegalArgumentException("Ruta de archivo no válida.");
            }
            if (out.length() > 0) out.append('/');
            out.append(part);
        }
        if (out.length() == 0) throw new IllegalArgumentException("Ruta de archivo no válida.");
        return out.toString();
    }

    /** Resuelve la ruta dentro de {@code root} y comprueba que el resultado real siga dentro de ella. */
    public static File resolve(File root, String path) throws IOException {
        File f = new File(root, normalize(path));
        String base = root.getCanonicalPath() + File.separator;
        if (!(f.getCanonicalPath() + File.separator).startsWith(base)) {
            throw new IllegalArgumentException("Ruta de archivo no válida.");
        }
        return f;
    }
}
