#!/usr/bin/env bash
# Comprobaciones de integridad del repositorio (solo lectura). Se ejecuta en CI y en local dentro de un repositorio Git.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
FAIL=0
err() { echo "::error::$*"; FAIL=1; }
FILES=$(git ls-files)

# 1. Rutas que nunca deben versionarse (Vault, copias, binarios, secretos, claves, modelos)
BAD=$(printf '%s\n' "$FILES" | grep -Ei '^(STARBLITZ (OBISIDIAN|OBSIDIAN)/|_backup/|_transfer/|_to_delete/|Claude outputs/|dist/|node_modules/)|(^|/)\.obsidian/|(^|/)\.env($|\.)|\.(jks|keystore|p12|pfx|pem|gguf|apk|aab|exe)$' | grep -v '\.env\.example$' || true)
[ -z "$BAD" ] || err "Archivos prohibidos versionados: $(echo "$BAD" | head -5 | tr '\n' ' ')"

# 2. Tamaño: nada por encima de 25 MiB (los binarios grandes van a Releases)
while IFS= read -r f; do
  [ -f "$f" ] || continue
  [ "$(stat -c %s "$f")" -le 26214400 ] || err "Archivo demasiado grande (>25 MiB): $f"
done <<< "$FILES"

# 3. Finales de línea: scripts de shell y gradlew deben estar en LF
while IFS= read -r f; do
  case "$f" in *.sh|*/gradlew|gradlew) [ "$(tr -cd '\r' < "$f" | wc -c)" -eq 0 ] || err "CRLF en $f (debe ser LF)";; esac
done <<< "$FILES"

# 4. Secretos evidentes en archivos de texto versionados
SEC=$(git grep -InE 'ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|AKIA[0-9A-Z]{16}|hf_[A-Za-z0-9]{30,}|sk-ant-[A-Za-z0-9_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----' -- . ':(exclude)scripts/ci/verificar-repo.sh' || true)
[ -z "$SEC" ] || err "Posibles secretos: $(echo "$SEC" | cut -d: -f1,2 | head -5 | tr '\n' ' ')"

# 5. Workflows: solo release.yml puede pedir escritura; sin pull_request_target; acciones de terceros fijadas por SHA
W=$(grep -ln 'contents: write' .github/workflows/*.yml | grep -v 'release.yml$' || true)
[ -z "$W" ] || err "contents: write fuera de release.yml: $W"
grep -ln 'pull_request_target' .github/workflows/*.yml && err "pull_request_target no permitido" || true
U=$(grep -nP 'uses:\s*(?!\./)\S+@(?![0-9a-f]{40}\b)' .github/workflows/*.yml || true)
[ -z "$U" ] || err "Acciones sin fijar por SHA: $(echo "$U" | head -3 | tr '\n' ' ')"

# 6. Documentos imprescindibles
for f in README.md LICENSE CHANGELOG.md CONTRIBUTING.md SECURITY.md .gitignore .gitattributes; do
  printf '%s\n' "$FILES" | grep -qx "$f" || err "Falta el archivo versionado: $f"
done

# 7. Un único instalador de Windows (NSIS directo, windows.yml), reutilizado por build, validacion y release
grep -ln 'electron-builder' .github/workflows/*.yml && err "Los workflows no deben usar electron-builder (instalador canónico: NSIS directo)" || true
for w in build validacion; do
  grep -q 'workflows/windows.yml' ".github/workflows/$w.yml" || err "$w.yml no reutiliza windows.yml"
done
grep -q 'workflows/build.yml' .github/workflows/release.yml || err "release.yml no reutiliza build.yml"
{ grep -q 'build-installer.sh' .github/workflows/windows.yml && grep -q 'probar-instalador.ps1' .github/workflows/windows.yml; } \
  || err "windows.yml debe generar (build-installer.sh) y probar (probar-instalador.ps1) el instalador"

# 8. Versiones coherentes: raíz, apps, motor Python y Android
ver() { sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "$1" | head -n1; }
V=$(ver package.json)
for f in apps/desktop/package.json apps/mobile/package.json apps/shared/package.json; do
  [ "$(ver "$f")" = "$V" ] || err "Versión de $f ($(ver "$f")) distinta de package.json ($V)"
done
PY=$(sed -n 's/^__version__ = "\(.*\)"/\1/p' engine/starblitz_engine/__init__.py | head -n1)
PP=$(sed -n 's/^version = "\(.*\)"/\1/p' engine/pyproject.toml | head -n1)
AN=$(sed -n 's/.*versionName "\([^"]*\)".*/\1/p' apps/mobile/android/app/build.gradle | head -n1)
AC=$(sed -n 's/.*versionCode \([0-9][0-9]*\).*/\1/p' apps/mobile/android/app/build.gradle | head -n1)
[ "$PY" = "$V" ] || err "Versión del motor Python ($PY) distinta de package.json ($V)"
[ "$PP" = "$V" ] || err "Versión de engine/pyproject.toml ($PP) distinta de package.json ($V)"
[ "$AN" = "$V" ] || err "versionName de Android ($AN) distinto de package.json ($V)"
{ [ -n "$AC" ] && [ "$AC" -ge 1 ]; } || err "versionCode de Android inválido ($AC)"

[ "$FAIL" = 0 ] && echo "Integridad del repositorio: OK ($(printf '%s\n' "$FILES" | wc -l) archivos versionados)"
exit "$FAIL"
