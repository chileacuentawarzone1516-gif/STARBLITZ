// Compila el proceso principal y el preload de Electron con esbuild.
import { build } from 'esbuild';

const common = { bundle: true, platform: 'node', target: 'node20', format: 'cjs', external: ['electron'], sourcemap: false, minify: true };

await build({ ...common, entryPoints: ['electron/main.ts'], outfile: 'dist-electron/main.cjs' });
await build({ ...common, entryPoints: ['electron/preload.ts'], outfile: 'dist-electron/preload.cjs' });
console.log('Electron compilado en dist-electron/');
