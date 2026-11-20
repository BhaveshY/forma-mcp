@echo off
rem Install or update Forma MCP for Codex. Pass -Uninstall to remove it.
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
exit /b %ERRORLEVEL%
