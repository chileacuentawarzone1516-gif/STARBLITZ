/** Orden «natural» de nombres de archivo (pagina2 antes que pagina10), igual que `natural_key` de Python. */
export function naturalCompare(a: string, b: string): number {
  const ta = a.split(/(\d+)/), tb = b.split(/(\d+)/);
  for (let i = 0; i < Math.min(ta.length, tb.length); i++) {
    const x = ta[i], y = tb[i];
    if (i % 2 === 1) { // trozos numéricos: se comparan como números (sin límite de dígitos)
      const nx = x.replace(/^0+(?=\d)/, ''), ny = y.replace(/^0+(?=\d)/, '');
      if (nx.length !== ny.length) return nx.length - ny.length;
      if (nx !== ny) return nx < ny ? -1 : 1;
    } else {
      const lx = x.toLowerCase(), ly = y.toLowerCase();
      if (lx !== ly) return lx < ly ? -1 : 1;
    }
  }
  return ta.length - tb.length;
}
