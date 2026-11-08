import { describe, expect, it } from 'vitest';
import { compareVersions, isUpdate, parseManifest, parseVersion, sameDigest } from '../src/updater';

const SHA = 'a'.repeat(64);
const asset = (extra = {}) => ({ platform: 'windows', url: 'https://example.org/STARBLITZ-Setup-1.1.0.exe', size: 1000, sha256: SHA, ...extra });

describe('versiones SemVer', () => {
  it('ordena estables, parches y mayores', () => {
    expect(compareVersions('1.0.0', '1.0.1')).toBe(-1);
    expect(compareVersions('1.2.0', '1.10.0')).toBe(-1);
    expect(compareVersions('2.0.0', '1.99.99')).toBe(1);
    expect(compareVersions('v1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.0.0+build5', '1.0.0')).toBe(0);
  });
  it('un prerelease es menor que su versión estable y se ordena como SemVer 2.0', () => {
    expect(compareVersions('1.1.0-rc.1', '1.1.0')).toBe(-1);
    expect(compareVersions('1.1.0', '1.1.0-rc.1')).toBe(1);
    expect(compareVersions('1.1.0-rc.2', '1.1.0-rc.10')).toBe(-1);
    expect(compareVersions('1.1.0-alpha', '1.1.0-alpha.1')).toBe(-1);
    expect(compareVersions('1.1.0-1', '1.1.0-alpha')).toBe(-1); // numérico antes que alfanumérico
  });
  it('rechaza versiones inválidas', () => {
    expect(parseVersion('1.0')).toBeNull();
    expect(parseVersion('abc')).toBeNull();
    expect(compareVersions('1.0', '1.0.0')).toBeNull();
  });
  it('solo ofrece prerelease si se permite', () => {
    expect(isUpdate('1.0.0', '1.1.0')).toBe(true);
    expect(isUpdate('1.0.0', '1.1.0-rc.1')).toBe(false);
    expect(isUpdate('1.0.0', '1.1.0-rc.1', true)).toBe(true);
    expect(isUpdate('1.1.0', '1.1.0')).toBe(false);
    expect(isUpdate('1.1.0', '1.0.9')).toBe(false);
    expect(isUpdate('1.0.0', 'basura')).toBe(false);
  });
});

describe('manifiesto de actualización', () => {
  it('acepta un manifiesto correcto y lo normaliza', () => {
    const r = parseManifest({ version: 'v1.1.0', notes: 'Novedades', assets: [asset({ sha256: SHA.toUpperCase() })] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.manifest.version).toBe('1.1.0');
      expect(r.manifest.assets[0].sha256).toBe(SHA);
      expect(r.manifest.assets[0].name).toBe('STARBLITZ-Setup-1.1.0.exe');
      expect(r.manifest.prerelease).toBe(false);
    }
  });
  it('rechaza HTTP, huellas malas, tamaños inválidos, plataformas desconocidas y manifiestos vacíos', () => {
    const bad = (m: unknown) => parseManifest(m).ok;
    expect(bad(null)).toBe(false);
    expect(bad({ version: '1.1.0', assets: [] })).toBe(false);
    expect(bad({ version: '1.1', assets: [asset()] })).toBe(false);
    expect(bad({ version: '1.1.0', assets: [asset({ url: 'http://example.org/x.exe' })] })).toBe(false);
    expect(bad({ version: '1.1.0', assets: [asset({ sha256: 'zz' })] })).toBe(false);
    expect(bad({ version: '1.1.0', assets: [asset({ size: 0 })] })).toBe(false);
    expect(bad({ version: '1.1.0', assets: [asset({ platform: 'ios' })] })).toBe(false);
  });
  it('compara huellas sin distinguir mayúsculas y rechaza las mal formadas', () => {
    expect(sameDigest(SHA, SHA.toUpperCase())).toBe(true);
    expect(sameDigest(SHA, 'b'.repeat(64))).toBe(false);
    expect(sameDigest('abc', 'abc')).toBe(false);
  });
});
