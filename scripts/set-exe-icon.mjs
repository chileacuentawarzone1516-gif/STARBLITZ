// Sustituye el icono y la información de versión del ejecutable de Electron sin Wine ni rcedit.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// Busca resedit/pe-library junto al repositorio o en NODE_PATH (el script de compilación los instala si faltan).
const require = createRequire(process.env.SB_TOOLS ? `${process.env.SB_TOOLS}/` : import.meta.url);
const ResEdit = require('resedit');
const PELibrary = require('pe-library');

const [exePath, icoPath, version = '1.0.0'] = process.argv.slice(2);
const exe = PELibrary.NtExecutable.from(readFileSync(exePath), { ignoreCert: true });
const res = PELibrary.NtExecutableResource.from(exe);
const ico = ResEdit.Data.IconFile.from(readFileSync(icoPath));

const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
const groupId = groups.length ? groups[0].id : 1;
const lang = groups.length ? groups[0].lang : 1033;
ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, groupId, lang, ico.icons.map((i) => i.data));

const vis = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
const vi = vis[0] ?? ResEdit.Resource.VersionInfo.createEmpty();
const [ma, mi, pa] = version.split('.').map((n) => parseInt(n, 10) || 0);
vi.setFileVersion(ma, mi, pa, 0, 1033);
vi.setProductVersion(ma, mi, pa, 0, 1033);
vi.setStringValues({ lang: 1033, codepage: 1200 }, {
  FileDescription: 'STARBLITZ — traductor de mangas y cómics',
  ProductName: 'STARBLITZ',
  CompanyName: 'STARBLITZ',
  OriginalFilename: 'STARBLITZ.exe',
  InternalName: 'STARBLITZ',
  LegalCopyright: 'Licencia MIT',
});
vi.outputToResourceEntries(res.entries);
res.outputResource(exe);
writeFileSync(exePath, Buffer.from(exe.generate()));
console.log(`Icono y versión ${version} aplicados a ${exePath}`);
