; UNINSTALL MEANS GONE — not "files deleted, hotkey still answering".
;
; Tailzu lives in the tray with no window, so a running copy is easy to miss,
; and it holds the global hotkey for as long as it runs. It also registers
; itself to start at login (setLoginItemSettings), and that registry value
; outlives the uninstall. Both are cleaned here.
;
; electron-builder picks this file up from build/ (nsis.include).
;
; And the account: package.json sets nsis.deleteAppDataOnUninstall, so an
; uninstall removes %APPDATA%\Tailzu — session.json with it — and the next
; install starts signed out. electron-builder skips that on an update (the
; same isUpdated guard as below), so updating never signs anyone out.

; A FRESH INSTALL STARTS SIGNED OUT; AN UPDATE NEVER SIGNS ANYONE OUT.
;
; Running the site's installer where Tailzu is already installed is not an
; uninstall: electron-builder removes the old copy with --updated, which keeps
; app data, so downloading the same version again opened signed in to whoever
; used this PC last. But a NEWER version downloaded and run over an older one
; is an update, and must keep the account, exactly as "Update now" does.
;
; So the version decides. customInit runs before the old copy is removed and
; reads which version is installed. The account (session.json, in every
; folder name the uninstaller itself clears) is forgotten only when nothing
; was installed, or this same version was: a fresh install, or the same
; download run again. Any other version is an update and keeps it, and the
; app's own updater (--updated) always does. Settings stay either way.

!macro customInit
  Var /GLOBAL tailzuInstalledVersion
  ReadRegStr $tailzuInstalledVersion HKCU "${UNINSTALL_REGISTRY_KEY}" "DisplayVersion"
!macroend

!macro customInstall
  ${ifNot} ${isUpdated}
    ${if} $tailzuInstalledVersion == ""
    ${orIf} $tailzuInstalledVersion == "${VERSION}"
      Delete "$APPDATA\${APP_FILENAME}\session.json"
      !ifdef APP_PRODUCT_FILENAME
        Delete "$APPDATA\${APP_PRODUCT_FILENAME}\session.json"
      !endif
      !ifdef APP_PACKAGE_NAME
        Delete "$APPDATA\${APP_PACKAGE_NAME}\session.json"
      !endif
    ${endIf}
  ${endIf}
!macroend

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
