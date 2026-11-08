// Latencia de modelos de detección con ONNX Runtime Web (WebAssembly, los mismos núcleos que usa la app) en Node, 1 hilo.
// Uso (desde la raíz del repositorio): node tools/bench/detector_latency.mjs <modelo.onnx>:<alto>x<ancho> [...]
// Mide SOLO la inferencia con una entrada aleatoria: no valida precisión de detección.
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ort = require('onnxruntime-web/wasm');
ort.env.wasm.numThreads = Number(process.env.THREADS || 1);
ort.env.logLevel = 'error';
for (const spec of process.argv.slice(2)) {
  const k = spec.lastIndexOf(':'); const file = spec.slice(0, k), dims = spec.slice(k + 1);
  const [h, w] = dims.split('x').map(Number);
  const session = await ort.InferenceSession.create(fs.readFileSync(file), { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  const x = new ort.Tensor('float32', Float32Array.from({ length: 3 * h * w }, () => Math.random()), [1, 3, h, w]);
  const feeds = { [session.inputNames[0]]: x };
  await session.run(feeds); // calentamiento
  const ts = [];
  for (let i = 0; i < Number(process.env.REPEATS || 3); i++) { const t = performance.now(); await session.run(feeds); ts.push(performance.now() - t); }
  console.log(`${file.split(/[\\/]/).pop()} ${w}x${h} hilos=${ort.env.wasm.numThreads}: min ${Math.min(...ts).toFixed(0)} ms, mediana ${ts.sort((a, b) => a - b)[Math.floor(ts.length / 2)].toFixed(0)} ms`);
  await session.release();
}
