@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title Publicar o Controle de Estoque no GitHub
echo ==============================================================
echo   Publicar o Controle de Estoque no seu GitHub
echo ==============================================================
echo.
where git >nul 2>nul
if errorlevel 1 (
  echo O Git nao esta instalado neste computador.
  echo Baixe e instale em: https://git-scm.com/download/win
  echo Depois rode este arquivo de novo.
  echo.
  pause
  exit /b 1
)

if exist ".git" goto :ja_existe

echo Antes de continuar, crie um repositorio VAZIO e PRIVADO em:
echo   https://github.com/new
echo (NAO marque "Add a README file").
echo.
set /p REPO=Cole aqui o endereco do repositorio (ex.: https://github.com/SEU_USUARIO/controle-estoque.git): 
if "%REPO%"=="" goto :fim
git init -b main
git remote add origin "%REPO%"
goto :identidade

:ja_existe
echo Este projeto ja esta ligado a um repositorio - vou enviar as mudancas.
echo.

:identidade
git config user.email >nul 2>nul
if not errorlevel 1 goto :enviar
echo O Git precisa de um nome e e-mail para registrar o envio (fica so neste projeto).
set /p NOME_GIT=Seu nome: 
set /p EMAIL_GIT=Seu e-mail do GitHub: 
git config user.name "%NOME_GIT%"
git config user.email "%EMAIL_GIT%"

:enviar
REM Se o GitHub ja tem historico (ex.: a pasta foi extraida de novo, sem o .git antigo),
REM encaixa esta pasta em cima dele em vez de brigar com ele. Nao apaga nada do GitHub:
REM so registra os arquivos desta pasta como a versao mais nova.
git fetch origin >nul 2>nul
git rev-parse --verify --quiet origin/main >nul 2>nul
if errorlevel 1 goto :commit
git merge-base --is-ancestor origin/main HEAD >nul 2>nul
if not errorlevel 1 goto :commit
git reset --soft origin/main
:commit
git add -A
git commit -m "Atualiza o Controle de Estoque" >nul 2>nul
git push -u origin main
if errorlevel 1 (
  echo.
  echo Nao foi possivel enviar. Confira o endereco do repositorio e se voce
  echo entrou na sua conta do GitHub na janela que abriu.
  echo.
  pause
  exit /b 1
)
echo.
echo Pronto! Codigo enviado para o GitHub.
echo Se for a primeira vez: siga para o Supabase e o Render
echo (secao "Versao web" do README.md).
:fim
echo.
pause
