<#
  Prueba REAL del instalador de Windows en un Windows de verdad (runner de GitHub o tu equipo): instala en silencio,
  comprueba los archivos, arranca el motor Python EMBEBIDO como lo hace la aplicación, abre la aplicación, y desinstala
  comprobando que los datos del usuario se conservan.

  No prueba: SmartScreen, el aspecto en tu monitor ni la GPU (en un runner no hay GPU; en tu PC sí: ver docs/PRUEBAS-HARDWARE.md).
  Uso:  powershell -ExecutionPolicy Bypass -File scripts\ci\probar-instalador.ps1 -Installer dist\STARBLITZ-Setup-1.0.0.exe -Out informe-windows
#>
param([Parameter(Mandatory)][string]$Installer, [string]$Out = 'informe-windows', [string]$InstallDir = '')
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
New-Item -ItemType Directory -Force $Out | Out-Null
$Out = (Resolve-Path $Out).Path
$Installer = (Resolve-Path $Installer).Path
if (-not $InstallDir) { $InstallDir = Join-Path ([IO.Path]::GetTempPath()) 'STARBLITZ-prueba\STARBLITZ' }
$rows = New-Object System.Collections.Generic.List[string]
$script:fail = $false
function Check($name, [bool]$ok, $detail = '') {
  $s = if ($ok) { 'PASS' } else { $script:fail = $true; 'FAIL' }
  $rows.Add("| $s | $name | $(([string]$detail) -replace '\|','/' -replace "`r?`n",' ') |")
  Write-Host ("{0,-5} {1} {2}" -f $s, $name, $detail)
}
function Info($name, $detail) { $rows.Add("| INFO | $name | $(([string]$detail) -replace '\|','/' -replace "`r?`n",' ') |"); Write-Host "INFO  $name $detail" }

Info 'sistema' ((Get-CimInstance Win32_OperatingSystem).Caption + ' ' + [Environment]::OSVersion.Version + ' · ' + (Get-CimInstance Win32_Processor | Select-Object -First 1).Name)
$size = (Get-Item $Installer).Length
Info 'instalador' ("{0} · {1:N1} MB · SHA-256 {2}" -f (Split-Path $Installer -Leaf), ($size / 1MB), (Get-FileHash $Installer -Algorithm SHA256).Hash.ToLower())
if (Test-Path (Split-Path $InstallDir)) { Remove-Item -Recurse -Force (Split-Path $InstallDir) -ErrorAction SilentlyContinue }

# 1) Instalación silenciosa (por usuario, sin administrador)
$t = Get-Date
$p = Start-Process -FilePath $Installer -ArgumentList '/S', "/D=$InstallDir" -Wait -PassThru
Check 'instalación silenciosa (/S)' ($p.ExitCode -eq 0) ("código de salida $($p.ExitCode), {0:N0} s" -f ((Get-Date) - $t).TotalSeconds)
$exe = Join-Path $InstallDir 'STARBLITZ.exe'
$py = Join-Path $InstallDir 'resources\engine\python\python.exe'
$app = Join-Path $InstallDir 'resources\engine\app'
$llama = Join-Path $InstallDir 'resources\llama\llama-server.exe'
foreach ($f in @($exe, $py, (Join-Path $app 'starblitz_engine\__main__.py'), (Join-Path $InstallDir 'resources\ui\index.html'), $llama, (Join-Path $InstallDir 'Desinstalar STARBLITZ.exe'), (Join-Path $InstallDir 'resources\app\dist-electron\main.cjs'))) {
  Check ("archivo instalado: " + $f.Substring($InstallDir.Length).TrimStart('\')) (Test-Path $f)
}
Check 'no se instaló la carpeta de datos del portátil (data/portable.txt)' (-not (Test-Path (Join-Path $InstallDir 'portable.txt')))
$reg = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\STARBLITZ' -ErrorAction SilentlyContinue
Check 'registrado en «Aplicaciones instaladas» (por usuario)' ($null -ne $reg -and $reg.DisplayName -eq 'STARBLITZ') ($reg.DisplayVersion)
Check 'acceso directo en el menú Inicio' (Test-Path (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\STARBLITZ\STARBLITZ.lnk'))

# 2) El motor embebido, tal como lo arranca Electron
$data = Join-Path $Out 'datos-motor'
New-Item -ItemType Directory -Force $data | Out-Null
$token = [Guid]::NewGuid().ToString('N')
$psi = New-Object Diagnostics.ProcessStartInfo
$psi.FileName = $py
$psi.Arguments = "-m starblitz_engine --port 0 --data-dir `"$data`" --ui-dir `"$InstallDir\resources\ui`" --llama-dir `"$InstallDir\resources\llama`""
$psi.WorkingDirectory = $app
$psi.UseShellExecute = $false; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
$psi.EnvironmentVariables['STARBLITZ_TOKEN'] = $token
$psi.EnvironmentVariables['PYTHONPATH'] = $app
$engine = [Diagnostics.Process]::Start($psi)
$errTask = $engine.StandardError.ReadToEndAsync()
$port = $null; $deadline = (Get-Date).AddSeconds(120)
while ((Get-Date) -lt $deadline -and -not $engine.HasExited -and -not $port) {
  $line = $engine.StandardOutput.ReadLine()
  if ($line -match 'STARBLITZ_READY (\{.*\})') { $port = ($Matches[1] | ConvertFrom-Json).port }
}
Check 'el motor Python embebido arranca y anuncia su puerto' ([bool]$port) ("puerto $port")
if ($port) {
  $h = @{ Authorization = "Bearer $token" }
  try {
    $health = Invoke-RestMethod "http://127.0.0.1:$port/api/health"
    Check '/api/health responde' ($health.status -eq 'ok' -or $health.ok -eq $true -or [bool]$health) ($health | ConvertTo-Json -Compress)
    $sys = Invoke-RestMethod "http://127.0.0.1:$port/api/system" -Headers $h
    Check '/api/system con token' ([bool]$sys) ("proveedores ONNX: " + (($sys.hardware.onnx_providers) -join ', ') + " · llm: " + $sys.llm.provider)
    try { Invoke-RestMethod "http://127.0.0.1:$port/api/projects" | Out-Null; Check 'la API rechaza peticiones sin token' $false } catch { Check 'la API rechaza peticiones sin token' ($_.Exception.Response.StatusCode.value__ -eq 401) }
    $listen = Get-NetTCPConnection -OwningProcess $engine.Id -State Listen -ErrorAction SilentlyContinue
    Check 'el motor solo escucha en 127.0.0.1' ((@($listen | Where-Object { $_.LocalAddress -ne '127.0.0.1' }).Count -eq 0) -and @($listen).Count -ge 1) (($listen | ForEach-Object { "$($_.LocalAddress):$($_.LocalPort)" }) -join ', ')
  } catch { Check 'API del motor' $false $_.Exception.Message }
}
# llama-server de Windows: ¿arranca? (el build Vulkan necesita vulkan-1.dll de un controlador gráfico; un runner sin GPU puede no tenerlo)
try {
  $v = & $llama --version 2>&1 | Out-String
  Info 'llama-server.exe --version' ($v.Trim() -replace "`r?`n", ' · ')
  if ($LASTEXITCODE -ne 0) { Info 'llama-server.exe' "código $LASTEXITCODE (sin GPU/Vulkan en este equipo es esperable; en tu PC con GPU se prueba en docs/PRUEBAS-HARDWARE.md)" }
} catch { Info 'llama-server.exe' ("no se pudo ejecutar: " + $_.Exception.Message) }
if (-not $engine.HasExited) { & taskkill /PID $engine.Id /T /F | Out-Null }
Set-Content (Join-Path $Out 'motor-stderr.log') ($errTask.Result) -ErrorAction SilentlyContinue

# 3) La aplicación completa (Electron) arranca y mantiene su motor
$gui = Start-Process -FilePath $exe -PassThru
Start-Sleep -Seconds 30
Check 'la aplicación (STARBLITZ.exe) sigue abierta a los 30 s' (-not $gui.HasExited) ("PID $($gui.Id)")
$kids = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*starblitz_engine*' -and $_.Name -like 'python*' }
Check 'la aplicación lanzó su propio motor Python' (@($kids).Count -ge 1) ("procesos: $(@($kids).Count)")
try {
  Add-Type -AssemblyName System.Windows.Forms, System.Drawing
  $b = [Windows.Forms.SystemInformation]::VirtualScreen
  $bmp = New-Object Drawing.Bitmap $b.Width, $b.Height
  [Drawing.Graphics]::FromImage($bmp).CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
  $bmp.Save((Join-Path $Out 'captura-aplicacion.png'))
  Info 'captura de pantalla' 'captura-aplicacion.png (en un runner sin GPU puede salir en negro: es un límite de la captura, no de la app)'
} catch { Info 'captura de pantalla' $_.Exception.Message }
Get-Process | Where-Object { $_.Name -in 'STARBLITZ', 'python' -and $_.Path -like "$InstallDir*" } | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
$userData = Join-Path $env:APPDATA 'STARBLITZ'
Info 'datos del usuario creados por la app' ("$userData · existe: " + (Test-Path $userData))
if (-not (Test-Path $userData)) { New-Item -ItemType Directory -Force $userData | Out-Null }
Set-Content (Join-Path $userData 'prueba-conservar.txt') 'este archivo debe sobrevivir a la desinstalación'

# 4) Desinstalación silenciosa
$un = Join-Path $InstallDir 'Desinstalar STARBLITZ.exe'
$pu = Start-Process -FilePath $un -ArgumentList '/S', "_?=$InstallDir" -Wait -PassThru
Check 'desinstalación silenciosa' ($pu.ExitCode -eq 0) ("código $($pu.ExitCode)")
Remove-Item $un -Force -ErrorAction SilentlyContinue
Check 'la carpeta de la aplicación se eliminó' (-not (Test-Path $exe) -and -not (Test-Path (Join-Path $InstallDir 'resources')))
Check 'los datos del usuario se conservan tras desinstalar' (Test-Path (Join-Path $userData 'prueba-conservar.txt'))
Check 'se retiró el registro de «Aplicaciones instaladas»' (-not (Test-Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\STARBLITZ'))
Remove-Item (Join-Path $userData 'prueba-conservar.txt') -Force -ErrorAction SilentlyContinue

$md = @('# Prueba del instalador de Windows (Windows real)', '', '| Estado | Comprobación | Detalle |', '|---|---|---|') + $rows + @('', '_Un runner de CI no es tu PC: SmartScreen, GPU y aspecto en pantalla quedan pendientes (docs/PRUEBAS-HARDWARE.md)._')
Set-Content -Path (Join-Path $Out 'windows-instalador.md') -Value $md -Encoding UTF8
if ($script:fail) { exit 1 } else { exit 0 }
