/**
 * Proceso principal de STARBLITZ Desktop.
 *
 * Seguridad: aislamiento de contexto, sandbox, sin integración de Node en la
 * interfaz, navegación limitada al motor local y apertura de enlaces externos
 * solo hacia dominios conocidos.
 */
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, session, shell } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { EngineProcess, type EngineInfo } from './engine';

const EXTERNAL_ALLOW = ['ollama.com', 'github.com', 'huggingface.co', 'lmstudio.ai'];

let mainWindow: BrowserWindow | null = null;
let splash: BrowserWindow | null = null;
let engine: EngineProcess | null = null;

const appRoot = app.isPackaged ? process.resourcesPath : path.resolve(__dirname, '..');

function dataDir(): string {
  // Modo portátil: si existe «portable.txt» junto al ejecutable, los datos viven a su lado.
  const exeDir = path.dirname(app.getPath('exe'));
  if (app.isPackaged && existsSync(path.join(exeDir, 'portable.txt'))) return path.join(exeDir, 'data');
  if (process.env.STARBLITZ_DATA_DIR) return process.env.STARBLITZ_DATA_DIR;
  return path.join(app.getPath('appData'), 'STARBLITZ');
}

interface Prefs { bounds?: Electron.Rectangle; maximized?: boolean }

function prefsPath() { return path.join(dataDir(), 'desktop.json'); }
function readPrefs(): Prefs {
  try { return JSON.parse(readFileSync(prefsPath(), 'utf8')) as Prefs; } catch { return {}; }
}
function writePrefs(p: Prefs) {
  mkdirSync(dataDir(), { recursive: true });
  writeFileSync(prefsPath(), JSON.stringify(p, null, 1));
}

function createSplash() {
  splash = new BrowserWindow({
    width: 440, height: 420, frame: false, resizable: false, show: false, backgroundColor: '#060818',
    icon: path.join(appRoot, app.isPackaged ? 'ui' : 'public', 'icon-256.png'),
    webPreferences: { sandbox: true, contextIsolation: true },
  });
  let svg = '';
  try { svg = readFileSync(path.join(appRoot, app.isPackaged ? 'ui' : 'public', 'splash.svg'), 'utf8'); } catch { /* sin logo */ }
  const html = `<!doctype html><meta charset="utf-8"><style>
    html,body{margin:0;height:100%;background:#060818;color:#a5b4fc;font:13px "Segoe UI",sans-serif;overflow:hidden}
    svg{width:100%;height:auto;display:block}
    p{position:absolute;bottom:22px;width:100%;text-align:center;margin:0;letter-spacing:.02em}
    i{position:absolute;bottom:0;left:0;height:3px;width:30%;background:linear-gradient(90deg,#38bdf8,#3b6cff,#a855f7);animation:m 1.4s ease-in-out infinite}
    @keyframes m{from{transform:translateX(-100%)}to{transform:translateX(340%)}}</style>
    ${svg}<p id="s">Iniciando el motor local…</p><i></i>`;
  splash.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  splash.once('ready-to-show', () => splash?.show());
}

function createMainWindow(info: EngineInfo) {
  const prefs = readPrefs();
  mainWindow = new BrowserWindow({
    width: prefs.bounds?.width ?? 1440,
    height: prefs.bounds?.height ?? 900,
    x: prefs.bounds?.x,
    y: prefs.bounds?.y,
    minWidth: 1100,
    minHeight: 680,
    show: false,
    backgroundColor: '#060818',
    title: 'STARBLITZ',
    icon: path.join(appRoot, app.isPackaged ? 'ui' : 'public', 'icon-256.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#060818', symbolColor: '#c3c8f0', height: 40 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: true,
    },
  });
  if (prefs.maximized) mainWindow.maximize();
  mainWindow.webContents.session.setSpellCheckerLanguages(['es-ES', 'es']);

  const devUrl = process.env.STARBLITZ_DEV_URL;
  mainWindow.loadURL(devUrl || `${info.url}/`);

  const allowedOrigins = new Set([new URL(info.url).origin, ...(devUrl ? [new URL(devUrl).origin] : [])]);
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!allowedOrigins.has(new URL(url).origin)) event.preventDefault();
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafe(url);
    return { action: 'deny' };
  });
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    splash?.close();
    splash = null;
  });
  const saveBounds = () => {
    if (!mainWindow) return;
    writePrefs({ ...readPrefs(), bounds: mainWindow.getNormalBounds(), maximized: mainWindow.isMaximized() });
  };
  // Antes la ventana se cerraba sin dejar a la interfaz guardar las ediciones diferidas (450 ms): la última se perdía.
  // Ahora se pide a la interfaz que guarde y se cierra al confirmar (o a los 5 s si no responde).
  let closeReady = false;
  let closing = false;
  mainWindow.on('close', (event) => {
    saveBounds();
    if (closeReady || !mainWindow) return;
    event.preventDefault();
    if (closing) return;
    closing = true;
    const finish = () => { closeReady = true; ipcMain.removeAllListeners('app:flushed'); mainWindow?.close(); };
    const timer = setTimeout(finish, 5000);
    ipcMain.once('app:flushed', () => { clearTimeout(timer); finish(); });
    mainWindow.webContents.send('app:flush-before-close');
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

function openExternalSafe(url: string) {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:' && EXTERNAL_ALLOW.some((d) => u.hostname === d || u.hostname.endsWith(`.${d}`))) {
      shell.openExternal(u.toString());
    }
  } catch { /* URL no válida: se ignora */ }
}

function registerIpc() {
  ipcMain.handle('engine:info', () => engine?.info ?? null);
  ipcMain.handle('app:info', () => ({ version: app.getVersion(), dataDir: dataDir(), platform: process.platform }));
  ipcMain.handle('shell:openExternal', (_e, url: string) => openExternalSafe(url));
  ipcMain.handle('shell:openDataDir', (_e, sub?: string) => {
    const target = path.join(dataDir(), sub === 'logs' ? 'logs' : '');
    return shell.openPath(target);
  });
  ipcMain.handle('files:save', async (_e, files: { name: string; data: ArrayBuffer }[], kind: string) => {
    if (!mainWindow || !files.length) return { saved: [] };
    if (files.length === 1) {
      const ext = path.extname(files[0].name).slice(1).toLowerCase();
      const res = await dialog.showSaveDialog(mainWindow, {
        title: 'Guardar exportación',
        defaultPath: path.join(app.getPath('documents'), files[0].name),
        filters: [{ name: kind || ext.toUpperCase(), extensions: [ext] }],
      });
      if (res.canceled || !res.filePath) return { saved: [] };
      await writeFile(res.filePath, Buffer.from(files[0].data));
      shell.showItemInFolder(res.filePath);
      return { saved: [res.filePath] };
    }
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Elige la carpeta donde guardar las imágenes',
      defaultPath: app.getPath('documents'),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || !res.filePaths[0]) return { saved: [] };
    const saved: string[] = [];
    for (const f of files) {
      const target = path.join(res.filePaths[0], path.basename(f.name));
      await writeFile(target, Buffer.from(f.data));
      saved.push(target);
    }
    shell.openPath(res.filePaths[0]);
    return { saved };
  });
}

async function boot() {
  nativeTheme.themeSource = 'dark';
  Menu.setApplicationMenu(null);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'clipboard-sanitized-write'));
  registerIpc();
  createSplash();
  engine = new EngineProcess({
    appRoot: app.isPackaged ? process.resourcesPath : appRoot,
    isPackaged: app.isPackaged,
    dataDir: dataDir(),
    onExit: async (code) => {
      // Antes un reinicio fallido quedaba como promesa rechazada sin tratar: sin aviso y con la ventana colgada.
      let detail = `Código de salida: ${code}. Tus proyectos están guardados. ¿Quieres reiniciarlo?`;
      for (;;) {
        const choice = await dialog.showMessageBox({
          type: 'error', title: 'STARBLITZ',
          message: 'El motor local se ha detenido inesperadamente.',
          detail, buttons: ['Reiniciar motor', 'Cerrar STARBLITZ'], defaultId: 0,
        });
        if (choice.response !== 0) { app.quit(); return; }
        try {
          const info = await engine!.start();
          mainWindow?.loadURL(`${process.env.STARBLITZ_DEV_URL || info.url}/`);
          return;
        } catch (err) {
          detail = `No se pudo reiniciar el motor: ${(err as Error).message}\n\nTus proyectos están guardados. ¿Intentarlo de nuevo?`;
        }
      }
    },
  });
  try {
    const info = await engine.start();
    createMainWindow(info);
  } catch (err) {
    splash?.close();
    dialog.showErrorBox('STARBLITZ no pudo iniciarse', (err as Error).message);
    app.quit();
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.whenReady().then(boot);
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => { engine?.stop(); });
}
