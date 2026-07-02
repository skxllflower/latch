; Vacant Systems NSIS installer hooks, hooked into Tauri's installer.nsi.
;
; PREINSTALL: default the install dir into the publisher subfolder
;   Program Files\Vacant Systems\<App> -- but ONLY when $INSTDIR is still
;   Tauri's perMachine default ($PROGRAMFILES64\<ProductName>), so a user-chosen
;   custom location on the directory page is preserved.
;
; POSTINSTALL: create the machine-wide shared data dir and grant Users Modify,
;   so the unelevated apps can fetch ffmpeg/yt-dlp and write registry.json into
;   ProgramData\Vacant Systems\Shared at runtime.
;
; POSTUNINSTALL: remove this app's Vacant Systems residue across Program Files,
;   ProgramData and LocalAppData, and — only when this is the last Vacant Systems
;   app on the machine — the Shared subtree and the vendor roots. Never touches
;   anything outside the Vacant Systems trees.

; SAFE_RMDIR_R <path> <suffix>: recursive delete, guarded against the classic
; NSIS empty-variable + /r disk-wipe footgun. Only fires when the runtime path is
; non-empty AND ends with <suffix>. Callers must also verify the base env var is
; non-empty before building <path> from it (belt and suspenders).
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

!macro NSIS_HOOK_PREINSTALL
  ${If} $INSTDIR == "$PROGRAMFILES64\${PRODUCTNAME}"
    StrCpy $INSTDIR "$PROGRAMFILES64\Vacant Systems\${PRODUCTNAME}"
    ; Tauri already ran `SetOutPath $INSTDIR` against the OLD default before this
    ; hook, and every `File` uses /oname relative to the output dir. So re-point
    ; the output dir to the redirected $INSTDIR (else File writes target the old
    ; dir while CreateDirectory makes the new one -> "can't write"), then drop
    ; the now-empty default dir SetOutPath created.
    SetOutPath "$INSTDIR"
    RMDir "$PROGRAMFILES64\${PRODUCTNAME}"
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ReadEnvStr $0 "ProgramData"
  CreateDirectory "$0\Vacant Systems\Shared"
  ; BUILTIN\Users = SID S-1-5-32-545 (locale-independent). (OI)(CI) = inherit to
  ; files + subdirs, M = Modify, /T = apply to the existing tree.
  nsExec::ExecToLog 'icacls "$0\Vacant Systems\Shared" /grant *S-1-5-32-545:(OI)(CI)M /T'

  ; Latch downloads + self-updates yt-dlp.exe into its own managed dir
  ; (%ProgramData%\Vacant Systems\Latch\bin); grant Users Modify there too, or
  ; the unelevated app can't write the binary and reports "yt-dlp.exe not found".
  CreateDirectory "$0\Vacant Systems\Latch\bin"
  nsExec::ExecToLog 'icacls "$0\Vacant Systems\Latch" /grant *S-1-5-32-545:(OI)(CI)M /T'

  ; Nuke + remake the app shortcuts so the shell re-reads the new exe icon
  ; (a reinstall otherwise keeps a stale cached shortcut icon). The explicit
  ; icon arg points each .lnk directly at the new exe icon.
  Delete "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
  CreateShortcut "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe" "" "$INSTDIR\${MAINBINARYNAME}.exe" 0
  Delete "$DESKTOP\${PRODUCTNAME}.lnk"
  CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe" "" "$INSTDIR\${MAINBINARYNAME}.exe" 0

  ; Refresh the shell icon cache + associations so the new app icon shows on
  ; shortcuts, the taskbar, and context menus (else a stale cache lingers).
  nsExec::ExecToLog 'ie4uinit.exe -show'
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; Vacant Systems residue cleanup. Skipped entirely during an in-place update
  ; ($UpdateMode) so an update never wipes data/binaries mid-swap. Every recursive
  ; delete is routed through SAFE_RMDIR_R (non-empty + expected-suffix guard) and
  ; every base var is verified non-empty before a path is built from it.
  ${If} $UpdateMode <> 1

    ; This app's own Program Files residue. Tauri's RMDir "$INSTDIR" is only-if-
    ; empty and never removes the "Vacant Systems" parent.
    !insertmacro SAFE_RMDIR_R "$INSTDIR" "\${PRODUCTNAME}"

    ; Last-one-out detection: is any SIBLING app still installed at its default
    ; publisher location? If none remain, this uninstall may remove Shared + roots.
    StrCpy $2 "1"
    ${If} ${FileExists} "$PROGRAMFILES64\Vacant Systems\WAVdesk\wavdesk.exe"
      StrCpy $2 "0"
    ${EndIf}
    ${If} ${FileExists} "$PROGRAMFILES64\Vacant Systems\Lathe\lathe-gui.exe"
      StrCpy $2 "0"
    ${EndIf}

    ; %ProgramData%\Vacant Systems. App-scoped data (incl. Latch\bin\yt-dlp.exe)
    ; always removed; Shared only when last-one-out.
    ReadEnvStr $0 "ProgramData"
    ${If} $0 != ""
      !insertmacro SAFE_RMDIR_R "$0\Vacant Systems\Latch" "\Vacant Systems\Latch"
      ${If} $2 == "1"
        !insertmacro SAFE_RMDIR_R "$0\Vacant Systems\Shared" "\Vacant Systems\Shared"
      ${EndIf}
      RMDir "$0\Vacant Systems"
    ${EndIf}

    ; %LOCALAPPDATA%\Vacant Systems. Per-app data only when the user ticked
    ; "delete app data"; shared cookies only when last-one-out AND that box is
    ; ticked (cookies are login credentials).
    ReadEnvStr $1 "LOCALAPPDATA"
    ${If} $1 != ""
      ${If} $DeleteAppDataCheckboxState = 1
        !insertmacro SAFE_RMDIR_R "$1\Vacant Systems\Latch" "\Vacant Systems\Latch"
      ${EndIf}
      ${If} $2 == "1"
      ${AndIf} $DeleteAppDataCheckboxState = 1
        !insertmacro SAFE_RMDIR_R "$1\Vacant Systems\Shared" "\Vacant Systems\Shared"
      ${EndIf}
      RMDir "$1\Vacant Systems"
    ${EndIf}

    ; Program Files vendor root: only-if-empty backstop.
    RMDir "$PROGRAMFILES64\Vacant Systems"

  ${EndIf}
!macroend
