@echo off
setlocal

echo ============================================
echo   Controle de Estoque - Testar (sem instalar)
echo ============================================
echo.
echo Isso abre o programa direto, sem gerar um instalador.
echo Bom para testar rapido depois de uma atualizacao.
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo O Node.js nao foi encontrado neste computador.
  start https://nodejs.org/
  pause
  exit /b 1
)

cd /d "%~dp0"

if not exist "node_modules" (
  echo Baixando as dependencias do projeto pela primeira vez...
  call npm install
  if errorlevel 1 (
    echo.
    echo ERRO ao instalar as dependencias. Veja a mensagem de erro acima.
    pause
    exit /b 1
  )
)

call npm start
