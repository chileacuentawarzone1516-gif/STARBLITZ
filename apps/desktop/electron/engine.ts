/**
 * Arranque y supervisión del motor Python de STARBLITZ.
 *
 * - Producción (instalado): usa el Python embebido en resources/engine.
 * - Desarrollo: usa STARBLITZ_PYTHON o el entorno virtual del repositorio.
 * El token de sesión se pasa por variable de entorno (no aparece en la lista
 * de procesos) y el motor anuncia su puerto con la línea STARBLITZ_READY.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export interface EngineInfo {
  url: string;
  port: number;
  token: string;
  version: string;
}

export interface EngineOptions {
  appRoot: string; // carpeta de la app (resources en producción)
  isPackaged: boolean;
  dataDir: string;
  onExit?: (code: number | null) => void;
}

function resolvePython(opts: EngineOptions): { python: string; cwd: string; uiDir: string; llamaDir: string | null } {
  if (opts.isPackaged) {
    const engineDir = path.join(opts.appRoot, 'engine');
    const python = process.platform === 'win32'
      ? path.join(engineDir, 'python', 'python.exe')
      : path.join(engineDir, 'python', 'bin', 'python3');
    return { python, cwd: path.join(engineDir, 'app'), uiDir: path.join(opts.appRoot, 'ui'), llamaDir: path.join(opts.appRoot, 'llama') };
  }
  const repo = path.resolve(opts.appRoot, '..', '..');
  const venv = process.platform === 'win32'
    ? path.join(repo, '.venv', 'Scripts', 'python.exe')
    : path.join(repo, '.venv', 'bin', 'python');
  const devLlama = process.env.STARBLITZ_LLAMA_DIR || path.join(repo, 'tools', 'llama');
  return {
    python: process.env.STARBLITZ_PYTHON || (existsSync(venv) ? venv : 'python'),
    cwd: path.join(repo, 'engine'),
    uiDir: path.join(opts.appRoot, 'dist'),
    llamaDir: existsSync(devLlama) ? devLlama : null,
  };
}

export class EngineProcess {
  private child: ChildProcess | null = null;
  private stopping = false;
  info: EngineInfo | null = null;

  constructor(private opts: EngineOptions) {}

  start(timeoutMs = 90_000): Promise<EngineInfo> {
    const { python, cwd, uiDir, llamaDir } = resolvePython(this.opts);
    const token = randomBytes(32).toString('base64url');
    mkdirSync(path.join(this.opts.dataDir, 'logs'), { recursive: true });
    const log = createWriteStream(path.join(this.opts.dataDir, 'logs', 'engine-console.log'), { flags: 'a' });
    // El motor escucha solo en 127.0.0.1 y en un puerto libre: nada de esta app es accesible desde la red.
    const args = ['-m', 'starblitz_engine', '--port', '0', '--data-dir', this.opts.dataDir, '--ui-dir', uiDir];
    if (llamaDir && existsSync(llamaDir)) args.push('--llama-dir', llamaDir);
    this.stopping = false;
    const child = spawn(python, args, {
      cwd,
      env: {
        ...process.env,
        STARBLITZ_TOKEN: token,
        PYTHONUTF8: '1',
        PYTHONDONTWRITEBYTECODE: '1',
        PYTHONNOUSERSITE: '1',
        PYTHONPATH: cwd,
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    child.stderr?.pipe(log);

    return new Promise((resolve, reject) => {
      let buffer = '';
      const timer = setTimeout(() => {
        reject(new Error('El motor no respondió a tiempo. Revisa el registro en la carpeta de datos.'));
        this.stop();
      }, timeoutMs);
      child.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        log.write(text);
        buffer += text;
        const match = buffer.match(/STARBLITZ_READY (\{.*\})/);
        if (match && !this.info) {
          clearTimeout(timer);
          const data = JSON.parse(match[1]) as { port: number; version: string };
          this.info = { url: `http://127.0.0.1:${data.port}`, port: data.port, token, version: data.version };
          resolve(this.info);
        }
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`No se pudo iniciar el motor (${err.message}).`));
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        log.end();
        const wasReady = !!this.info;
        this.info = null;
        this.child = null;
        if (!wasReady) reject(new Error(`El motor se cerró al arrancar (código ${code}). Revisa engine-console.log.`));
        else if (!this.stopping) this.opts.onExit?.(code);
      });
    });
  }

  stop(): Promise<void> {
    const child = this.child;
    if (!child) return Promise.resolve();
    this.stopping = true;
    return new Promise((resolve) => {
      const done = () => resolve();
      child.once('exit', done);
      if (process.platform === 'win32' && child.pid) {
        // Cierra el árbol completo de procesos (descargas o subprocesos de Python incluidos).
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      } else {
        child.kill('SIGTERM');
      }
      setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 5000);
    });
  }
}
