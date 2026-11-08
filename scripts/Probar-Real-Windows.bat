@echo off
setlocal EnableExtensions
chcp 65001 >nul
rem ---------------------------------------------------------------------------------------------------------------
rem  Pruebas REALES de STARBLITZ en este equipo: Hugging Face real, llama.cpp real, Manga OCR y LaMa reales,
rem  traduccion japones->espanol e ingles->espanol y un proyecto completo. Nada de servidores simulados.
rem
rem  Uso:  doble clic            -> --todo (descarga ~3 GB la primera vez; despues reutiliza los modelos)
rem        con argumentos        -> se pasan a tools\probar_real.py, por ejemplo:
rem            Probar-Real-Windows.bat --traduccion
rem            Probar-Real-Windows.bat --proyecto --proyecto-origen "C:\mangas\capitulo1.zip" --idioma ja
rem
rem  Usa el Python y el llama-server de la aplicacion ya construida (dist\STARBLITZ-win-x64) o instalada
rem  (%LOCALAPPDATA%\Programs\STARBLITZ). No toca la carpeta de datos de tu aplicacion: usa .cache\prueba-real\datos.
rem  Escribe el informe en .cache\prueba-real\informe-FECHA\informe.md
rem ---------------------------------------------------------------------------------------------------------------
set "ROOT=%~dp0.."
for %%I in ("%ROOT%") do set "ROOT=%%~fI"

set "APPDIR="
if defined STARBLITZ_APP if exist "%STARBLITZ_APP%\resources\engine\python\python.exe" set "APPDIR=%STARBLITZ_APP%"
if not defined APPDIR if exist "%ROOT%\dist\STARBLITZ-win-x64\resources\engine\python\python.exe" set "APPDIR=%ROOT%\dist\STARBLITZ-win-x64"
if not defined APPDIR if exist "%LOCALAPPDATA%\Programs\STARBLITZ\resources\engine\python\python.exe" set "APPDIR=%LOCALAPPDATA%\Programs\STARBLITZ"
if not defined APPDIR (
  echo No encuentro la aplicacion de Windows. Busque en:
  echo    %ROOT%\dist\STARBLITZ-win-x64
  echo    %LOCALAPPDATA%\Programs\STARBLITZ
  echo Instala STARBLITZ con el instalador, o define STARBLITZ_APP con la carpeta que contiene STARBLITZ.exe.
  pause
  exit /b 2
)

set "PY=%APPDIR%\resources\engine\python\python.exe"
set "ENGINE=%APPDIR%\resources\engine\app"
set "LLAMA=%APPDIR%\resources\llama\llama-server.exe"
if not exist "%ENGINE%\starblitz_engine\__main__.py" (
  echo Falta el motor en "%ENGINE%". La aplicacion esta incompleta.
  pause
  exit /b 2
)
if not exist "%ROOT%\tools\probar_real.py" (
  echo Falta "%ROOT%\tools\probar_real.py". Ejecuta este .bat desde la carpeta scripts de la copia completa de STARBLITZ.
  pause
  exit /b 2
)

for /f %%T in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmmss"') do set "TS=%%T"
set "BASE=%ROOT%\.cache\prueba-real"
set "OUT=%BASE%\informe-%TS%"
set "DATA=%BASE%\datos"
if not exist "%BASE%" mkdir "%BASE%"

set "STARBLITZ_ENGINE_CWD=%ENGINE%"
set "PYTHONPATH=%ENGINE%"
set "PYTHONUTF8=1"

if "%~1"=="" ( set "ARGS=--todo" ) else ( set "ARGS=%*" )

echo.
echo  Aplicacion : %APPDIR%
echo  Informe en : %OUT%
echo  Modelos en : %DATA%   (se reutilizan entre ejecuciones)
echo  Argumentos : %ARGS%
echo.
"%PY%" -X utf8 "%ROOT%\tools\probar_real.py" --out "%OUT%" --data-dir "%DATA%" --llama-server "%LLAMA%" %ARGS%
set "RC=%ERRORLEVEL%"
echo.
if "%RC%"=="0" (
  echo  RESULTADO: todas las comprobaciones duras han pasado. Revisa tambien las traducciones en el informe.
) else (
  echo  RESULTADO: hay comprobaciones fallidas ^(codigo %RC%^). Detalles en el informe.
)
if exist "%OUT%\informe.md" start "" notepad "%OUT%\informe.md"
pause
exit /b %RC%
