'use strict';

/**
 * Funções puras de criptografia/hashing, sem dependência do Electron.
 * Podem ser testadas isoladamente com `node` puro (ver test/run-logic-tests.js).
 */

const crypto = require('crypto');

const SCRYPT_KEYLEN = 64;
const AES_ALGO = 'aes-256-gcm';

/** Gera um salt aleatório em hex. */
function gerarSalt() {
  return crypto.randomBytes(16).toString('hex');
}

/** Gera uma chave AES-256 aleatória (Buffer de 32 bytes). */
function gerarChaveAes() {
  return crypto.randomBytes(32);
}

/** Faz hash de uma senha com scrypt + salt. Retorna hex string. */
function hashSenha(senha, salt) {
  return crypto.scryptSync(String(senha), salt, SCRYPT_KEYLEN).toString('hex');
}

/** Deriva uma chave AES-256 (32 bytes) a partir de uma senha e um salt — usada
 * para proteger arquivos de backup com uma senha escolhida pelo usuário
 * (diferente da chave interna do app, que fica presa ao Windows da máquina). */
function derivarChaveDeSenha(senha, salt) {
  return crypto.scryptSync(String(senha), salt, 32);
}

/** Compara senha em texto puro com hash armazenado, em tempo constante. */
function verificarSenha(senha, salt, hashArmazenado) {
  const hashCalculado = hashSenha(senha, salt);
  const a = Buffer.from(hashCalculado, 'hex');
  const b = Buffer.from(hashArmazenado, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Criptografa um objeto JS (via JSON.stringify) com AES-256-GCM.
 * Retorna uma string base64 contendo iv + authTag + ciphertext concatenados.
 */
function criptografarJSON(objeto, chave) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(AES_ALGO, chave, iv);
  const textoClaro = Buffer.from(JSON.stringify(objeto), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(textoClaro), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const payload = Buffer.concat([iv, authTag, ciphertext]);
  return payload.toString('base64');
}

/**
 * Descriptografa uma string base64 gerada por criptografarJSON, retornando o objeto original.
 */
function descriptografarJSON(payloadBase64, chave) {
  const payload = Buffer.from(payloadBase64, 'base64');
  const iv = payload.subarray(0, 12);
  const authTag = payload.subarray(12, 28);
  const ciphertext = payload.subarray(28);
  const decipher = crypto.createDecipheriv(AES_ALGO, chave, iv);
  decipher.setAuthTag(authTag);
  const textoClaro = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(textoClaro.toString('utf8'));
}

/**
 * Criptografa bytes quaisquer (ex.: uma foto) com AES-256-GCM. Devolve um Buffer com
 * iv (12) + authTag (16) + ciphertext — mesmo layout de `criptografarJSON`, só que sem base64.
 */
function criptografarBuffer(dados, chave) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(AES_ALGO, chave, iv);
  const ciphertext = Buffer.concat([cipher.update(dados), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

/** Desfaz `criptografarBuffer` (lança erro se a chave estiver errada ou os bytes adulterados). */
function descriptografarBuffer(payload, chave) {
  const decipher = crypto.createDecipheriv(AES_ALGO, chave, payload.subarray(0, 12));
  decipher.setAuthTag(payload.subarray(12, 28));
  return Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]);
}

/** Gera um id único simples (suficiente para uso local, sem colisão prática). */
function gerarId(prefixo) {
  return `${prefixo}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}

module.exports = {
  gerarSalt,
  gerarChaveAes,
  hashSenha,
  verificarSenha,
  derivarChaveDeSenha,
  criptografarJSON,
  descriptografarJSON,
  criptografarBuffer,
  descriptografarBuffer,
  gerarId,
};
