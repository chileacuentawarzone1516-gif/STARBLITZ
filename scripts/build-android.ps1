<#
  Compila el APK de STARBLITZ Mobile en Windows sin instalar Android Studio.

  Descarga (solo la primera vez, en .cache\android dentro del proyecto):
    - JDK 21 (Eclipse Temurin, portátil; se verifica su SHA-256 con el publicado por Adoptium)
    - Herramientas de línea de comandos de Android + plataforma 35 + build-tools
    - El OCR PP-OCR (si falta), desde PyPI con SHA-256 verificado
  y genera dist\STARBLITZ-android.apk firmado con una clave propia que se crea
  en .cache\android\starblitz.jks (guárdala: la necesitarás para publicar actualizaciones).

  Antes de compilar comprueba que el equipo tiene lo necesario (Node, espacio, acceso a las páginas de descarga), que el
  motor de lenguaje nativo (llama.cpp para arm64), el OCR PP-OCR y la interfaz están completos y que las pruebas pasan;
  así un APK defectuoso no llega al teléfono. Después de compilar verifica la firma y el contenido del APK.

  Todo lo que ocurre se guarda en .cache\android\logs\compilar-apk-FECHA.log (si algo falla, envía ese archivo).

  Uso (PowerShell, desde la carpeta del proyecto):
    powershell -ExecutionPolicy Bypass -File scripts\build-android.ps1            # APK de publicación firmado
    powershell -ExecutionPolicy Bypass -File scripts\build-android.ps1 -Install   # además lo instala con adb (teléfono con
                                                                                     depuración USB, o BlueStacks/emulador)
    powershell -ExecutionPolicy Bypass -File scripts\build-android.ps1 -Preflight # solo comprueba el equipo y la red (no descarga ni compila)
  Requisitos: Node.js 20+ instalado y ~6 GB libres. El APK solo contiene arm64-v8a (teléfonos actuales).
#>
param([switch]$Install, [switch]$SkipTests, [switch]$Preflight)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# Windows PowerShell 5.1 puede negociar solo TLS 1.0/1.1 y GitHub/Google lo rechazan: se exige TLS 1.2 como mínimo.
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }

$root = Split-Path $PSScriptRoot -Parent
$cache = Join-Path $root '.cache\android'
$logDir = Join-Path $cache 'logs'
New-Item -ItemType Directory -Force $logDir | Out-Null
$log = Join-Path $logDir ('compilar-apk-{0:yyyyMMdd-HHmmss}.log' -f (Get-Date))
$script:logw = New-Object IO.StreamWriter($log, $true, (New-Object Text.UTF8Encoding($false)))
$script:logw.AutoFlush = $true

function Log([string]$msg) { $script:logw.WriteLine($msg) }
function Step($msg) { Write-Host "`n>> $msg" -ForegroundColor Magenta; Log "`n>> $msg" }
function Say($msg, $color = $null) { if ($color) { Write-Host $msg -ForegroundColor $color } else { Write-Host $msg }; Log $msg }

# Ejecuta un programa nativo: muestra y registra TODA su salida, y falla con un mensaje claro si el código de salida no es 0.
# (Con $ErrorActionPreference='Stop', Windows PowerShell 5.1 convertiría cualquier línea de stderr en una excepción: se evita.)
function Invoke-Native {
  param([string]$What, [string]$Exe, [string[]]$Arguments = @(), [string]$Dir = '', $Stdin = $null)
  Log ('$ ' + $Exe + ' ' + ($Arguments -join ' '))
  $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  $global:LASTEXITCODE = 0
  if ($Dir) { Push-Location $Dir }
  try {
    if ($null -ne $Stdin) {
      $Stdin | & $Exe @Arguments 2>&1 | ForEach-Object { $l = "$_"; Log $l; $l } | Out-Host
    } else {
      & $Exe @Arguments 2>&1 | ForEach-Object { $l = "$_"; Log $l; $l } | Out-Host
    }
    $code = $LASTEXITCODE
  } finally {
    if ($Dir) { Pop-Location }
    $ErrorActionPreference = $prev
  }
  if ($code -ne 0) { throw "$What falló (código de salida $code)." }
}

function Fetch($url, $dest) {
  if (Test-Path $dest) { return }
  for ($i = 1; $i -le 3; $i++) {
    try { Invoke-WebRequest -Uri $url -OutFile "$dest.part" -UseBasicParsing; Move-Item "$dest.part" $dest -Force; return }
    catch { Log "Descarga $i/3 fallida ($url): $($_.Exception.Message)"; if ($i -eq 3) { throw "No se pudo descargar $url. $($_.Exception.Message)" }; Start-Sleep -Seconds (3 * $i) }
  }
}

function Test-Url([string]$url) {
  try { $r = Invoke-WebRequest -Uri $url -Method Head -UseBasicParsing -TimeoutSec 25; return ,@($true, [string][int]$r.StatusCode) }
  catch {
    if ($_.Exception.Response) { return ,@($true, [string][int]$_.Exception.Response.StatusCode) }   # el servidor respondió (aunque sea 403/405 a HEAD)
    return ,@($false, $_.Exception.Message)
  }
}

function Test-Preflight {
  Step 'Comprobaciones previas del equipo'
  $problems = New-Object System.Collections.Generic.List[string]
  Say ("  Sistema: {0} · PowerShell {1}" -f [Environment]::OSVersion.VersionString, $PSVersionTable.PSVersion)
  Say "  Proyecto: $root"

  if ($root.Length -gt 90) { Say "  AVISO: la ruta del proyecto es larga ($($root.Length) caracteres). Windows limita las rutas a 260 y Gradle crea carpetas muy anidadas: mueve el proyecto a algo como C:\STARBLITZ si falla." Yellow }
  if ($root -match '[^\x00-\x7F]') { Say '  AVISO: la ruta del proyecto tiene caracteres no ASCII (acentos, ñ…). Algunas herramientas de Android fallan con ellos; si ves errores raros, mueve el proyecto a C:\STARBLITZ.' Yellow }
  if ($root -match '\s') { Say '  AVISO: la ruta del proyecto contiene espacios. Normalmente funciona, pero si falla el SDK o Gradle, prueba con una ruta sin espacios.' Yellow }

  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { $problems.Add('Falta Node.js 20 o superior: https://nodejs.org/es/download (instala la versión LTS y vuelve a abrir esta ventana).') }
  else {
    $v = ((& node -v) | Out-String).Trim().TrimStart('v')
    Say "  Node.js: v$v"
    try { if ([version]($v.Split('-')[0]) -lt [version]'20.0.0') { $problems.Add("Tu Node.js es v$v; hace falta la 20 o superior (https://nodejs.org/es/download).") } } catch { Say "  AVISO: no se pudo interpretar la versión de Node ($v)." Yellow }
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { $problems.Add('Node.js está instalado pero falta npm. Reinstala Node.js desde https://nodejs.org/es/download.') }
  }

  try {
    $drive = New-Object IO.DriveInfo($root.Substring(0, 1))
    $freeGb = [math]::Round($drive.AvailableFreeSpace / 1GB, 1)
    Say "  Espacio libre en $($drive.Name): $freeGb GB (se necesitan unos 6 GB la primera vez)"
    if ($freeGb -lt 6) { $problems.Add("Solo hay $freeGb GB libres en $($drive.Name); hacen falta unos 6 GB (JDK, SDK de Android, Gradle y la compilación).") }
  } catch { Say '  (no se pudo medir el espacio libre; se continúa)' }

  Say '  Acceso a las páginas de descarga:'
  $hosts = @(
    @('GitHub (JDK y OCR)', 'https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.5%2B11/OpenJDK21U-jdk_x64_windows_hotspot_21.0.5_11.zip.sha256.txt'),
    @('Google (SDK de Android)', 'https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip'),
    @('Google Maven (bibliotecas de Android)', 'https://dl.google.com/dl/android/maven2/androidx/appcompat/appcompat/maven-metadata.xml'),
    @('Gradle (descarga de Gradle)', 'https://services.gradle.org/distributions/gradle-8.11.1-bin.zip'),
    @('Gradle (complementos)', 'https://plugins.gradle.org/m2/'),
    @('Maven Central', 'https://repo.maven.apache.org/maven2/'),
    @('npm', 'https://registry.npmjs.org/'),
    @('PyPI (OCR PP-OCR)', 'https://files.pythonhosted.org/')
  )
  foreach ($h in $hosts) {
    $r = Test-Url $h[1]
    if ($r[0]) { Say ("    OK    {0} (HTTP {1})" -f $h[0], $r[1]) }
    else { Say ("    FALLO {0}: {1}" -f $h[0], $r[1]) Red; $problems.Add("No se puede llegar a $($h[0]) ($($h[1])). Revisa tu conexión, el proxy/VPN, el cortafuegos o el antivirus. Detalle: $($r[1])") }
  }

  if ($problems.Count -gt 0) {
    Say '' ; Say 'Hay que resolver esto antes de compilar:' Red
    $problems | ForEach-Object { Say "  - $_" Red }
    throw 'Comprobaciones previas fallidas.'
  }
  Say '  Todo correcto.' Green
}

# Asegura apps/mobile/public/models/ppocr-rec.onnx (OCR multilingüe PP-OCR) sin necesitar Git Bash ni WSL:
# descarga el paquete oficial de PyPI (SHA-256 fijado), extrae solo el reconocedor y vuelve a comprobar su huella.
function Initialize-PPOCR {
  $outDir = Join-Path $root 'apps\mobile\public\models'
  $out = Join-Path $outDir 'ppocr-rec.onnx'
  $modelSha = '6f327246b50388f3c176ae304bd95767ea6dc0c9ae92153ef8cbe210b3c14884'
  if ((Test-Path $out) -and ((Get-FileHash $out -Algorithm SHA256).Hash.ToLower() -eq $modelSha)) { return }
  Step 'OCR PP-OCR (se descarga una vez desde PyPI y se verifica)'
  $ver = '3.10.0'
  $whlSha = '2fc34e26cd0f48514804a94f8832283039c7334076bff60768b1fed9ad068050'
  $whl = Join-Path $cache "rapidocr-$ver.whl"
  Fetch "https://files.pythonhosted.org/packages/59/07/203065283bba0c5e9c10af3602dc25ab3e59ee54dc2d1d22c8faeabf5ed8/rapidocr-$ver-py3-none-any.whl" $whl
  if ((Get-FileHash $whl -Algorithm SHA256).Hash.ToLower() -ne $whlSha) { Move-Item $whl "$whl.corrupto" -Force; throw 'El SHA-256 del paquete rapidocr no coincide (se renombró a .corrupto). Vuelve a ejecutar el script.' }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  New-Item -ItemType Directory -Force $outDir | Out-Null
  $zip = [IO.Compression.ZipFile]::OpenRead($whl)
  try {
    $map = @{
      'rapidocr/models/PP-OCRv6_rec_small.onnx' = $out
      "rapidocr-$ver.dist-info/licenses/LICENSE" = (Join-Path $outDir 'PPOCR-LICENSE.txt')
      "rapidocr-$ver.dist-info/licenses/MODEL_LICENSES.md" = (Join-Path $outDir 'PPOCR-MODEL-LICENSES.md')
    }
    foreach ($name in $map.Keys) {
      $entry = $zip.GetEntry($name)
      if (-not $entry) { throw "El paquete rapidocr no contiene $name." }
      [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $map[$name], $true)
    }
  } finally { $zip.Dispose() }
  if ((Get-FileHash $out -Algorithm SHA256).Hash.ToLower() -ne $modelSha) { throw 'El SHA-256 del modelo PP-OCR extraído no coincide.' }
  Say "  PP-OCR listo: $out" Green
}

try {
  Say ("STARBLITZ · compilación del APK de Android · {0:yyyy-MM-dd HH:mm:ss}" -f (Get-Date))
  Say "Registro: $log"
  Test-Preflight
  if ($Preflight) { Say "`nSolo se pidió la comprobación previa: no se descargó ni compiló nada." Green; $script:logw.Dispose(); exit 0 }

  Step 'JDK 21 (Temurin)'
  $jdkUrl = 'https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.5%2B11/OpenJDK21U-jdk_x64_windows_hotspot_21.0.5_11.zip'
  $jdkZip = Join-Path $cache 'jdk21.zip'
  Fetch $jdkUrl $jdkZip
  $jdkDir = Join-Path $cache 'jdk'
  if (-not (Test-Path (Join-Path $jdkDir 'bin\java.exe'))) {
    # Comprueba la integridad con la huella que publica Adoptium junto al archivo.
    $shaFile = Join-Path $cache 'jdk21.zip.sha256.txt'
    Fetch "$jdkUrl.sha256.txt" $shaFile
    $want = ((Get-Content $shaFile -Raw).Trim() -split '\s+')[0].ToLower()
    $have = (Get-FileHash $jdkZip -Algorithm SHA256).Hash.ToLower()
    if ($want -ne $have) { Move-Item $jdkZip "$jdkZip.corrupto" -Force; Remove-Item $shaFile -Force; throw "El JDK descargado está dañado (SHA-256 distinto del publicado). Se renombró a jdk21.zip.corrupto; vuelve a ejecutar el script." }
    Say "  JDK verificado (SHA-256 $have)"
    if (Test-Path $jdkDir) { Move-Item $jdkDir ("$jdkDir.incompleto-{0:yyyyMMddHHmmss}" -f (Get-Date)) }   # restos de una extracción interrumpida: se apartan, no se borran
    Expand-Archive $jdkZip $cache
    $extracted = Get-ChildItem $cache -Directory | Where-Object { $_.Name -like 'jdk-21*' } | Select-Object -First 1
    if (-not $extracted) { throw 'No se encontró la carpeta jdk-21* tras descomprimir el JDK.' }
    Rename-Item $extracted.FullName 'jdk'
  }
  $env:JAVA_HOME = $jdkDir
  $env:Path = "$jdkDir\bin;$env:Path"
  Invoke-Native 'java -version' (Join-Path $jdkDir 'bin\java.exe') @('-version')

  Step 'SDK de Android'
  $sdk = Join-Path $cache 'sdk'
  $toolsZip = Join-Path $cache 'cmdline-tools.zip'
  Fetch 'https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip' $toolsZip
  Log ("cmdline-tools.zip SHA-256 {0}" -f (Get-FileHash $toolsZip -Algorithm SHA256).Hash.ToLower())
  $sdkmanager = Join-Path $sdk 'cmdline-tools\latest\bin\sdkmanager.bat'
  if (-not (Test-Path $sdkmanager)) {
    $tmp = Join-Path $sdk 'cmdline-tools\tmp'
    if (Test-Path $tmp) { Move-Item $tmp ("$tmp.incompleto-{0:yyyyMMddHHmmss}" -f (Get-Date)) }
    New-Item -ItemType Directory -Force (Join-Path $sdk 'cmdline-tools') | Out-Null
    Expand-Archive $toolsZip $tmp
    Move-Item (Join-Path $tmp 'cmdline-tools') (Join-Path $sdk 'cmdline-tools\latest')
  }
  $env:ANDROID_HOME = $sdk
  $env:ANDROID_SDK_ROOT = $sdk
  # Acepta las licencias de Google del SDK (necesario para compilar).
  $yes = ('y' + [Environment]::NewLine) * 30
  Invoke-Native 'Aceptar las licencias del SDK' $sdkmanager @("--sdk_root=$sdk", '--licenses') -Stdin $yes
  # build-tools 34 es el que usa por defecto el complemento de Android de Gradle (AGP 8.7); la 35 es la de la plataforma.
  Invoke-Native 'Instalar plataforma y herramientas del SDK' $sdkmanager @("--sdk_root=$sdk", 'platform-tools', 'platforms;android-35', 'build-tools;34.0.0', 'build-tools;35.0.0')

  Initialize-PPOCR

  Step 'Comprobando el motor nativo y los modelos incluidos en la app'
  $jni = Join-Path $root 'apps\mobile\android\app\src\main\jniLibs\arm64-v8a'
  $expected = Get-Content (Join-Path $root 'apps\mobile\android\app\vendor\llama-libs.sha256') | Where-Object { $_.Trim() }
  foreach ($line in $expected) {
    $hash, $name = $line -split '\s+', 2
    $file = Join-Path $jni $name.Trim().TrimStart('*')
    if (-not (Test-Path $file)) { throw "Falta $name en jniLibs (motor llama.cpp arm64). Restaura apps\mobile\android\app\src\main\jniLibs\arm64-v8a desde tu copia completa de STARBLITZ o ejecuta tools/prepare_llama_android.sh (Git Bash o WSL)." }
    if ((Get-FileHash $file -Algorithm SHA256).Hash.ToLower() -ne $hash.ToLower()) { throw "El SHA-256 de $name no coincide con vendor/llama-libs.sha256." }
  }
  Say ("  llama.cpp arm64: {0} archivos verificados" -f @($expected).Count)
  $ppocr = Join-Path $root 'apps\mobile\public\models\ppocr-rec.onnx'
  if (-not (Test-Path $ppocr)) { throw 'Falta apps/mobile/public/models/ppocr-rec.onnx.' }
  if ((Get-FileHash $ppocr -Algorithm SHA256).Hash.ToLower() -ne '6f327246b50388f3c176ae304bd95767ea6dc0c9ae92153ef8cbe210b3c14884') { throw 'El SHA-256 del OCR PP-OCR no coincide.' }
  Say '  PP-OCR: verificado'

  Step 'Dependencias, pruebas y compilación web'
  $npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue)
  if (-not $npm) { $npm = Get-Command npm }
  $npmExe = $npm.Source
  Invoke-Native 'npm ci' $npmExe @('ci', '--no-audit', '--no-fund') -Dir $root
  $mobile = Join-Path $root 'apps\mobile'
  if (-not $SkipTests) { Invoke-Native 'Las pruebas de la app' $npmExe @('test') -Dir $mobile }
  Invoke-Native 'La compilación de la interfaz' $npmExe @('run', 'build') -Dir $mobile
  foreach ($f in 'ort\ort-wasm-simd-threaded.mjs', 'ort\ort-wasm-simd-threaded.wasm', 'models\ppocr-rec.onnx', 'index.html') {
    if (-not (Test-Path (Join-Path $mobile "dist\$f"))) { throw "La interfaz compilada no incluye $f." }
  }
  $npx = (Get-Command npx.cmd -ErrorAction SilentlyContinue)
  if (-not $npx) { $npx = Get-Command npx }
  Invoke-Native 'cap sync' $npx.Source @('cap', 'sync', 'android') -Dir $mobile

  Step 'Clave de firma'
  $ks = Join-Path $cache 'starblitz.jks'
  $pwFile = Join-Path $cache 'keystore-password.txt'
  if (-not (Test-Path $ks)) {
    $pw = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
    Set-Content -Path $pwFile -Value $pw -NoNewline
    Invoke-Native 'Crear la clave de firma' (Join-Path $jdkDir 'bin\keytool.exe') @('-genkeypair', '-keystore', $ks, '-alias', 'starblitz', '-keyalg', 'RSA', '-keysize', '4096', '-validity', '10000', '-storepass', $pw, '-keypass', $pw, '-dname', 'CN=STARBLITZ, O=STARBLITZ, C=DO')
  }
  if (-not (Test-Path $pwFile)) { throw "Existe $ks pero falta $pwFile. Sin la contraseña no se puede firmar: restáurala, o mueve la clave a otra carpeta para que se cree una nueva (las actualizaciones de una app firmada con otra clave no se instalan encima)." }
  $env:SB_KEYSTORE = $ks
  $env:SB_KEYSTORE_PASSWORD = (Get-Content $pwFile -Raw).Trim()
  $env:SB_KEY_ALIAS = 'starblitz'

  Step 'Compilando APK (la primera vez descarga Gradle y tarda varios minutos)'
  $android = Join-Path $root 'apps\mobile\android'
  Invoke-Native 'Gradle assembleRelease' (Join-Path $android 'gradlew.bat') @('--no-daemon', '--console=plain', '--stacktrace',
    '-Dorg.gradle.internal.http.connectionTimeout=60000', '-Dorg.gradle.internal.http.socketTimeout=180000', 'assembleRelease') -Dir $android
  New-Item -ItemType Directory -Force (Join-Path $root 'dist') | Out-Null
  $apk = Join-Path $root 'dist\STARBLITZ-android.apk'
  $built = Join-Path $android 'app\build\outputs\apk\release\app-release.apk'
  if (-not (Test-Path $built)) { throw "Gradle terminó sin error pero no existe $built." }
  Copy-Item $built $apk -Force

  Step 'Verificando el APK'
  $bt = Get-ChildItem (Join-Path $sdk 'build-tools') -Directory | Sort-Object { [version]($_.Name -replace '[^0-9.]', '') } -Descending | Select-Object -First 1
  Invoke-Native 'apksigner verify' (Join-Path $bt.FullName 'apksigner.bat') @('verify', '--verbose', '--print-certs', $apk)
  $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  $badging = (& (Join-Path $bt.FullName 'aapt2.exe') dump badging $apk 2>&1 | Out-String)
  $ErrorActionPreference = $prev
  Log $badging
  if ($badging -notmatch "package: name='app\.starblitz\.mobile'") { throw 'El APK no tiene el identificador app.starblitz.mobile.' }
  if ($badging -notmatch "native-code: 'arm64-v8a'") { throw 'El APK no declara código nativo arm64-v8a: faltaría el motor de lenguaje.' }
  if ($badging -match "native-code:[^\r\n]*'(x86|x86_64|armeabi-v7a|armeabi)'") { Say '  AVISO: el APK incluye arquitecturas distintas de arm64-v8a.' Yellow }
  $perm = [regex]::Matches($badging, "uses-permission: name='([^']+)'") | ForEach-Object { $_.Groups[1].Value }
  Say ("  Permisos que pide: " + ($perm -join ', '))
  $mb = [math]::Round((Get-Item $apk).Length / 1MB, 1)
  if ($mb -lt 40 -or $mb -gt 250) { Say "  AVISO: el tamaño del APK ($mb MB) se sale de lo esperable (≈ 60–120 MB); revisa el registro." Yellow }
  $sha = (Get-FileHash $apk -Algorithm SHA256).Hash.ToLower()
  Set-Content -Path "$apk.sha256" -Value "$sha  STARBLITZ-android.apk" -Encoding ASCII
  Say "`nAPK listo: $apk ($mb MB, SHA-256 $sha)" Green
  Say 'Guarda .cache\android\starblitz.jks y su contraseña: sin ellos no podrás publicar actualizaciones.'
  Say 'IMPORTANTE: que el APK esté compilado y firmado NO demuestra que funcione en tu teléfono; pruébalo con docs\PRUEBAS-HARDWARE.md.'
  if ($Install) {
    Step 'Instalando con adb'
    $adb = Join-Path $sdk 'platform-tools\adb.exe'
    Invoke-Native 'adb devices' $adb @('devices')
    $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    & $adb install -r $apk 2>&1 | ForEach-Object { Say "$_" }
    $code = $LASTEXITCODE
    $ErrorActionPreference = $prev
    if ($code -eq 0) { & $adb shell monkey -p app.starblitz.mobile -c android.intent.category.LAUNCHER 1 | Out-Null; Say 'Instalada y abierta.' Green }
    else { Say 'No se pudo instalar: conecta un teléfono con depuración USB (y acepta la huella RSA en su pantalla) o activa ADB en BlueStacks (Ajustes → Avanzado). Si dice INSTALL_FAILED_NO_MATCHING_ABIS, el dispositivo no es arm64.' Yellow }
  } else {
    Say 'Instálalo copiándolo al teléfono, o con -Install (adb), o arrástralo a BlueStacks.'
  }
  Say "Registro completo: $log"
  $script:logw.Dispose()
  exit 0
} catch {
  Say "`nERROR: $($_.Exception.Message)" Red
  Log ($_ | Out-String)
  Say "Registro completo (envíalo si necesitas ayuda): $log" Yellow
  Say 'Causas habituales: sin conexión o con proxy/VPN/antivirus que bloquea descargas (ejecuta con -Preflight para comprobarlo), disco lleno, ruta del proyecto demasiado larga o con acentos, o Node.js anterior a la 20.' Yellow
  $script:logw.Dispose()
  exit 1
}
