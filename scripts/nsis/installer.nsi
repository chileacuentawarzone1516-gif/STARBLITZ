; Instalador de STARBLITZ Desktop para Windows (NSIS, por usuario, sin permisos de administrador).
Unicode true
!include "MUI2.nsh"
!include "FileFunc.nsh"

!define APPNAME "STARBLITZ"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\STARBLITZ"

Name "${APPNAME}"
Caption "Instalar ${APPNAME} ${VERSION}"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\Programs\STARBLITZ"
InstallDirRegKey HKCU "Software\STARBLITZ" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma
SetCompressorDictSize 64
BrandingText "STARBLITZ ${VERSION}"
; VERSION_NUM = X.Y.Z numérica (sin sufijo de prerelease): VIProductVersion solo admite cuatro números.
!ifndef VERSION_NUM
  !define VERSION_NUM "${VERSION}"
!endif
VIProductVersion "${VERSION_NUM}.0"
VIAddVersionKey /LANG=3082 "ProductName" "STARBLITZ"
VIAddVersionKey /LANG=3082 "FileDescription" "Instalador de STARBLITZ"
VIAddVersionKey /LANG=3082 "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=3082 "ProductVersion" "${VERSION}"
VIAddVersionKey /LANG=3082 "LegalCopyright" "Licencia MIT"

!define MUI_ICON "${ICON}"
!define MUI_UNICON "${ICON}"
!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "Bienvenido a STARBLITZ"
!define MUI_WELCOMEPAGE_TEXT "STARBLITZ traduce mangas y cómics al español en tu propio equipo, sin suscripciones ni servidores externos.$\r$\n$\r$\nPulsa Siguiente para continuar."
!define MUI_FINISHPAGE_RUN "$INSTDIR\STARBLITZ.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Abrir STARBLITZ"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "${LICENSE}"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "Spanish"

; La carpeta de destino siempre termina en \STARBLITZ: así el desinstalador nunca puede borrar otra cosa.
Function .onVerifyInstDir
  ${GetFileName} "$INSTDIR" $0
  StrCmp $0 "STARBLITZ" +2
    StrCpy $INSTDIR "$INSTDIR\STARBLITZ"
FunctionEnd

Section "STARBLITZ" SecMain
  SectionIn RO
  ; Cierra una instancia abierta para poder sustituir los archivos.
  nsExec::Exec 'taskkill /IM STARBLITZ.exe /F'
  Sleep 800
  SetOutPath "$INSTDIR"
  RMDir /r "$INSTDIR\resources"
  File /r "${SRC}\*.*"
  Delete "$INSTDIR\portable.txt"
  WriteUninstaller "$INSTDIR\Desinstalar STARBLITZ.exe"
  CreateDirectory "$SMPROGRAMS\STARBLITZ"
  CreateShortcut "$SMPROGRAMS\STARBLITZ\STARBLITZ.lnk" "$INSTDIR\STARBLITZ.exe"
  CreateShortcut "$SMPROGRAMS\STARBLITZ\Desinstalar STARBLITZ.lnk" "$INSTDIR\Desinstalar STARBLITZ.exe"
  CreateShortcut "$DESKTOP\STARBLITZ.lnk" "$INSTDIR\STARBLITZ.exe"
  WriteRegStr HKCU "Software\STARBLITZ" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "STARBLITZ"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "STARBLITZ"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\STARBLITZ.exe"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\Desinstalar STARBLITZ.exe"'
  WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  WriteRegDWORD HKCU "${UNINST_KEY}" "EstimatedSize" $0
SectionEnd

Section "Uninstall"
  nsExec::Exec 'taskkill /IM STARBLITZ.exe /F'
  Sleep 800
  ; Solo se borra lo que instaló STARBLITZ. Los proyectos y modelos (en %APPDATA%\STARBLITZ) se conservan.
  RMDir /r "$INSTDIR\resources"
  RMDir /r "$INSTDIR\locales"
  Delete "$INSTDIR\*.dll"
  Delete "$INSTDIR\*.pak"
  Delete "$INSTDIR\*.bin"
  Delete "$INSTDIR\*.dat"
  Delete "$INSTDIR\*.json"
  Delete "$INSTDIR\*.html"
  Delete "$INSTDIR\*.txt"
  Delete "$INSTDIR\*.md"
  Delete "$INSTDIR\LICENSE"
  Delete "$INSTDIR\version"
  Delete "$INSTDIR\STARBLITZ.exe"
  Delete "$INSTDIR\Desinstalar STARBLITZ.exe"
  RMDir "$INSTDIR"
  Delete "$DESKTOP\STARBLITZ.lnk"
  RMDir /r "$SMPROGRAMS\STARBLITZ"
  DeleteRegKey HKCU "${UNINST_KEY}"
  DeleteRegKey HKCU "Software\STARBLITZ"
SectionEnd
