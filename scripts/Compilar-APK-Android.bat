@echo off
setlocal
chcp 65001 >nul
rem Compila el APK de STARBLITZ para Android. Doble clic, o desde una consola:
rem    Compilar-APK-Android.bat              compila y firma el APK  ->  dist\STARBLITZ-android.apk
rem    Compilar-APK-Android.bat -Install     ademas lo instala con adb (telefono con depuracion USB)
rem    Compilar-APK-Android.bat -Preflight   solo comprueba el equipo y la red (no descarga ni compila)
rem    Compilar-APK-Android.bat -SkipTests   omite las pruebas de la app
rem El registro completo queda en .cache\android\logs\
echo Compilando STARBLITZ para Android...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-android.ps1" %*
set "RC=%ERRORLEVEL%"
echo.
if "%RC%"=="0" ( echo [OK] Terminado. ) else ( echo [ERROR] La compilacion fallo ^(codigo %RC%^). Mira el mensaje de arriba y el registro en .cache\android\logs\ )
if not defined STARBLITZ_NO_PAUSE pause
exit /b %RC%
