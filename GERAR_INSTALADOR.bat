@echo off
setlocal

echo ============================================
echo   Controle de Estoque - Gerar instalador
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo O Node.js nao foi encontrado neste computador.
  echo.
  echo Vou abrir o site oficial para voce baixar e instalar o Node.js LTS
  echo ^(so precisa fazer isso uma vez, e uma instalacao "next, next, finish"^).
  echo Depois de instalar, feche esta janela e clique de novo neste arquivo.
  echo.
  start https://nodejs.org/
  pause
  exit /b 1
)

cd /d "%~dp0"

if not exist "node_modules" (
  echo [1/2] Baixando as dependencias do projeto pela primeira vez ^(Electron etc^).
  echo       Isso pode demorar alguns minutos so na primeira vez.
  echo.
  call npm install
  if errorlevel 1 (
    echo.
    echo ERRO ao instalar as dependencias. Veja a mensagem de erro acima.
    pause
    exit /b 1
  )
) else (
  echo [1/2] Dependencias ja instaladas, pulando essa etapa.
)

echo.
echo [2/2] Gerando o instalador do Windows...
echo.
call npm run dist
if errorlevel 1 (
  echo.
  echo ERRO ao gerar o instalador. Veja a mensagem de erro acima.
  pause
  exit /b 1
)

echo.
echo ============================================
echo   Pronto! O instalador foi gerado em:
echo   %~dp0dist_installer
echo.
echo   E so abrir a pasta que vai abrir sozinha e clicar duas vezes
echo   no arquivo "...Setup....exe" para instalar o programa.
echo ============================================
echo.
start "" "%~dp0dist_installer"
pause
