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
