@echo off
REM Myrient Download Manager - Installer Wrapper
REM Este archivo ejecuta el script de PowerShell

setlocal enabledelayedexpansion

REM Verificar que PowerShell está disponible
where /q powershell
if errorlevel 1 (
    echo Error: PowerShell no está disponible en tu sistema
    pause
    exit /b 1
)

REM Obtener la ruta del script PS1
set SCRIPT_PATH=%~dp0Install.ps1

REM Ejecutar el script con permisos elevados
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process powershell -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File ""%SCRIPT_PATH%""' -Verb RunAs -Wait"

exit /b %ERRORLEVEL%
