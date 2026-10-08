'use strict';

/**
 * Electron "de mentira" — só o suficiente pra carregar o main.js com `node` puro, sem o Electron
 * instalado (ver test/desktop-smoke.js). Os diálogos nativos respondem com caminhos configuráveis
 * via `stub.proximoSalvar` / `stub.proximoAbrir`; o `printToPDF` devolve um PDF falso.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const pastaUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'estoque-desktop-'));

const handlers = {};
const stub = {
  handlers,
  pastaUserData,
  proximoSalvar: null, // caminho devolvido pelo próximo showSaveDialog (null = cancelar)
  proximoAbrir: null, // caminho devolvido pelo próximo showOpenDialog (null = cancelar)
  ultimoHtmlPdf: null,
};

class BrowserWindow {
  constructor() {
    this.webContents = {
      printToPDF: async () => Buffer.from('%PDF-1.4 falso'),
    };
  }
  static getAllWindows() { return []; }
  setMenuBarVisibility() {}
  loadFile() {}
  async loadURL(url) {
    stub.ultimoHtmlPdf = decodeURIComponent(String(url).replace(/^data:text\/html;charset=UTF-8,/, ''));
  }
  isMinimized() { return false; }
  restore() {}
  show() {}
  focus() {}
  destroy() {}
}

module.exports = {
  __stub: stub,
  app: {
    whenReady: () => Promise.resolve(),
    on() {},
    quit() {},
    getPath: () => pastaUserData,
  },
  BrowserWindow,
  ipcMain: {
    handle(canal, fn) { handlers[canal] = fn; },
  },
  dialog: {
    async showSaveDialog() {
      const caminho = stub.proximoSalvar;
      stub.proximoSalvar = null;
      return caminho ? { canceled: false, filePath: caminho } : { canceled: true };
    },
    async showOpenDialog() {
      const caminho = stub.proximoAbrir;
      stub.proximoAbrir = null;
      return caminho ? { canceled: false, filePaths: [caminho] } : { canceled: true, filePaths: [] };
    },
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s) => Buffer.from(s, 'utf8'),
    decryptString: (b) => b.toString('utf8'),
  },
};
