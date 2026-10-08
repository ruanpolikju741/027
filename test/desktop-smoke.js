'use strict';

/**
 * Teste de fumaça do app DESKTOP (main.js) sem precisar do Electron: carrega o main.js com um
 * Electron de mentira (test/stubs/electron.js), chama os canais de IPC na mesma ordem em que a
 * interface chamaria e confere os resultados mais importantes. Rode com:
 *   node test/desktop-smoke.js
 * Opcional: `--gravar arquivo.json` grava todas as respostas (normalizadas) e
 * `--comparar arquivo.json` compara com uma gravação anterior — útil pra garantir que uma
 * refatoração não mudou o comportamento de nenhum canal.
 */

const assert = require('assert');
const Module = require('module');
const path = require('path');
const fs = require('fs');

const caminhoStub = path.join(__dirname, 'stubs', 'electron.js');
const resolverOriginal = Module._resolveFilename;
Module._resolveFilename = function (pedido, ...resto) {
  if (pedido === 'electron') return caminhoStub;
  return resolverOriginal.call(this, pedido, ...resto);
};

const electron = require('electron');
const stub = electron.__stub;
require('../main.js');

const registro = [];
function normalizar(valor) {
  return JSON.parse(
    JSON.stringify(valor === undefined ? null : valor)
      .replace(/"[a-z]+_[a-z0-9]+_[0-9a-f]{8}"/g, '"<id>"')
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, '<ts>')
      .replace(/\d{4}-\d{2}-\d{2}/g, '<dia>')
      .replace(new RegExp(stub.pastaUserData.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '<tmp>')
  );
}

async function chamar(canal, ...args) {
  const fn = stub.handlers[canal];
  assert.ok(fn, `canal não registrado: ${canal}`);
  const res = await fn({}, ...args);
  registro.push({ canal, res: normalizar(res) });
  return res;
}

const arq = (nome) => path.join(stub.pastaUserData, nome);

(async () => {
  // Sem sessão: só os canais de login funcionam.
  assert.strictEqual(await chamar('auth:getPerfil'), null);
  assert.strictEqual((await chamar('items:list')).ok, false);
  assert.strictEqual(await chamar('auth:precisaConfigurarLogin'), true);

  // Primeiro acesso → Admin.
  const cfg = await chamar('auth:configurarLoginInicial', { usuario: 'admin', senha: 'segredo1' });
  assert.strictEqual(cfg.ok, true);
  assert.strictEqual(await chamar('auth:getPerfil'), 'admin');
  assert.strictEqual(await chamar('auth:precisaConfigurarLogin'), false);

  const item = await chamar('items:add', { nome: 'Água', quantidade: 10, foto: 'data:image/png;base64,iVBORw0KGgo=' });
  assert.strictEqual(item.ok, true);
  const itemId = item.item.id;
  await chamar('items:definirPreco', { itemId, preco: 2.5 });
  const usr = await chamar('usuarios:add', { nome: 'Maria', telefone: '27999990000' });
  const usuarioId = usr.usuario.id;
  await chamar('items:adjust', {
    itemId, tipo: 'saida', quantidade: 2, usuarioId, tipoEntrega: 'entrega', pendente: true,
  });
  await chamar('lancamentos:adicionar', { usuarioId, valor: 7, observacao: 'Taxa' });
  await chamar('pagamentos:adicionar', { usuarioId, valor: 3, observacao: 'Pix' });
  await chamar('items:list');
  await chamar('usuarios:list');
  await chamar('pendencias:listarUsuarios');
  await chamar('pendencias:detalharUsuario', usuarioId);
  await chamar('pendencias:listarQuitados');
  await chamar('pendencias:totalizar');
  await chamar('precificacao:listar');
  await chamar('historico:listDias');
  await chamar('historico:listarPeriodo', { dataInicio: null, dataFim: null });
  await chamar('historico:listarLancamentosEPagamentosPeriodo', { dataInicio: null, dataFim: null });
  await chamar('consulta:porUsuario', { usuarioId, dataInicio: null, dataFim: null });
  await chamar('consulta:porItem', { itemId, dataInicio: null, dataFim: null });

  // Relatórios em PDF (diálogo cancelado e depois confirmado).
  assert.strictEqual((await chamar('relatorio:gerarPdfQuantidades')).cancelado, true);
  stub.proximoSalvar = arq('q.pdf');
  assert.strictEqual((await chamar('relatorio:gerarPdfQuantidades')).ok, true);
  assert.ok(fs.existsSync(arq('q.pdf')));
  stub.proximoSalvar = arq('p.pdf');
  assert.strictEqual((await chamar('relatorio:gerarPdfPedidos', { dataInicio: null, dataFim: null })).ok, true);
  stub.proximoSalvar = arq('pend.pdf');
  assert.strictEqual((await chamar('relatorio:gerarPdfPendenciaUsuario', { usuarioId })).ok, true);
  assert.ok(stub.ultimoHtmlPdf.includes('Maria'));
  stub.proximoSalvar = arq('c1.pdf');
  assert.strictEqual((await chamar('relatorio:gerarPdfConsulta', { modo: 'usuario', usuarioId })).ok, true);
  stub.proximoSalvar = arq('c2.pdf');
  assert.strictEqual((await chamar('relatorio:gerarPdfConsulta', { modo: 'item', itemId })).ok, true);

  // Contas de login do Default.
  const conta = await chamar('contasLogin:criar', { usuario: 'joao', senha: 'temp123' });
  assert.strictEqual(conta.ok, true);
  await chamar('contasLogin:listar');

  // Backup: exporta.
  stub.proximoSalvar = arq('b.estoquebkp');
  const exp = await chamar('backup:exportar', { senha: 'bkp1234' });
  assert.strictEqual(exp.ok, true);

  // Default: login com senha temporária → troca → movimenta → desfaz.
  await chamar('auth:logout');
  const lg = await chamar('auth:login', { usuario: 'joao', senha: 'temp123' });
  assert.strictEqual(lg.precisaTrocarSenha, true);
  assert.strictEqual((await chamar('items:list')).ok, false); // ainda sem sessão de verdade
  const tr = await chamar('auth:trocarSenhaPrimeiroAcesso', { contaId: lg.contaId, senhaAtual: 'temp123', novaSenha: 'nova123' });
  assert.strictEqual(tr.ok, true);
  assert.strictEqual(await chamar('auth:getPerfil'), 'default');
  assert.strictEqual((await chamar('items:add', { nome: 'X' })).ok, false); // só admin
  await chamar('items:adjust', { itemId, tipo: 'saida', quantidade: 1, usuarioId, tipoEntrega: 'retirada' });
  const info = await chamar('historico:desfazerInfo');
  assert.strictEqual(info.disponivel, true);
  assert.strictEqual((await chamar('historico:desfazerUltima')).ok, true);
  assert.strictEqual((await chamar('backup:importar', { senha: 'bkp1234', modo: 'mesclar' })).ok, false);

  // Escalada pra Admin e volta.
  assert.strictEqual((await chamar('auth:loginAdmin', { usuario: 'admin', senha: 'segredo1' })).ok, true);
  assert.strictEqual((await chamar('auth:logoutAdmin')).perfil, 'default');

  // Importação total: zera o Admin, desloga e não reabre o primeiro acesso.
  stub.proximoAbrir = arq('b.estoquebkp');
  const imp = await chamar('backup:importar', { senha: 'bkp1234', modo: 'total' });
  assert.strictEqual(imp.ok, true);
  assert.strictEqual(await chamar('auth:getPerfil'), null);
  assert.strictEqual(await chamar('auth:precisaConfigurarLogin'), false);
  assert.strictEqual((await chamar('auth:login', { usuario: 'admin', senha: 'segredo1' })).ok, false);
  // E ninguém consegue "recriar" o Admin chamando o canal direto.
  assert.strictEqual((await chamar('auth:configurarLoginInicial', { usuario: 'hacker', senha: 'hacker1' })).ok, false);

  const iGravar = process.argv.indexOf('--gravar');
  const iComparar = process.argv.indexOf('--comparar');
  if (iGravar > 0) fs.writeFileSync(process.argv[iGravar + 1], JSON.stringify(registro, null, 1));
  if (iComparar > 0) {
    const antes = JSON.parse(fs.readFileSync(process.argv[iComparar + 1], 'utf8'));
    assert.deepStrictEqual(registro, antes);
    console.log(`  OK  - ${registro.length} respostas idênticas à gravação anterior`);
  }
  console.log(`Desktop (main.js): ${registro.length} chamadas de IPC verificadas — tudo certo.`);
  fs.rmSync(stub.pastaUserData, { recursive: true, force: true });
})().catch((erro) => {
  console.error('FALHOU -', erro.stack || erro.message);
  fs.rmSync(stub.pastaUserData, { recursive: true, force: true });
  process.exit(1);
});
