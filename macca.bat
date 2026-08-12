@echo off
chcp 65001 >nul
rem macca ワンクリック起動 (Windows)
rem ダブルクリックするとサーバが起動し、ブラウザが自動で開きます。
rem このウィンドウを閉じると macca は終了します。
cd /d "%~dp0"
where node >/dev/null 2>nul
if errorlevel 1 (
  echo Node.js が見つかりません。https://nodejs.org からインストールしてください。
  pause
  exit /b 1
)
node server.js --open --exit-on-close %*
pause
