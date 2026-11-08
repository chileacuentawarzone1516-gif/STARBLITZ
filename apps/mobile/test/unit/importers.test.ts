/** Importación de ZIP/CBZ, PDF e imágenes: orden, seguridad, duplicados y límites. */
import { describe, expect, it } from 'vitest';
import { zipSync } from 'fflate';
import { dhashFromGray, hamming, jpegOrientation, peekDimensions, sniff } from '../../src/engine/importers/formats';
import { ImportProblem, ingest, type ImageCodec, type ImportedImage, type PdfOpener, type Upload } from '../../src/engine/importers/ingest';
import { naturalCompare } from '../../src/engine/importers/sort';
import { bytesSource, listZip, readZipEntry } from '../../src/engine/importers/zip';

const enc = new TextEncoder();
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** «Imagen» de pruebas: firma PNG + «ancho x alto : huella : semilla». */
const fakeImage = (w: number, h: number, hash: string, seed = '') => new Uint8Array([...PNG_SIG, ...enc.encode(`${w}x${h}:${hash}:${seed}`)]);

const codec: ImageCodec = {
  async load(_name, data) {
    const m = /^(\d+)x(\d+):([0-9a-f]{16}):/.exec(new TextDecoder().decode(data.subarray(8)));
    if (!m) throw new ImportProblem('la imagen está dañada o incompleta');
    return { data, ext: 'png', width: Number(m[1]), height: Number(m[2]), dhash: m[3] };
  },
};

const H = (n: number) => n.toString(16).padStart(16, '0');
const upload = (name: string, data: Uint8Array): Upload => ({ name, source: bytesSource(data) });

function collector() {
  const added: ImportedImage[] = [];
  let n = 0;
  return { added, add: async (img: ImportedImage) => { added.push(img); return `g${++n}`; } };
}

describe('importación de archivos', () => {
  it('lee un CBZ en orden natural, ignorando basura de sistema y avisando de lo que no se puede usar', async () => {
    const zip = zipSync({
      'cap/pagina10.png': fakeImage(100, 200, H(1), 'a'), 'cap/pagina2.png': fakeImage(100, 200, H(0xffff0000ffff), 'b'),
      'cap/pagina1.PNG': fakeImage(100, 200, H(0x0f0f0f0f0f0f0f0f), 'c'), '__MACOSX/cap/._pagina1.png': enc.encode('basura'),
      'cap/.oculto.png': enc.encode('x'), 'cap/info.txt': enc.encode('créditos'), 'cap/video.mp4': enc.encode('no'),
      'cap/': new Uint8Array(0),
    });
    const c = collector();
    const report = await ingest([upload('obra.cbz', zip)], [], 100, { codec, add: c.add });
    expect(c.added.map((i) => i.name)).toEqual(['pagina1.PNG', 'pagina2.png', 'pagina10.png']);
    expect(report.errors).toEqual([{ file: 'video.mp4', reason: 'formato no admitido dentro del ZIP' }]);
    expect(report.added).toHaveLength(3);
  });

  it('rechaza rutas con «..», archivos cifrados y bombas de compresión', async () => {
    const zip = zipSync({ '../../fuera.png': fakeImage(10, 10, H(2)), 'ok.png': fakeImage(10, 10, H(3)), 'bomba.png': new Uint8Array(4 * 1024 * 1024) });
    const c = collector();
    const report = await ingest([upload('x.zip', zip)], [], 100, { codec, add: c.add });
    expect(c.added.map((i) => i.name)).toEqual(['ok.png']);
    const reasons = Object.fromEntries(report.errors.map((e) => [e.file, e.reason]));
    expect(reasons['fuera.png']).toBe('ruta no permitida dentro del ZIP');
    expect(reasons['bomba.png']).toBe('archivo sospechoso o demasiado grande');

    // Archivo cifrado: el bit 0 de las banderas del directorio central
    const enc1 = zipSync({ 'secreto.png': fakeImage(10, 10, H(4)) });
    const dv = new DataView(enc1.buffer, enc1.byteOffset);
    for (let i = 0; i < enc1.length - 4; i++) if (dv.getUint32(i, true) === 0x02014b50) dv.setUint16(i + 8, dv.getUint16(i + 8, true) | 1, true);
    const r2 = await ingest([upload('c.zip', enc1)], [], 100, { codec, add: c.add });
    expect(r2.errors).toEqual([{ file: 'secreto.png', reason: 'archivo cifrado con contraseña' }]);
  });

  it('limita el número de entradas y detecta ZIP dañados', async () => {
    const many: Record<string, Uint8Array> = {};
    for (let i = 0; i < 5001; i++) many[`p${i}.png`] = new Uint8Array(0);
    const r1 = await ingest([upload('muchos.zip', zipSync(many))], [], 10, { codec, add: collector().add });
    expect(r1.errors).toEqual([{ file: 'muchos.zip', reason: 'el ZIP contiene demasiados archivos' }]);
    const good = zipSync({ 'a.png': fakeImage(10, 10, H(5)) });
    const r2 = await ingest([upload('roto.zip', good.slice(0, good.length - 30))], [], 10, { codec, add: collector().add });
    expect(r2.errors).toEqual([{ file: 'roto.zip', reason: 'el ZIP está dañado' }]);
    const r3 = await ingest([upload('vacio.zip', new Uint8Array([0x50, 0x4b, 5, 6]))], [], 10, { codec, add: collector().add });
    expect(r3.errors[0].reason).toBe('el ZIP está dañado');
  });

  it('lee los datos de una entrada sin cargar el resto (stored y deflate)', async () => {
    const zip = zipSync({ 'a.png': [fakeImage(1, 1, H(6), 'x'), { level: 0 }], 'b.png': [fakeImage(2, 2, H(7), 'y'.repeat(500)), { level: 9 }] });
    const src = bytesSource(zip);
    const entries = await listZip(src);
    expect(entries.map((e) => [e.name, e.method])).toEqual([['a.png', 0], ['b.png', 8]]);
    expect(await readZipEntry(src, entries[1])).toEqual(fakeImage(2, 2, H(7), 'y'.repeat(500)));
  });

  it('detecta duplicados exactos y casi iguales, y respeta la capacidad del proyecto', async () => {
    const a = fakeImage(100, 100, H(0), 'a'), aCopy = fakeImage(100, 100, H(0), 'a'), aNear = fakeImage(100, 100, H(0b111), 'otra');
    const b = fakeImage(100, 100, H(0xffffffffffff), 'b'), c2 = fakeImage(100, 100, H(0xf0f0f0f0), 'c');
    const c = collector();
    const existing = [{ id: 'g0', sha1: 'no-coincide', dhash: H(0xaaaa00000000) }];
    const nears: (string | null)[] = [];
    const report = await ingest(
      [upload('1.png', a), upload('2.png', aCopy), upload('3.png', aNear), upload('4.png', b), upload('5.png', c2)], existing, 3,
      { codec, add: async (img, near) => { nears.push(near); return (await c.add(img)); } });
    expect(report.added).toEqual(['g1', 'g2', 'g3']);                      // 1.png, 3.png y 4.png
    expect(report.duplicates).toEqual([
      { file: '2.png', of: 'g1', exact: true },                              // idéntica a la primera
      { file: '3.png', of: 'g1', exact: false, page_id: 'g2' },              // huella a 3 bits: se añade avisando
    ]);
    expect(nears).toEqual([null, 'g1', null]);
    expect(report.skipped_limit).toBe(1);                                    // 5.png no cabe
  });

  it('informa de archivos no admitidos o dañados sin detener la importación', async () => {
    const c = collector();
    const report = await ingest([
      upload('nota.txt', enc.encode('hola')), upload('rota.png', new Uint8Array([...PNG_SIG, 1, 2, 3])), upload('buena.png', fakeImage(50, 80, H(9), 'z')),
    ], [], 10, { codec, add: c.add });
    expect(report.errors).toEqual([
      { file: 'nota.txt', reason: 'formato no admitido (usa ZIP, CBZ, PDF, JPG, PNG o WEBP)' },
      { file: 'rota.png', reason: 'la imagen está dañada o incompleta' },
    ]);
    expect(c.added.map((i) => [i.name, i.width, i.height, i.ext])).toEqual([['buena.png', 50, 80, 'png']]);
    expect(c.added[0].sha1).toMatch(/^[0-9a-f]{40}$/);
  });

  it('importa un PDF página a página y avisa si no se puede abrir', async () => {
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);
    let destroyed = false;
    const opener: PdfOpener = async () => ({
      numPages: 3,
      async render(i) { if (i === 1) throw new Error('rota'); return fakeImage(300, 400, H(10 + i), 'pdf' + i); },
      async destroy() { destroyed = true; },
    });
    const c = collector();
    const report = await ingest([upload('tomo.pdf', pdf)], [], 10, { codec, pdf: opener, add: c.add });
    expect(c.added.map((i) => i.name)).toEqual(['tomo.pdf · página 1', 'tomo.pdf · página 3']);
    expect(report.errors).toEqual([{ file: 'tomo.pdf · página 2', reason: 'no se pudo extraer la página' }]);
    expect(destroyed).toBe(true);
    const bad = await ingest([upload('x.pdf', pdf)], [], 10, { codec, pdf: async () => { throw new Error('clave'); }, add: c.add });
    expect(bad.errors).toEqual([{ file: 'x.pdf', reason: 'el PDF está dañado o protegido con contraseña' }]);
  });

  it('permite cancelar entre archivos y avisa del progreso', async () => {
    const c = collector();
    const progress: [number, string][] = [];
    let seen = 0;
    const ctl = new AbortController();
    const run = ingest([upload('1.png', fakeImage(9, 9, H(21), 'a')), upload('2.png', fakeImage(9, 9, H(0xfff000000), 'b')), upload('3.png', fakeImage(9, 9, H(0xaaaa5555aaaa), 'c'))], [], 10, {
      codec, add: c.add, progress: (f, m) => progress.push([f, m]),
      check: async () => { if (++seen > 1) { ctl.abort(); throw new Error('cancelado'); } },
    });
    await expect(run).rejects.toThrow('cancelado');
    expect(c.added).toHaveLength(1);
    expect(progress[0]).toEqual([0, 'Importando 1.png']);
  });
});

describe('formatos y utilidades', () => {
  it('reconoce el tipo por la firma', () => {
    expect(sniff(new Uint8Array([0x50, 0x4b, 3, 4, 0]))).toBe('zip');
    expect(sniff(enc.encode('%PDF-1.7'))).toBe('pdf');
    expect(sniff(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpg');
    expect(sniff(new Uint8Array(PNG_SIG))).toBe('png');
    expect(sniff(enc.encode('RIFF\0\0\0\0WEBPVP8 '))).toBe('webp');
    expect(sniff(enc.encode('GIF89a'))).toBeNull();
  });

  it('lee las dimensiones sin decodificar (PNG, JPEG, WebP) para frenar bombas de descompresión', () => {
    const png = new Uint8Array(33);
    png.set(PNG_SIG); png.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8); png.set([0, 0, 0x1e, 0x00, 0, 0, 0x2d, 0x00], 16); // 7680 × 11520
    expect(peekDimensions(png, 'png')).toEqual({ width: 7680, height: 11520 });
    const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0x03, 0xe8, 0x02, 0x58, 3, 1, 0x22, 0, 0, 0, 0, 0]);
    expect(peekDimensions(jpg, 'jpg')).toEqual({ width: 600, height: 1000 });
    const webp = new Uint8Array(40);
    webp.set(enc.encode('RIFF')); webp.set(enc.encode('WEBPVP8X'), 8); webp.set([0x1f, 0x03, 0, 0xe7, 0x03, 0], 24); // 800 × 1000
    expect(peekDimensions(webp, 'webp')).toEqual({ width: 800, height: 1000 });
    expect(peekDimensions(new Uint8Array(10), 'png')).toBeNull();
  });

  it('lee la orientación EXIF de un JPEG', () => {
    const exif = (order: number) => new Uint8Array([
      0xff, 0xd8, 0xff, 0xe1, 0, 30, 0x45, 0x78, 0x69, 0x66, 0, 0, 0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, order, 0, 0, 0, 0, 0, 0xff, 0xda,
    ]);
    expect(jpegOrientation(exif(6))).toBe(6);
    expect(jpegOrientation(exif(1))).toBe(1);
    expect(jpegOrientation(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2]))).toBe(1);
  });

  it('huellas perceptuales: distancia de Hamming y dhash', () => {
    expect(hamming(H(0), H(0b1011))).toBe(3);
    expect(hamming('ffffffffffffffff', H(0))).toBe(64);
    const ramp = Array.from({ length: 72 }, (_, i) => (i % 9) * 10);   // cada fila crece de izquierda a derecha
    expect(dhashFromGray(ramp)).toBe('ffffffffffffffff');
    expect(dhashFromGray(ramp.map((v) => 80 - v))).toBe(H(0));
    expect(dhashFromGray(Array.from({ length: 72 }, (_, i) => 100 + (i % 3)))).toBe(H(0)); // ruido de JPEG en zona lisa: sin bits
  });

  it('orden natural de nombres', () => {
    const names = ['p10.png', 'p2.png', 'P1.png', 'p02b.png', 'a.png', '10.png', '9.png'];
    expect([...names].sort(naturalCompare)).toEqual(['9.png', '10.png', 'a.png', 'P1.png', 'p2.png', 'p02b.png', 'p10.png']);
    expect(naturalCompare('x1', 'x1')).toBe(0);
    expect(naturalCompare('x1', 'x1a')).toBeLessThan(0);
  });
});
