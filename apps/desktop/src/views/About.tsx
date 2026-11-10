import { useApp } from '../store';

const CREDITS = [
  ['comic-text-detector', 'Detección de texto y globos', 'GPL-3.0'],
  ['PP-OCRv6 Manga (experimental, opcional)', 'Detección de líneas de texto', 'Apache-2.0'],
  ['Manga OCR (kha-white)', 'OCR japonés especializado', 'Apache-2.0'],
  ['PaddleOCR PP-OCR vía RapidOCR', 'OCR multilingüe', 'Apache-2.0'],
  ['LaMa (Samsung AI)', 'Reconstrucción de fondos', 'Apache-2.0'],
  ['Ollama', 'Ejecución local de modelos de lenguaje', 'MIT'],
  ['Qwen 3.5 / Gemma 4', 'Modelos de lenguaje de traducción', 'Apache-2.0'],
  ['ONNX Runtime', 'Inferencia en GPU (DirectML) y CPU', 'MIT'],
  ['Shantell Sans, Comic Neue, Bangers, Patrick Hand, Barlow, Sora, Manrope', 'Tipografías', 'SIL OFL 1.1'],
];

export function About() {
  const system = useApp((s) => s.system);
  return (
    <div className="page about">
      <img src="./splash.svg" alt="STARBLITZ" className="about-art" />
      <p className="lead">Versión {system?.version ?? '—'}. Todo el procesamiento ocurre en tu equipo: sin cuentas, sin suscripciones y sin enviar tus archivos a ningún servidor.</p>
      <h2>Componentes de código abierto</h2>
      <div className="table table-3 credits" role="table">
        <div className="tr th" role="row"><span>Proyecto</span><span>Uso</span><span>Licencia</span></div>
        {CREDITS.map(([name, use, lic]) => (
          <div className="tr" role="row" key={name}><span>{name}</span><span className="muted">{use}</span><span className="mono small">{lic}</span></div>
        ))}
      </div>
    </div>
  );
}
