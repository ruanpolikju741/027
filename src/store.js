'use strict';

/**
 * Persistência local criptografada.
 *
 * Estratégia:
 *  - Uma chave AES-256 aleatória é gerada na primeira execução.
 *  - Essa chave é protegida com `safeStorage` do Electron (usa o cofre do
 *    Windows/DPAPI, Keychain no macOS, ou libsecret no Linux) e salva em
 *    "chave.protegida".
 *  - Todos os dados do app (itens, usuários, transações, login do admin)
 *    ficam num único arquivo "dados.criptografado", cifrado com essa chave
 *    via AES-256-GCM (src/crypto-utils.js). Ou seja: nada fica em texto
 *    puro no disco.
 */

const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');
const cryptoUtils = require('./crypto-utils');
const logic = require('./logic');
const { migrar } = require('./migracao');

const NOME_PASTA_APP = 'ControleEstoqueDados';
const ARQ_CHAVE = 'chave.protegida';
const ARQ_DADOS = 'dados.criptografado';
const ARQ_DADOS_BACKUP = 'dados.criptografado.bak';

function pastaDados() {
  // userData já é isolado por usuário do Windows/macOS/Linux.
  const base = path.join(app.getPath('userData'), NOME_PASTA_APP);
  if (!fs.existsSync(base)) {
    fs.mkdirSync(base, { recursive: true });
  }
  return base;
}

function caminhoChave() {
  return path.join(pastaDados(), ARQ_CHAVE);
}

function caminhoDados() {
  return path.join(pastaDados(), ARQ_DADOS);
}

function caminhoBackup() {
  return path.join(pastaDados(), ARQ_DADOS_BACKUP);
}

function obterOuCriarChave() {
  const arqChave = caminhoChave();

  if (fs.existsSync(arqChave)) {
    const protegido = fs.readFileSync(arqChave);
    if (safeStorage.isEncryptionAvailable()) {
      const base64 = safeStorage.decryptString(protegido);
      return Buffer.from(base64, 'base64');
    }
    // Fallback (não deveria ocorrer no Windows): trata o conteúdo como a
    // própria chave em base64, para não travar o app em ambientes sem
    // cofre de credenciais disponível.
    return Buffer.from(protegido.toString('utf8'), 'base64');
  }

  const novaChave = cryptoUtils.gerarChaveAes();
  const base64 = novaChave.toString('base64');
  let paraSalvar;
  if (safeStorage.isEncryptionAvailable()) {
    paraSalvar = safeStorage.encryptString(base64);
  } else {
    paraSalvar = Buffer.from(base64, 'utf8');
  }
  fs.writeFileSync(arqChave, paraSalvar, { mode: 0o600 });
  return novaChave;
}

let chaveEmMemoria = null;

function obterChave() {
  if (!chaveEmMemoria) {
    chaveEmMemoria = obterOuCriarChave();
  }
  return chaveEmMemoria;
}

/** Carrega os dados do disco, criando a base inicial se for a 1ª execução. */
function carregarDados() {
  const chave = obterChave();
  const arqDados = caminhoDados();

  if (!fs.existsSync(arqDados)) {
    const dadosIniciais = logic.criarDadosIniciais();
    salvarDados(dadosIniciais);
    return dadosIniciais;
  }

  try {
    const payload = fs.readFileSync(arqDados, 'utf8');
    return migrar(cryptoUtils.descriptografarJSON(payload, chave));
  } catch (erro) {
    // Tenta recuperar do backup mais recente antes de desistir.
    if (fs.existsSync(caminhoBackup())) {
      try {
        const payloadBackup = fs.readFileSync(caminhoBackup(), 'utf8');
        return migrar(cryptoUtils.descriptografarJSON(payloadBackup, chave));
      } catch (erroBackup) {
        // segue para o erro original abaixo
      }
    }
    throw new Error(
      'Não foi possível ler os dados criptografados locais. O arquivo pode estar corrompido.'
    );
  }
}

/** Salva os dados no disco, cifrados, mantendo um backup da versão anterior. */
function salvarDados(data) {
  const chave = obterChave();
  const arqDados = caminhoDados();

  if (fs.existsSync(arqDados)) {
    try {
      fs.copyFileSync(arqDados, caminhoBackup());
    } catch (_) {
      /* backup é best-effort */
    }
  }

  const payload = cryptoUtils.criptografarJSON(data, chave);
  const arqTemp = arqDados + '.tmp';
  fs.writeFileSync(arqTemp, payload, { mode: 0o600 });
  fs.renameSync(arqTemp, arqDados);
}

module.exports = {
  carregarDados,
  salvarDados,
  pastaDados,
};
