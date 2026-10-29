@echo off
setlocal enabledelayedexpansion
title HANA-Lens Build

set JAVA_SRC=java\src\com\sap\hanasupportinfo
set WEB_SRC=src
set OUT=out
set PORTABLE=portable
set JAR_NAME=HANA-Lens.jar

echo.
echo ====================================================
echo  HANA-Lens Build  (Windows)
echo ====================================================
echo.

:: ── Step 1: Compile Java ────────────────────────────────────────────────────
echo [1/4] Compiling Java sources...
if exist "%OUT%" rmdir /S /Q "%OUT%"
mkdir "%OUT%"

javac -source 8 -target 8 ^
  -XDignore.symbol.file ^
  -d "%OUT%" ^
  %JAVA_SRC%\Json.java ^
  %JAVA_SRC%\TraceIndex.java ^
  %JAVA_SRC%\Commands.java ^
  %JAVA_SRC%\HanaLensServer.java ^
  %JAVA_SRC%\Main.java

if errorlevel 1 (
    echo   ERROR: Compilation failed.
    exit /b 1
)
echo   OK.

:: ── Step 2: Bundle web resources ─────────────────────────────────────────────
echo.
echo [2/4] Bundling web resources...
xcopy /E /I /Y /Q "%WEB_SRC%" "%OUT%\web" >nul
echo   OK.

:: ── Step 3: Create JAR ────────────────────────────────────────────────────────
echo.
echo [3/4] Creating %JAR_NAME%...
if exist "%JAR_NAME%" del "%JAR_NAME%"
jar cfm "%JAR_NAME%" java\manifest.txt -C "%OUT%" .
if errorlevel 1 (
    echo   ERROR: JAR creation failed.
    exit /b 1
)
echo   OK.

:: ── Step 4: Copy to portable/ ─────────────────────────────────────────────────
echo.
echo [4/4] Updating portable\ folder...
if not exist "%PORTABLE%" mkdir "%PORTABLE%"
copy /Y "%JAR_NAME%" "%PORTABLE%\%JAR_NAME%" >nul
echo   OK.

echo.
echo ====================================================
echo  Build successful: %JAR_NAME%
echo.
echo  Run with:  java -jar %JAR_NAME%
echo  Portable:  portable\%JAR_NAME%
echo ====================================================
echo.
endlocal
