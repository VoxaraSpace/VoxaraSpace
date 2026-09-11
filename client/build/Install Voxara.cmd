@echo off
rem Creates Start-menu and desktop shortcuts for Voxara.
rem Voxara runs from wherever you unzipped it — this does not move or copy
rem anything, so you can delete the folder to uninstall.

setlocal
set "APPDIR=%~dp0"
set "APPEXE=%APPDIR%Voxara.exe"

if not exist "%APPEXE%" (
  echo Could not find Voxara.exe next to this script.
  echo Run this from inside the unzipped Voxara folder.
  pause
  exit /b 1
)

echo Creating shortcuts for:
echo   %APPEXE%
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ws = New-Object -ComObject WScript.Shell;" ^
  "$start = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Voxara.lnk';" ^
  "$desk  = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Voxara.lnk';" ^
  "foreach ($p in @($start, $desk)) {" ^
  "  $s = $ws.CreateShortcut($p);" ^
  "  $s.TargetPath = '%APPEXE%';" ^
  "  $s.WorkingDirectory = '%APPDIR%';" ^
  "  $s.Description = 'Voxara chat';" ^
  "  $s.Save();" ^
  "  Write-Host ('  created ' + $p) }"

echo.
echo Done. Voxara is now in your Start menu and on your desktop.
echo To uninstall, delete those two shortcuts and this folder.
echo.
pause
