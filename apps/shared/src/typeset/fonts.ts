/**
 * Tipografías de rotulación (todas con licencia SIL OFL, incluidas en la app).
 * Se cargan con la API FontFace para que el lienzo pinte exactamente igual en
 * escritorio y en Android.
 */
import type { FontRole, TextStyle } from '../types';
import comicNeue400 from '../assets/fonts/comic-neue-latin-400-normal.woff2?url';
import comicNeue400i from '../assets/fonts/comic-neue-latin-400-italic.woff2?url';
import comicNeue700 from '../assets/fonts/comic-neue-latin-700-normal.woff2?url';
import comicNeue700i from '../assets/fonts/comic-neue-latin-700-italic.woff2?url';
import shantell500 from '../assets/fonts/shantell-sans-latin-500-normal.woff2?url';
import shantell500i from '../assets/fonts/shantell-sans-latin-500-italic.woff2?url';
import shantell700 from '../assets/fonts/shantell-sans-latin-700-normal.woff2?url';
import shantell700i from '../assets/fonts/shantell-sans-latin-700-italic.woff2?url';
import bangers from '../assets/fonts/bangers-latin-400-normal.woff2?url';
import patrick from '../assets/fonts/patrick-hand-latin-400-normal.woff2?url';
import barlow500 from '../assets/fonts/barlow-semi-condensed-latin-500-normal.woff2?url';
import barlow500i from '../assets/fonts/barlow-semi-condensed-latin-500-italic.woff2?url';
import barlow700 from '../assets/fonts/barlow-semi-condensed-latin-700-normal.woff2?url';
import barlow700i from '../assets/fonts/barlow-semi-condensed-latin-700-italic.woff2?url';

interface FaceDef { family: string; url: string; weight: string; style: 'normal' | 'italic' }

const FACES: FaceDef[] = [
  { family: 'SB Dialogue', url: shantell500, weight: '500', style: 'normal' },
  { family: 'SB Dialogue', url: shantell500i, weight: '500', style: 'italic' },
  { family: 'SB Dialogue', url: shantell700, weight: '700', style: 'normal' },
  { family: 'SB Dialogue', url: shantell700i, weight: '700', style: 'italic' },
  { family: 'SB Classic', url: comicNeue400, weight: '500', style: 'normal' },
  { family: 'SB Classic', url: comicNeue400i, weight: '500', style: 'italic' },
  { family: 'SB Classic', url: comicNeue700, weight: '700', style: 'normal' },
  { family: 'SB Classic', url: comicNeue700i, weight: '700', style: 'italic' },
  { family: 'SB Narration', url: barlow500, weight: '500', style: 'normal' },
  { family: 'SB Narration', url: barlow500i, weight: '500', style: 'italic' },
  { family: 'SB Narration', url: barlow700, weight: '700', style: 'normal' },
  { family: 'SB Narration', url: barlow700i, weight: '700', style: 'italic' },
  { family: 'SB Shout', url: bangers, weight: '500', style: 'normal' },
  { family: 'SB Shout', url: bangers, weight: '700', style: 'normal' },
  { family: 'SB Hand', url: patrick, weight: '500', style: 'normal' },
  { family: 'SB Hand', url: patrick, weight: '700', style: 'normal' },
];

export const FONT_ROLES: Record<FontRole, { family: string; label: string; scale: number }> = {
  dialogue: { family: 'SB Dialogue', label: 'Diálogo', scale: 1 },
  narration: { family: 'SB Narration', label: 'Narración', scale: 1.05 },
  shout: { family: 'SB Shout', label: 'Grito', scale: 1.15 },
  whisper: { family: 'SB Classic', label: 'Susurro', scale: 0.95 },
  handwritten: { family: 'SB Hand', label: 'Manuscrito', scale: 1.1 },
  sfx: { family: 'SB Shout', label: 'Onomatopeya', scale: 1.2 },
};

let loading: Promise<void> | null = null;

export function loadLetteringFonts(): Promise<void> {
  if (loading) return loading;
  loading = (async () => {
    const faces = FACES.map((f) => new FontFace(f.family, `url(${f.url})`, { weight: f.weight, style: f.style }));
    await Promise.all(faces.map(async (face) => {
      try {
        const loaded = await face.load();
        document.fonts.add(loaded);
      } catch {
        // Si una variante falla el navegador usará la siguiente fuente de la pila.
      }
    }));
  })();
  return loading;
}

export function cssFont(style: TextStyle, size: number): string {
  const role = FONT_ROLES[style.font] ?? FONT_ROLES.dialogue;
  const weight = style.bold ? 700 : 500;
  return `${style.italic ? 'italic ' : ''}${weight} ${size.toFixed(2)}px "${role.family}", "Comic Neue", "Segoe UI", sans-serif`;
}
