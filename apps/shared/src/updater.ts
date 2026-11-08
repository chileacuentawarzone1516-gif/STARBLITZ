/**
 * Piezas puras del actualizador (sin red ni sistema de archivos, probadas en Node): comparar versiones SemVer y
 * validar el manifiesto de actualización. La descarga, la firma Ed25519 del manifiesto y la instalación dependen de decisiones
 * pendientes (repositorio privado, clave de producción): ver docs/DISENO-FASES-5-7.md.
 */

export interface UpdateAsset { platform: 'windows' | 'android'; url: string; size: number; sha256: string; name: string }
export interface UpdateManifest { version: string; notes: string; published: string; prerelease: boolean; assets: UpdateAsset[] }

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseVersion(v: string): { core: [number, number, number]; pre: string[] } | null {
  const m = SEMVER.exec(v.trim());
  if (!m) return null;
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] };
}

/** -1, 0 o 1 según SemVer 2.0 (una versión con prerelease es MENOR que la estable: 1.1.0-rc.1 < 1.1.0). `null` si no es válida. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 | null {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] < y.core[i] ? -1 : 1;
  if (!x.pre.length && !y.pre.length) return 0;
  if (!x.pre.length) return 1;
  if (!y.pre.length) return -1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) < Number(q) ? -1 : 1;
    if (pn !== qn) return pn ? -1 : 1; // los identificadores numéricos van antes que los alfanuméricos
    return p < q ? -1 : 1;
  }
  return 0;
}

/** ¿`candidate` es una actualización de `current`? Los prerelease solo se ofrecen si `allowPrerelease`. */
export function isUpdate(current: string, candidate: string, allowPrerelease = false): boolean {
  const p = parseVersion(candidate);
  if (!p || (p.pre.length && !allowPrerelease)) return false;
  return compareVersions(current, candidate) === -1;
}

const HEX64 = /^[0-9a-f]{64}$/;

/** Valida la forma del manifiesto. Devuelve el manifiesto normalizado o el motivo del rechazo. */
export function parseManifest(raw: unknown): { ok: true; manifest: UpdateManifest } | { ok: false; reason: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'El manifiesto no es un objeto.' };
  const m = raw as Record<string, unknown>;
  if (typeof m.version !== 'string' || !parseVersion(m.version)) return { ok: false, reason: 'Versión no válida.' };
  if (!Array.isArray(m.assets) || !m.assets.length) return { ok: false, reason: 'No hay archivos.' };
  const assets: UpdateAsset[] = [];
  for (const a of m.assets as Record<string, unknown>[]) {
    if (!a || (a.platform !== 'windows' && a.platform !== 'android')) return { ok: false, reason: 'Plataforma desconocida.' };
    if (typeof a.url !== 'string' || !/^https:\/\//.test(a.url)) return { ok: false, reason: 'La URL debe ser HTTPS.' };
    const sha = typeof a.sha256 === 'string' ? a.sha256.toLowerCase() : '';
    if (!HEX64.test(sha)) return { ok: false, reason: 'SHA-256 no válido.' };
    if (typeof a.size !== 'number' || !Number.isFinite(a.size) || a.size <= 0) return { ok: false, reason: 'Tamaño no válido.' };
    assets.push({ platform: a.platform, url: a.url, size: a.size, sha256: sha, name: typeof a.name === 'string' ? a.name : a.url.split('/').pop() ?? '' });
  }
  return {
    ok: true,
    manifest: {
      version: m.version.replace(/^v/, ''), notes: typeof m.notes === 'string' ? m.notes : '',
      published: typeof m.published === 'string' ? m.published : '', prerelease: !!parseVersion(m.version)!.pre.length, assets,
    },
  };
}

/** Compara dos SHA-256 en hexadecimal sin distinguir mayúsculas. */
export function sameDigest(a: string, b: string): boolean {
  return HEX64.test(a.toLowerCase()) && a.toLowerCase() === b.toLowerCase();
}
