// Servidor estático mínimo con COOP/COEP (como el WebView de la app) para las pruebas en Chromium.
// Uso: [TLS=1 CERT_DIR=<carpeta con key.pem y cert.pem>] [DATA_DIR=<carpeta servida en /__data/>] [NO_ISOLATION=1] node serve.mjs <carpeta_web> <puerto>
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
const root = process.argv[2];
const port = Number(process.argv[3] || 5199);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.onnx': 'application/octet-stream', '.json': 'application/json', '.txt': 'text/plain', '.md': 'text/plain' };
const make = process.env.TLS ? (h) => https.createServer({ key: fs.readFileSync(path.join(process.env.CERT_DIR ?? '.', 'key.pem')), cert: fs.readFileSync(path.join(process.env.CERT_DIR ?? '.', 'cert.pem')) }, h) : (h) => http.createServer(h);
make((req, res) => {
  const url = new URL(req.url, 'http://x');
  const data = process.env.DATA_DIR;
  let p = data && url.pathname.startsWith('/__data/') ? path.join(data, decodeURIComponent(url.pathname.slice(8))) : path.join(root, decodeURIComponent(url.pathname));
  if (!p.startsWith(root) && !(data && p.startsWith(data))) { res.writeHead(403).end(); return; }
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
  if (!fs.existsSync(p)) { res.writeHead(404).end('no'); return; }
  const size = fs.statSync(p).size;
  const headers = {
    'Content-Type': types[path.extname(p)] || 'application/octet-stream',
    ...(process.env.NO_ISOLATION ? {} : { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' }), 'Cross-Origin-Resource-Policy': 'cross-origin', 'Access-Control-Allow-Origin': '*', 'Accept-Ranges': 'bytes',
  };
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  if (m) {
    const a = Number(m[1]); const b = m[2] ? Number(m[2]) : size - 1;
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${a}-${b}/${size}`, 'Content-Length': b - a + 1 });
    fs.createReadStream(p, { start: a, end: b }).pipe(res);
  } else {
    res.writeHead(200, { ...headers, 'Content-Length': size });
    fs.createReadStream(p).pipe(res);
  }
}).listen(port, '127.0.0.1', () => console.log('listo', port));
