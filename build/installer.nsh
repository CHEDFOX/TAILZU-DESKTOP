; UNINSTALL MEANS GONE — not "files deleted, hotkey still answering".
;
; Tailzu lives in the tray with no window, so a running copy is easy to miss,
; and it holds the global hotkey for as long as it runs. It also registers
; itself to start at login (setLoginItemSettings), and that registry value
; outlives the uninstall. Both are cleaned here.
;
; electron-builder picks this file up from build/ (nsis.include).

!macro customUnInit
  ; Before the files go: a copy still running would keep the hotkey, and
  ; its exe could not be deleted.
  nsExec::Exec 'taskkill /F /T /IM "${APP_EXECUTABLE_FILENAME}"'
!macroend

!macro customUnInstall
  ; Not on an update: the new version's installer runs this uninstaller
  ; first, and wiping start-at-login there would turn it off on every update.
  ${ifNot} ${isUpdated}
    nsExec::Exec 'taskkill /F /T /IM "${APP_EXECUTABLE_FILENAME}"'
    ; The login item's value name is the AppUserModelId (main.js sets
    ; space.tailzu.desktop); older Electron builds wrote electron.app.<name>.
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${APP_ID}"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "electron.app.${PRODUCT_NAME}"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCT_NAME}"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "${APP_ID}"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "electron.app.${PRODUCT_NAME}"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "${PRODUCT_NAME}"
  ${endIf}
!macroend
