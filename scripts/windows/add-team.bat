@echo off
setlocal
rem ============================================================
rem  CiCy Desktop - add a team by deeplink
rem
rem  Usage:
rem    add-team.bat                     -> uses the values below
rem    add-team.bat <url> [title] [token]
rem
rem  Works with the installed CiCy Desktop (registers cicy-desktop://).
rem  If the app is not running it is launched; if it is running the
rem  team is added to the running instance. No login is required:
rem  the team is stored locally (teams.json) and appears in "我的团队".
rem ============================================================

rem ---- defaults (edit these before distributing) ----
set "TEAM_URL=http://127.0.0.1:8008"
set "TEAM_TITLE=My Team"
set "TEAM_TOKEN="

if not "%~1"=="" set "TEAM_URL=%~1"
if not "%~2"=="" set "TEAM_TITLE=%~2"
if not "%~3"=="" set "TEAM_TOKEN=%~3"

rem URL-encode the pieces with PowerShell (handles spaces, Chinese, & etc.)
for /f "usebackq delims=" %%E in (`powershell -NoProfile -Command "[uri]::EscapeDataString('%TEAM_URL%')"`)   set "ENC_URL=%%E"
for /f "usebackq delims=" %%E in (`powershell -NoProfile -Command "[uri]::EscapeDataString('%TEAM_TITLE%')"`) set "ENC_TITLE=%%E"
set "ENC_TOKEN="
if not "%TEAM_TOKEN%"=="" for /f "usebackq delims=" %%E in (`powershell -NoProfile -Command "[uri]::EscapeDataString('%TEAM_TOKEN%')"`) set "ENC_TOKEN=%%E"

set "LINK=cicy-desktop://addTeam?title=%ENC_TITLE%&url=%ENC_URL%"
if not "%ENC_TOKEN%"=="" set "LINK=%LINK%&token=%ENC_TOKEN%"

echo Adding team "%TEAM_TITLE%" (%TEAM_URL%) ...
start "" "%LINK%"
if errorlevel 1 (
  echo Failed to open %LINK%
  echo Is CiCy Desktop installed? ^(it registers the cicy-desktop:// protocol on first launch^)
  pause
  exit /b 1
)
echo Done. The team will show up in CiCy Desktop ^> 我的团队.
endlocal
