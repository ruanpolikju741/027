@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title Desinstalar o Controle de Estoque e apagar os dados

echo ==============================================================
echo   Controle de Estoque - Desinstalar e apagar todos os dados
echo ==============================================================
echo.
echo Isso faz uma LIMPEZA COMPLETA deste computador:
echo   1. Fecha o programa, se estiver aberto.
echo   2. Desinstala o Controle de Estoque, se ele estiver instalado
echo      ^(abre o desinstalador oficial do Windows^).
echo   3. Apaga TODOS os dados salvos localmente ^(itens, usuarios,
echo      historico, pendencias, login do Admin^), para que uma
echo      proxima instalacao comece do zero, como se fosse a primeira vez.
echo.
echo ATENCAO: o passo 3 NAO PODE SER DESFEITO. Se quiser guardar os
echo dados atuais, abra o programa agora, va na aba "Backup" e exporte
echo um arquivo .estoquebkp antes de continuar.
echo.
echo Arquivos de backup que voce ja exportou ^(.estoquebkp^) NAO sao
echo apagados por este script - eles ficam onde voce salvou.
echo.
set /p CONFIRMA=Para confirmar, digite APAGAR e pressione Enter:
if /i not "%CONFIRMA%"=="APAGAR" (
  echo.
  echo Cancelado. Nada foi alterado.
  echo.
  pause
  exit /b 0
)

where powershell >nul 2>nul
if errorlevel 1 (
  echo.
  echo O PowerShell nao foi encontrado neste computador, entao nao consigo
  echo localizar e apagar a pasta de dados automaticamente.
  echo.
  echo Feche o Controle de Estoque e apague manualmente esta pasta
  echo ^(e tudo dentro dela^):
  echo   %%APPDATA%%\Controle de Estoque
  echo Se essa pasta nao existir, procure uma pasta parecida dentro de
  echo   %%APPDATA%%
  echo que tenha, dentro dela, uma pasta chamada "ControleEstoqueDados".
  echo.
  pause
  exit /b 1
)

echo.
echo [1/3] Fechando o programa, se estiver aberto...
taskkill /F /IM "Controle de Estoque.exe" >nul 2>nul

echo [2/3] Procurando uma instalacao do Controle de Estoque neste computador...
powershell -NoProfile -Command ^
  "$ErrorActionPreference = 'SilentlyContinue';" ^
  "$chaves = @(" ^
  "  'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*'," ^
  "  'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*'," ^
  "  'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'" ^
  ");" ^
  "$achado = Get-ItemProperty -Path $chaves |" ^
  "  Where-Object { $_.DisplayName -eq 'Controle de Estoque' } |" ^
  "  Select-Object -First 1;" ^
  "if ($achado) { $achado.UninstallString } else { '' }" > "%TEMP%\ce_desinstalador.txt"
set "DESINSTALADOR="
set /p DESINSTALADOR=<"%TEMP%\ce_desinstalador.txt"
del /q "%TEMP%\ce_desinstalador.txt" >nul 2>nul

if not "%DESINSTALADOR%"=="" (
  echo       Encontrado. Abrindo o desinstalador oficial do Windows -
  echo       siga as instrucoes na janela que vai abrir.
  start "" /wait %DESINSTALADOR%
) else (
  echo       Nenhuma instalacao encontrada pelo Windows ^(normal se voce so
  echo       usou o "TESTAR_SEM_INSTALAR.bat", ou se ja desinstalou pelo
  echo       Painel de Controle^). Seguindo so para apagar os dados.
)

echo.
echo [3/3] Apagando os dados salvos localmente...
powershell -NoProfile -Command ^
  "$ErrorActionPreference = 'SilentlyContinue';" ^
  "$pasta = Get-ChildItem -Path $env:APPDATA -Directory |" ^
  "  Where-Object { Test-Path (Join-Path $_.FullName 'ControleEstoqueDados') } |" ^
  "  Select-Object -First 1;" ^
  "if ($pasta) {" ^
  "  Remove-Item -LiteralPath $pasta.FullName -Recurse -Force;" ^
  "  $pasta.FullName" ^
  "} else { '' }" > "%TEMP%\ce_dados_apagados.txt"
set "PASTA_APAGADA="
set /p PASTA_APAGADA=<"%TEMP%\ce_dados_apagados.txt"
del /q "%TEMP%\ce_dados_apagados.txt" >nul 2>nul

echo.
echo ==============================================================
if not "%PASTA_APAGADA%"=="" (
  echo   Pronto. Todos os dados foram apagados de:
  echo   %PASTA_APAGADA%
) else (
  echo   Nenhum dado local foi encontrado - este computador ja estava limpo.
)
echo.
echo   Pode instalar o Controle de Estoque de novo quando quiser: ele vai
echo   abrir pedindo pra criar o Admin, como se fosse a primeira vez.
echo ==============================================================
echo.
pause
