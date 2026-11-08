/** Utilidades de texto con la misma semántica que Python (para coincidir con el motor de escritorio). */

/** `str.splitlines()` de Python: separa por \n, \r, \r\n, \v, \f, \x1c-\x1e, \x85,   y   y no deja una línea vacía final. */
export function splitLines(text: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const code = text.charCodeAt(i);
    const isSep = ch === '\n' || ch === '\r' || ch === '\v' || ch === '\f' || (code >= 0x1c && code <= 0x1e) || code === 0x85
      || code === 0x2028 || code === 0x2029;
    if (!isSep) { cur += ch; continue; }
    if (ch === '\r' && text[i + 1] === '\n') i++;
    out.push(cur);
    cur = '';
  }
  if (cur) out.push(cur);
  return out;
}

export const codePoints = (s: string): number => Array.from(s).length;
