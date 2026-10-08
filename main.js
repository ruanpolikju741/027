'use strict';

/**
 * Processo principal do app DESKTOP (Electron). Toda a regra de cada ação da interface (login,
 * catálogo, histórico, pendências, relatórios, backup…) fica em src/handlers.js — a mesma tabela
 * usada pela versão web (web/server.js). Aqui fica só o que é próprio do desktop:
 *  - a janela;
 *  - os dados num arquivo local criptografado (src/store.js);
 *  - os diálogos nativos de "Salvar como"/"Abrir" e o `printToPDF` do Electron;
 *  - uma única sessão de login (o app inteiro), que vive só na memória deste processo — nunca no
 *    renderer, pra que a troca de perfil não possa ser forjada pela interface.
 */

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const store = require('./src/store');
const logic = require('./src/logic');
const { criarHandlers, executar, novaSessao } = require('./src/handlers');

/** A sessão do app (uma só no desktop). Nasce deslogada: o login é obrigatório toda vez que abre. */
const sessao = novaSessao();

let dadosCache = null;
let janelaPrincipal = null;

function carregar() {
  if (!dadosCache) {
    dadosCache = store.carregarDados();
  }
  return dadosCache;
}

function persistir(novoData) {
  dadosCache = novoData;
  store.salvarDados(dadosCache);
}

/**
 * Traz a janela pra frente antes de um diálogo nativo — em alguns ambientes Windows, um diálogo
 * pedido por uma janela sem foco abre por trás dela (ou minimizado na barra de tarefas), dando a
 * impressão de que "não aconteceu nada".
 */
function focarJanela() {
  if (!janelaPrincipal) return;
  if (janelaPrincipal.isMinimized()) janelaPrincipal.restore();
  janelaPrincipal.show();
  janelaPrincipal.focus();
}

/** Gera o PDF a partir do HTML (numa janela escondida) e grava onde a pessoa escolher. */
async function salvarPdf(html, { titulo, nomeArquivo }) {
  focarJanela();
  const resultado = await dialog.showSaveDialog(janelaPrincipal, {
    title: titulo,
    defaultPath: nomeArquivo,
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (resultado.canceled || !resultado.filePath) return { ok: false, cancelado: true };

  const janelaPdf = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  try {
    await janelaPdf.loadURL('data:text/html;charset=UTF-8,' + encodeURIComponent(html));
    // Margens em polegadas (unidade que essa opção do Electron espera); a regra `@page` do HTML
    // fica só como reforço visual.
    const bufferPdf = await janelaPdf.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      margins: { top: 0.63, bottom: 0.63, left: 0.55, right: 0.55 },
    });
    fs.writeFileSync(resultado.filePath, bufferPdf);
  } catch (erro) {
    return { ok: false, erro: 'Não foi possível gerar o PDF: ' + erro.message };
  } finally {
    janelaPdf.destroy();
  }
  return { ok: true, caminho: resultado.filePath };
}

async function salvarBackup(conteudo, { nomeArquivo }) {
  focarJanela();
  const resultado = await dialog.showSaveDialog(janelaPrincipal, {
    title: 'Exportar backup do Controle de Estoque',
    defaultPath: nomeArquivo,
    filters: [{ name: 'Backup do Controle de Estoque', extensions: ['estoquebkp'] }],
  });
  if (resultado.canceled || !resultado.filePath) return { ok: false, cancelado: true };
  fs.writeFileSync(resultado.filePath, conteudo, 'utf8');
  return { ok: true, caminho: resultado.filePath };
}

async function lerBackup() {
  focarJanela();
  const resultado = await dialog.showOpenDialog(janelaPrincipal, {
    title: 'Importar backup do Controle de Estoque',
    properties: ['openFile'],
    filters: [{ name: 'Backup do Controle de Estoque', extensions: ['estoquebkp', 'json'] }],
  });
  if (resultado.canceled || !resultado.filePaths[0]) return { ok: false, cancelado: true };
  try {
    return { ok: true, conteudo: fs.readFileSync(resultado.filePaths[0], 'utf8') };
  } catch (erro) {
    return { ok: false, erro: 'Não foi possível ler o arquivo selecionado (formato inválido).' };
  }
}

const handlers = criarHandlers({
  carregar,
  persistir,
  salvarPdf,
  salvarBackup,
  lerBackup,
  // No desktop a tela de "criar login de Admin" só existe na primeira execução de verdade — nem
  // uma importação total (que zera o Admin) a reabre.
  podeConfigurarAdmin: (data) => logic.precisaConfigurarLoginInicial(data),
});

for (const canal of Object.keys(handlers)) {
  ipcMain.handle(canal, (_evento, ...args) => executar(handlers, canal, sessao, args));
}

function criarJanela() {
  janelaPrincipal = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'Controle de Estoque',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  janelaPrincipal.setMenuBarVisibility(false);
  janelaPrincipal.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  carregar();
  criarJanela();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) criarJanela();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
