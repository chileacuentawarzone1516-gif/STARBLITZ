package app.starblitz.mobile;

import android.app.ActivityManager;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ApplicationInfo;
import android.database.Cursor;
import android.net.Uri;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Environment;
import android.os.PowerManager;
import android.os.StatFs;
import android.provider.MediaStore;
import android.view.WindowManager;
import app.starblitz.mobile.nativeio.Downloader;
import app.starblitz.mobile.nativeio.ExportIo;
import app.starblitz.mobile.nativeio.LlamaProcess;
import app.starblitz.mobile.nativeio.SafePath;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONArray;

/**
 * Lo que una página web no puede hacer sola en el teléfono, con la mínima superficie posible:
 * <ul>
 *   <li><b>Archivos</b> de la carpeta privada de STARBLITZ (rutas relativas validadas, nunca fuera de ella);</li>
 *   <li><b>Descargas</b> reanudables y verificadas (modelos de varios GB), también con la pantalla apagada;</li>
 *   <li><b>Motor de lenguaje</b>: inicia y detiene {@code llama-server} en 127.0.0.1;</li>
 *   <li><b>Estado del teléfono</b>: RAM, almacenamiento, batería, temperatura y ahorro de energía.</li>
 * </ul>
 * Las llamadas largas se ejecutan en un grupo de hilos propio para no bloquear el hilo de plugins de Capacitor.
 */
@CapacitorPlugin(name = "StarblitzNative")
public class StarblitzNativePlugin extends Plugin {
    private final ExecutorService pool = Executors.newCachedThreadPool();
    private final Map<String, Downloader.Cancel> downloads = new ConcurrentHashMap<>();
    private final Downloader downloader = new Downloader();
    private LlamaProcess llama;
    private File dataDir;
    private final Downloader.Cancel startCancel = new Downloader.Cancel();
    private volatile Downloader.Cancel starting = startCancel;

    @Override
    public void load() {
        dataDir = new File(getContext().getFilesDir(), "starblitz");
        //noinspection ResultOfMethodCallIgnored
        dataDir.mkdirs();
        File libDir = new File(getContext().getApplicationInfo().nativeLibraryDir);
        Map<String, String> env = new HashMap<>();
        File tmp = new File(getContext().getCacheDir(), "llama");
        //noinspection ResultOfMethodCallIgnored
        tmp.mkdirs();
        env.put("HOME", tmp.getPath());
        env.put("TMPDIR", tmp.getPath());
        llama = new LlamaProcess(libDir, env);
        // Si la app se cerró a la fuerza, un servidor anterior podría seguir ocupando la memoria del modelo.
        pool.execute(() -> LlamaProcess.killStale(pid -> android.os.Process.killProcess(pid)));
    }

    @Override
    protected void handleOnDestroy() {
        if (llama != null) llama.stop();
        for (Downloader.Cancel c : downloads.values()) c.cancel();
        pool.shutdownNow();
    }

    // -- ayudas ---------------------------------------------------------------------------------------------------
    private interface Work { void run() throws Exception; }

    private void async(PluginCall call, Work work) {
        pool.execute(() -> {
            try {
                work.run();
            } catch (IllegalArgumentException e) {
                call.reject(e.getMessage(), "invalid_path");
            } catch (Downloader.DownloadException e) {
                call.reject(e.getMessage(), e.code);
            } catch (LlamaProcess.StartException e) {
                JSObject extra = new JSObject();
                extra.put("log", new JSArray(e.log));
                call.reject(e.getMessage(), e.reason, extra);
            } catch (IOException e) {
                String m = String.valueOf(e.getMessage()).toLowerCase();
                call.reject(e.getMessage(), m.contains("no space left") ? "disk_full" : "io_error");
            } catch (Exception e) {
                call.reject(String.valueOf(e.getMessage()), "error");
            }
        });
    }

    private File file(PluginCall call, String key) throws IOException {
        return SafePath.resolve(dataDir, call.getString(key, ""));
    }

    // -- archivos --------------------------------------------------------------------------------------------------
    @PluginMethod
    public void fsStat(PluginCall call) {
        async(call, () -> {
            File f = file(call, "path");
            JSObject r = new JSObject();
            r.put("exists", f.exists());
            r.put("isDir", f.isDirectory());
            r.put("size", f.isFile() ? f.length() : 0);
            call.resolve(r);
        });
    }

    @PluginMethod
    public void fsList(PluginCall call) {
        async(call, () -> {
            File dir = file(call, "path");
            JSArray out = new JSArray();
            File[] kids = dir.listFiles();
            if (kids != null) {
                java.util.Arrays.sort(kids, (a, b) -> a.getName().compareTo(b.getName()));
                for (File k : kids) {
                    JSObject e = new JSObject();
                    e.put("name", k.getName());
                    e.put("isDir", k.isDirectory());
                    e.put("size", k.isFile() ? k.length() : 0);
                    out.put(e);
                }
            }
            JSObject r = new JSObject();
            r.put("entries", out);
            call.resolve(r);
        });
    }

    @PluginMethod
    public void fsRemove(PluginCall call) {
        async(call, () -> {
            deleteRecursive(file(call, "path"));
            call.resolve();
        });
    }

    private static void deleteRecursive(File f) throws IOException {
        if (!f.exists()) return;
        if (f.isDirectory() && !Files.isSymbolicLink(f.toPath())) {
            File[] kids = f.listFiles();
            if (kids != null) for (File k : kids) deleteRecursive(k);
        }
        if (!f.delete() && f.exists()) throw new IOException("No se pudo borrar " + f.getName());
    }

    @PluginMethod
    public void fsFreeBytes(PluginCall call) {
        async(call, () -> {
            JSObject r = new JSObject();
            r.put("bytes", new StatFs(dataDir.getPath()).getAvailableBytes());
            call.resolve(r);
        });
    }

    @PluginMethod
    public void fsSha256(PluginCall call) {
        async(call, () -> {
            File f = file(call, "path");
            if (!f.isFile()) throw new IOException("No existe el archivo");
            JSObject r = new JSObject();
            r.put("sha256", Downloader.sha256Of(f));
            call.resolve(r);
        });
    }

    @PluginMethod
    public void fsWriteText(PluginCall call) {
        async(call, () -> {
            File f = file(call, "path");
            File parent = f.getParentFile();
            if (parent != null) //noinspection ResultOfMethodCallIgnored
                parent.mkdirs();
            File tmp = new File(f.getPath() + ".tmp");
            Files.write(tmp.toPath(), call.getString("text", "").getBytes(StandardCharsets.UTF_8));
            Files.move(tmp.toPath(), f.toPath(), java.nio.file.StandardCopyOption.REPLACE_EXISTING);
            call.resolve();
        });
    }

    @PluginMethod
    public void fsReadText(PluginCall call) {
        async(call, () -> {
            File f = file(call, "path");
            JSObject r = new JSObject();
            if (f.isFile()) r.put("text", new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8));
            call.resolve(r);
        });
    }

    @PluginMethod
    public void fsAbsolutePath(PluginCall call) {
        async(call, () -> {
            JSObject r = new JSObject();
            r.put("path", file(call, "path").getPath());
            call.resolve(r);
        });
    }

    // -- exportación -----------------------------------------------------------------------------------------------
    @PluginMethod
    public void fsAppendBase64(PluginCall call) {
        async(call, () -> {
            long size = ExportIo.appendBase64(file(call, "path"), call.getString("data", ""), Boolean.TRUE.equals(call.getBoolean("truncate", false)));
            JSObject r = new JSObject();
            r.put("size", size);
            call.resolve(r);
        });
    }

    /** Copia un archivo privado a Descargas/STARBLITZ con MediaStore: sin permisos de almacenamiento y sin exponer el resto del disco. */
    @PluginMethod
    public void saveToDownloads(PluginCall call) {
        async(call, () -> {
            File src = file(call, "path");
            if (!src.isFile()) throw new IOException("No existe el archivo que se quiere guardar.");
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
                call.reject("Guardar en Descargas requiere Android 10 o superior: usa Compartir.", "unsupported");
                return;
            }
            ContentResolver cr = getContext().getContentResolver();
            ContentValues values = new ContentValues();
            values.put(MediaStore.MediaColumns.DISPLAY_NAME, ExportIo.safeDisplayName(call.getString("name", src.getName())));
            values.put(MediaStore.MediaColumns.MIME_TYPE, call.getString("mime", "application/octet-stream"));
            values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/STARBLITZ");
            values.put(MediaStore.MediaColumns.IS_PENDING, 1);
            Uri uri = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
            if (uri == null) throw new IOException("No se pudo crear el archivo en Descargas.");
            try (InputStream in = new FileInputStream(src); OutputStream out = cr.openOutputStream(uri)) {
                if (out == null) throw new IOException("No se pudo escribir en Descargas.");
                byte[] buf = new byte[1 << 16];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            } catch (IOException | RuntimeException e) {
                cr.delete(uri, null, null);
                throw e;
            }
            ContentValues done = new ContentValues();
            done.put(MediaStore.MediaColumns.IS_PENDING, 0);
            cr.update(uri, done, null, null);
            String finalName = ExportIo.safeDisplayName(call.getString("name", src.getName()));
            try (Cursor c = cr.query(uri, new String[] {MediaStore.MediaColumns.DISPLAY_NAME}, null, null, null)) {
                if (c != null && c.moveToFirst()) finalName = c.getString(0); // MediaStore añade « (1)» si ya existía
            }
            JSObject r = new JSObject();
            r.put("location", "Descargas/STARBLITZ/" + finalName);
            call.resolve(r);
        });
    }

    // -- descargas -------------------------------------------------------------------------------------------------
    @PluginMethod
    public void download(PluginCall call) {
        final String id = call.getString("id", "");
        if (id.isEmpty() || downloads.containsKey(id)) { call.reject("Descarga duplicada", "busy"); return; }
        final Downloader.Cancel cancel = new Downloader.Cancel();
        downloads.put(id, cancel);
        async(call, () -> {
            try {
                File dest = file(call, "path");
                Map<String, String> headers = new HashMap<>();
                JSObject h = call.getObject("headers");
                if (h != null) {
                    for (Iterator<String> it = h.keys(); it.hasNext(); ) { String k = it.next(); headers.put(k, h.getString(k)); }
                }
                long expected = call.getData().optLong("expectedSize", 0);
                String sha = call.getString("sha256");
                downloader.download(call.getString("url", ""), dest, headers, expected, sha, cancel, (done, total) -> {
                    JSObject ev = new JSObject();
                    ev.put("id", id);
                    ev.put("done", done);
                    ev.put("total", total);
                    notifyListeners("downloadProgress", ev);
                });
                call.resolve();
            } finally {
                downloads.remove(id);
            }
        });
    }

    @PluginMethod
    public void cancelDownload(PluginCall call) {
        Downloader.Cancel c = downloads.get(call.getString("id", ""));
        if (c != null) c.cancel();
        call.resolve();
    }

    // -- motor de lenguaje -----------------------------------------------------------------------------------------
    @PluginMethod
    public void llamaAvailable(PluginCall call) {
        boolean arm64 = false;
        for (String abi : Build.SUPPORTED_ABIS) if (abi.equals("arm64-v8a")) arm64 = true;
        JSObject r = new JSObject();
        r.put("available", arm64 && llama.available());
        call.resolve(r);
    }

    @PluginMethod
    public void llamaStart(PluginCall call) {
        async(call, () -> {
            File model = SafePath.resolve(dataDir, relativeToData(call.getString("model", "")));
            List<String> args = new ArrayList<>();
            JSONArray arr = call.getData().optJSONArray("args");
            if (arr != null) for (int i = 0; i < arr.length(); i++) args.add(arr.getString(i));
            // Las rutas de archivos de las opciones (--mmproj) también deben estar dentro de la carpeta de datos.
            for (int i = 0; i + 1 < args.size(); i++) {
                if (args.get(i).equals("--mmproj")) args.set(i + 1, SafePath.resolve(dataDir, relativeToData(args.get(i + 1))).getPath());
            }
            long timeout = call.getData().optLong("timeoutMs", 240_000);
            starting = new Downloader.Cancel();
            LlamaProcess.Started s = llama.start(model.getPath(), args, timeout, starting);
            JSObject r = new JSObject();
            r.put("baseUrl", s.baseUrl);
            r.put("pid", s.pid);
            call.resolve(r);
        });
    }

    /** Acepta la ruta absoluta que entregó {@code fsAbsolutePath} y la devuelve relativa a la carpeta de datos. */
    private String relativeToData(String path) throws IOException {
        String base = dataDir.getCanonicalPath() + File.separator;
        String abs = new File(path).getCanonicalPath();
        if (!(abs + File.separator).startsWith(base) && !abs.startsWith(base)) throw new IllegalArgumentException("Ruta de archivo no válida.");
        return abs.substring(base.length());
    }

    @PluginMethod
    public void llamaStop(PluginCall call) {
        starting.cancel();
        async(call, () -> { llama.stop(); call.resolve(); });
    }

    @PluginMethod
    public void llamaIsRunning(PluginCall call) {
        JSObject r = new JSObject();
        r.put("running", llama.isRunning());
        call.resolve(r);
    }

    @PluginMethod
    public void llamaLog(PluginCall call) {
        JSObject r = new JSObject();
        r.put("lines", new JSArray(llama.logTail(call.getInt("lines", 40))));
        call.resolve(r);
    }

    // -- teléfono --------------------------------------------------------------------------------------------------
    @PluginMethod
    public void deviceInfo(PluginCall call) {
        async(call, () -> {
            Context ctx = getContext();
            ActivityManager am = (ActivityManager) ctx.getSystemService(Context.ACTIVITY_SERVICE);
            ActivityManager.MemoryInfo mi = new ActivityManager.MemoryInfo();
            am.getMemoryInfo(mi);
            StatFs fs = new StatFs(dataDir.getPath());
            String soc = Build.VERSION.SDK_INT >= 31 && Build.SOC_MODEL != null && !Build.SOC_MODEL.equals(Build.UNKNOWN)
                ? (Build.SOC_MANUFACTURER + " " + Build.SOC_MODEL).trim() : Build.HARDWARE;
            JSObject r = new JSObject();
            r.put("os", "Android " + Build.VERSION.RELEASE + " (API " + Build.VERSION.SDK_INT + ")");
            r.put("model", (Build.MANUFACTURER + " " + Build.MODEL).trim());
            r.put("cpu", soc);
            r.put("abis", new JSArray(java.util.Arrays.asList(Build.SUPPORTED_ABIS)));
            r.put("cores", Runtime.getRuntime().availableProcessors());
            r.put("ram_mb", mi.totalMem / (1024 * 1024));
            r.put("free_bytes", fs.getAvailableBytes());
            r.put("total_bytes", fs.getTotalBytes());
            r.put("low_ram_device", am.isLowRamDevice());
            r.put("debuggable", (ctx.getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0);
            call.resolve(r);
        });
    }

    /** Estado que cambia mientras se trabaja: batería, temperatura, ahorro de energía y memoria libre. */
    @PluginMethod
    public void deviceStatus(PluginCall call) {
        async(call, () -> {
            Context ctx = getContext();
            JSObject r = new JSObject();
            Intent b = ctx.registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
            if (b != null) {
                int level = b.getIntExtra(BatteryManager.EXTRA_LEVEL, -1), scale = b.getIntExtra(BatteryManager.EXTRA_SCALE, 100);
                int status = b.getIntExtra(BatteryManager.EXTRA_STATUS, -1);
                r.put("battery_pct", level < 0 ? -1 : Math.round(level * 100f / Math.max(1, scale)));
                r.put("charging", status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL);
                r.put("battery_temp_c", b.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, 0) / 10.0);
            }
            PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
            r.put("power_save", pm.isPowerSaveMode());
            r.put("thermal", Build.VERSION.SDK_INT >= 29 ? pm.getCurrentThermalStatus() : -1);
            ActivityManager am = (ActivityManager) ctx.getSystemService(Context.ACTIVITY_SERVICE);
            ActivityManager.MemoryInfo mi = new ActivityManager.MemoryInfo();
            am.getMemoryInfo(mi);
            r.put("ram_free_mb", mi.availMem / (1024 * 1024));
            r.put("low_memory", mi.lowMemory);
            call.resolve(r);
        });
    }

    /** Mantiene la pantalla encendida mientras se procesa (el sistema suspende el trabajo en segundo plano). */
    @PluginMethod
    public void keepAwake(PluginCall call) {
        final boolean on = Boolean.TRUE.equals(call.getBoolean("enabled", false));
        getActivity().runOnUiThread(() -> {
            if (on) getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            else getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            call.resolve();
        });
    }
}
