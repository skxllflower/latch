; Latch's Windows installer (the native GUI). Built by tools/build-release-native.ps1, which stages the files and passes
; the defines below; by hand:
;
;   makensis /DVERSION=0.1.8 /DSTAGE=<staged dir> [/DFFMPEG=<dir with ffmpeg.exe + ffprobe.exe>] /DOUTFILE=<setup.exe>
;            /DICON=<icon.ico> native/installer/latch.nsi
;
; Per machine, into Program Files\Vacant Systems\Latch, under the uninstall key "Latch", the exe latch-gui.exe: the
; Tauri app's place, key and name, so it installs over that app in place (the same shortcuts, and the paths WAVdesk
; and its installer probe). /S installs silently (WAVdesk's installer runs it so for its companion offer).
; Two variants, as the Tauri build had: the standalone one bundles ffmpeg + ffprobe (FFMPEG defined: Latch alone works
; offline and seeds Shared\bin for a WAVdesk installed later); the embedded one (no FFMPEG) is the copy WAVdesk ships,
; since WAVdesk provisions the suite's ffmpeg itself. The staged dir:
;
;   latch-gui.exe               the app (the native GUI)
;   coredist\latch.exe          the CLI that does every probe and download (the Tauri layout: the app finds it there,
;                               WAVdesk through Shared\registry.json)
;   resources\ytdlp\yt-dlp.exe  (optional) seeded into ProgramData\Vacant Systems\Latch\bin on first launch

Unicode true
ManifestDPIAware true
RequestExecutionLevel admin
SetCompressor /SOLID lzma

!ifndef VERSION
  !error "pass /DVERSION=<x.y.z>"
!endif
!ifndef STAGE
  !error "pass /DSTAGE=<staged dir>"
!endif
!ifndef OUTFILE
  !define OUTFILE "Latch_${VERSION}_x64-setup.exe"
!endif

!define PRODUCT "Latch"
!define PUBLISHER "Vacant Systems"
!define MAINEXE "latch-gui.exe"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT}"
!define DIR_KEY "Software\vacantsystems\${PRODUCT}"
!define STARTMENU "$SMPROGRAMS\Vacant Systems"

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "x64.nsh"
!include "nsDialogs.nsh"

Name "${PRODUCT}"
OutFile "${OUTFILE}"
InstallDir "$PROGRAMFILES64\Vacant Systems\${PRODUCT}"
InstallDirRegKey HKLM "${DIR_KEY}" ""
BrandingText "${PUBLISHER}"

VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "${PRODUCT}"
VIAddVersionKey "CompanyName" "${PUBLISHER}"
VIAddVersionKey "FileDescription" "${PRODUCT} Setup"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "${PUBLISHER}"

!ifdef ICON
  !define MUI_ICON "${ICON}"
  !define MUI_UNICON "${ICON}"
!endif
!define MUI_ABORTWARNING

!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT "Start ${PRODUCT}"
!define MUI_FINISHPAGE_RUN_FUNCTION LaunchUnelevated

!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
UninstPage custom un.DataPage un.DataPageLeave
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

; SAFE_RMDIR_R <path> <suffix>: a recursive delete only when the path is non-empty and ends with <suffix> (an empty
; variable before \* is the classic NSIS disk wipe)
!macro SAFE_RMDIR_R path suffix
  Push $R7
  Push $R8
  StrCpy $R8 "${path}"
  StrLen $R7 "${suffix}"
  IntOp $R7 0 - $R7
  StrCpy $R7 "$R8" "" $R7
  ${If} $R8 != ""
  ${AndIf} $R7 == "${suffix}"
    RMDir /r "$R8"
  ${EndIf}
  Pop $R8
  Pop $R7
!macroend

; WAIT_UNLOCKED <file>: a running latch-gui.exe (this app, or the Tauri one) or latch.exe (a download, WAVdesk's chop)
; holds its image open; ask the user to quit rather than kill it mid-download. Silent: abort, unchanged.
!macro WAIT_UNLOCKED file what
  ${If} ${FileExists} "${file}"
    ${Do}
      ClearErrors
      FileOpen $R9 "${file}" a
      ${IfNot} ${Errors}
        FileClose $R9
        ${Break}
      ${EndIf}
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "${what} is running. Quit it, then click Retry." /SD IDCANCEL IDRETRY +2
      Abort "${what} is running."
    ${Loop}
  ${EndIf}
!macroend

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "${PRODUCT} needs 64-bit Windows." /SD IDOK
    Abort
  ${EndIf}
  SetRegView 64
  SetShellVarContext all
FunctionEnd

; the finish page's "Start Latch": through Explorer, so the app runs as the user, not elevated like this installer
Function LaunchUnelevated
  Exec '"$WINDIR\explorer.exe" "$INSTDIR\${MAINEXE}"'
FunctionEnd

Section "Install"
  SetRegView 64
  SetShellVarContext all

  !insertmacro WAIT_UNLOCKED "$INSTDIR\${MAINEXE}" "Latch"
  !insertmacro WAIT_UNLOCKED "$INSTDIR\coredist\latch.exe" "A Latch download (Latch, or WAVdesk using it)"

  ; a clean coredist\ each install (the Tauri app's WebView2 profile stays: the app reads its settings from it once,
  ; then removes it: tauri_import.cpp)
  !insertmacro SAFE_RMDIR_R "$INSTDIR\coredist" "\${PRODUCT}\coredist"

  SetOutPath "$INSTDIR"
  File /r "${STAGE}\*.*"
  !ifdef FFMPEG
    SetOutPath "$INSTDIR\resources\ffmpeg"
    File /r "${FFMPEG}\*.*"
    SetOutPath "$INSTDIR"
  !endif
  WriteUninstaller "$INSTDIR\uninstall.exe"

  ; the suite's shared folder and Latch's managed bin (the yt-dlp it downloads and self-updates), writable by the
  ; unelevated app: BUILTIN\Users by SID (locale-independent), inherited, Modify
  ReadEnvStr $0 "ProgramData"
  ${If} $0 != ""
    CreateDirectory "$0\Vacant Systems\Shared"
    nsExec::ExecToLog 'icacls "$0\Vacant Systems\Shared" /grant *S-1-5-32-545:(OI)(CI)M /T'
    CreateDirectory "$0\Vacant Systems\Latch\bin"
    nsExec::ExecToLog 'icacls "$0\Vacant Systems\Latch" /grant *S-1-5-32-545:(OI)(CI)M /T'
  ${EndIf}

  ; shortcuts made anew, so Explorer re-reads the icon (a kept .lnk keeps a stale cached one)
  CreateDirectory "${STARTMENU}"
  Delete "${STARTMENU}\${PRODUCT}.lnk"
  CreateShortcut "${STARTMENU}\${PRODUCT}.lnk" "$INSTDIR\${MAINEXE}" "" "$INSTDIR\${MAINEXE}" 0
  Delete "$DESKTOP\${PRODUCT}.lnk"
  CreateShortcut "$DESKTOP\${PRODUCT}.lnk" "$INSTDIR\${MAINEXE}" "" "$INSTDIR\${MAINEXE}" 0

  WriteRegStr HKLM "${DIR_KEY}" "" "$INSTDIR"
  WriteRegStr HKLM "${UNINST_KEY}" "DisplayName" "${PRODUCT}"
  WriteRegStr HKLM "${UNINST_KEY}" "DisplayIcon" '"$INSTDIR\${MAINEXE}"'
  WriteRegStr HKLM "${UNINST_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKLM "${UNINST_KEY}" "Publisher" "${PUBLISHER}"
  WriteRegStr HKLM "${UNINST_KEY}" "InstallLocation" '"$INSTDIR"'
  WriteRegStr HKLM "${UNINST_KEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr HKLM "${UNINST_KEY}" "QuietUninstallString" '"$INSTDIR\uninstall.exe" /S'
  WriteRegStr HKLM "${UNINST_KEY}" "MainBinaryName" "${MAINEXE}"
  WriteRegDWORD HKLM "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKLM "${UNINST_KEY}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKLM "${UNINST_KEY}" "EstimatedSize" "$0"

  nsExec::ExecToLog 'ie4uinit.exe -show'
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
SectionEnd

; ---- uninstall ----

Var DeleteData
Var DeleteDataBox

Function un.onInit
  SetRegView 64
  SetShellVarContext all
  StrCpy $DeleteData 0
FunctionEnd

Function un.DataPage
  !insertmacro MUI_HEADER_TEXT "Your settings" "Latch keeps its settings and its log in your user folder."
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateLabel} 0 0 100% 36u "Your downloads and clips are never touched. Leave the box clear to keep Latch's settings for a later install."
  Pop $0
  ${NSD_CreateCheckbox} 0 44u 100% 12u "Also delete Latch's settings and log"
  Pop $DeleteDataBox
  nsDialogs::Show
FunctionEnd

Function un.DataPageLeave
  ${NSD_GetState} $DeleteDataBox $DeleteData
FunctionEnd

Section "Uninstall"
  !insertmacro WAIT_UNLOCKED "$INSTDIR\${MAINEXE}" "Latch"
  !insertmacro WAIT_UNLOCKED "$INSTDIR\coredist\latch.exe" "A Latch download (Latch, or WAVdesk using it)"

  Delete "${STARTMENU}\${PRODUCT}.lnk"
  RMDir "${STARTMENU}"
  Delete "$DESKTOP\${PRODUCT}.lnk"

  !insertmacro SAFE_RMDIR_R "$INSTDIR" "\${PRODUCT}"
  DeleteRegKey HKLM "${UNINST_KEY}"
  DeleteRegKey HKLM "${DIR_KEY}"
  DeleteRegKey /ifempty HKLM "Software\vacantsystems"

  ; the last Vacant Systems app out takes the suite's Shared folders with it
  StrCpy $2 "1"
  ${If} ${FileExists} "$PROGRAMFILES64\Vacant Systems\WAVdesk\wavdesk.exe"
    StrCpy $2 "0"
  ${EndIf}
  ${If} ${FileExists} "$PROGRAMFILES64\Vacant Systems\Lathe\lathe-gui.exe"
    StrCpy $2 "0"
  ${EndIf}

  ; ProgramData: Latch's own (its managed yt-dlp) always, Shared only when last out
  ReadEnvStr $0 "ProgramData"
  ${If} $0 != ""
    !insertmacro SAFE_RMDIR_R "$0\Vacant Systems\Latch" "\Vacant Systems\Latch"
    ${If} $2 == "1"
      !insertmacro SAFE_RMDIR_R "$0\Vacant Systems\Shared" "\Vacant Systems\Shared"
    ${EndIf}
    RMDir "$0\Vacant Systems"
  ${EndIf}

  ; the user's data only when asked (the shared cookies are logins: last one out and asked)
  ReadEnvStr $1 "LOCALAPPDATA"
  ${If} $1 != ""
    !insertmacro SAFE_RMDIR_R "$1\com.vacantsystems.latch" "\com.vacantsystems.latch"   ; (a Tauri webview profile never imported)
  ${EndIf}
  ${If} $1 != ""
  ${AndIf} $DeleteData == ${BST_CHECKED}
    !insertmacro SAFE_RMDIR_R "$1\Vacant Systems\Latch" "\Vacant Systems\Latch"
    ${If} $2 == "1"
      !insertmacro SAFE_RMDIR_R "$1\Vacant Systems\Shared" "\Vacant Systems\Shared"
    ${EndIf}
    RMDir "$1\Vacant Systems"
  ${EndIf}

  RMDir "$PROGRAMFILES64\Vacant Systems"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
SectionEnd
