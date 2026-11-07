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

  // Conta promovida a Admin pelo Admin: entra direto como Admin, com o próprio nome.
  assert.strictEqual((await chamar('auth:loginAdmin', { usuario: 'admin', senha: 'segredo1' })).ok, true);
  assert.strictEqual((await chamar('contasLogin:definirAdmin', { contaId: lg.contaId, admin: false })).ok, false); // não tira o próprio
  await chamar('auth:logout');
  assert.strictEqual((await chamar('auth:login', { usuario: 'admin', senha: 'segredo1' })).ok, true);
  assert.strictEqual((await chamar('contasLogin:definirAdmin', { contaId: lg.contaId, admin: true })).ok, true);
  await chamar('auth:logout');
  const lgAdm = await chamar('auth:login', { usuario: 'joao', senha: 'nova123' });
  assert.strictEqual(lgAdm.perfil, 'admin');
  assert.strictEqual(lgAdm.usuarioAdmin, 'joao');
  assert.strictEqual((await chamar('auth:quemSou')).usuarioAdmin, 'joao');
  assert.strictEqual((await chamar('items:add', { nome: 'Do João' })).ok, true);
  assert.strictEqual((await chamar('contasLogin:definirAdmin', { contaId: lg.contaId, admin: false })).ok, false);
  await chamar('auth:logout');
  assert.strictEqual((await chamar('auth:login', { usuario: 'admin', senha: 'segredo1' })).ok, true);
  assert.strictEqual((await chamar('contasLogin:definirAdmin', { contaId: lg.contaId, admin: false })).ok, true);
  await chamar('auth:logout');
  assert.strictEqual((await chamar('auth:login', { usuario: 'joao', senha: 'nova123' })).perfil, 'default');

  // Backup é exclusivo do Admin agora — o Default nem pode exportar nem importar (em nenhum modo).
  assert.strictEqual((await chamar('backup:exportar', { senha: 'bkp1234' })).ok, false);
  assert.strictEqual((await chamar('backup:importar', { senha: 'bkp1234', modo: 'total' })).ok, false);

  // Histórico: Default só pode selecionar/excluir movimentações que ele mesmo marcou como
  // "📝 Marcar como recebido" — nunca uma pendente que ele não marcou, nem o histórico inteiro.
  assert.strictEqual((await chamar('historico:excluirSelecionados', [itemId])).ok, false); // nem marcada
  const movDefault = await chamar('items:adjust', { itemId, tipo: 'saida', quantidade: 1, usuarioId, tipoEntrega: 'retirada' });
  assert.strictEqual(movDefault.ok, true);
  const transacaoDefaultId = movDefault.transacao.id;
  assert.strictEqual((await chamar('historico:excluirSelecionados', [transacaoDefaultId])).ok, false); // pendente, mas ainda não marcada
  assert.strictEqual((await chamar('historico:marcarRecebidoDefault', { transacaoId: transacaoDefaultId, marcado: true })).ok, true);
  const excluiuMarcada = await chamar('historico:excluirSelecionados', [transacaoDefaultId]);
  assert.strictEqual(excluiuMarcada.ok, true);
  assert.strictEqual((await chamar('historico:excluirTudo')).ok, false); // isso continua exclusivo do Admin

  // "Pagamento geral" (exclusivo do Admin): compara com a soma da coluna "✓ Já pago"
  // (`pendencias:listarQuitados`), não com o total geral do sistema. Usuário "Fulano" fica
  // quitado com R$30 (base da comparação); "Ezio" tem uma pendência separada, ainda em aberto.
  await chamar('auth:logout');
  assert.strictEqual((await chamar('auth:login', { usuario: 'admin', senha: 'segredo1' })).ok, true);
  // Reabastece o estoque pra garantir quantidade suficiente pras saídas abaixo, independente do
  // que sobrou das movimentações anteriores neste teste.
  assert.strictEqual((await chamar('items:adjust', { itemId, tipo: 'entrada', quantidade: 100 })).ok, true);
  const rFulano = await chamar('usuarios:add', { nome: 'Fulano', telefone: '27900008888' });
  assert.strictEqual(rFulano.ok, true);
  const movFulano = await chamar('items:adjust', {
    itemId, tipo: 'saida', quantidade: 3, usuarioId: rFulano.usuario.id, tipoEntrega: 'retirada', pendente: true,
  });
  assert.strictEqual(movFulano.ok, true);
  const fulanoAntes = await chamar('pendencias:detalharUsuario', rFulano.usuario.id);
  assert.ok(fulanoAntes.totalPendente > 0);
  assert.strictEqual((await chamar('pagamentos:adicionar', { usuarioId: rFulano.usuario.id, valor: fulanoAntes.totalPendente, observacao: 'Pagou tudo' })).ok, true);
  assert.strictEqual((await chamar('pendencias:detalharUsuario', rFulano.usuario.id)).totalPendente, 0);
  assert.ok((await chamar('pendencias:listarQuitados')).some((u) => u.usuarioId === rFulano.usuario.id));

  const rEzio = await chamar('usuarios:add', { nome: 'Ezio', telefone: '27900009999' });
  assert.strictEqual(rEzio.ok, true);
  await chamar('items:adjust', {
    itemId, tipo: 'saida', quantidade: 20, usuarioId: rEzio.usuario.id, tipoEntrega: 'retirada', pendente: true,
  });
  const ezioAntes = await chamar('pendencias:detalharUsuario', rEzio.usuario.id);
  assert.ok(ezioAntes.totalPendente > 0);

  const quitadosAntes = await chamar('pendencias:listarQuitados');
  const baseJaPagoAntes = quitadosAntes.reduce((soma, u) => soma + u.totalPago, 0);
  const valorQueCobreESobra = baseJaPagoAntes + 1; // 1 real de excedente
  const geral = await chamar('pendencias:pagamentoGeral', { valor: valorQueCobreESobra });
  assert.strictEqual(geral.ok, true);
  assert.strictEqual(geral.baseJaPago, baseJaPagoAntes);
  assert.strictEqual(geral.sobra, 1);
  assert.strictEqual(geral.usuariosZerados, quitadosAntes.length);
  const ezioDepois = await chamar('pendencias:detalharUsuario', rEzio.usuario.id);
  assert.strictEqual(ezioDepois.totalPendente, ezioAntes.totalPendente - 1);
  // "Zera o lado dos pagos": o Fulano é removido por completo — pagamento apagado E pendência de
  // origem resolvida — não some só de "✓ Já pago", some de "Pendentes" também.
  const fulanoDepois = await chamar('pendencias:detalharUsuario', rFulano.usuario.id);
  assert.strictEqual(fulanoDepois.totalPagamentos, 0);
  assert.strictEqual(fulanoDepois.totalPendencias, 0);
  assert.strictEqual(fulanoDepois.totalPendente, 0);
  assert.ok(!(await chamar('pendencias:listarQuitados')).some((u) => u.usuarioId === rFulano.usuario.id));
  assert.ok(!(await chamar('pendencias:listarUsuarios')).some((u) => u.usuarioId === rFulano.usuario.id));

  // Agora não há mais ninguém em "✓ Já pago" (base = 0) — valor MENOR que a base não existe
  // (qualquer valor positivo > 0), então lança o valor informado inteiro pro "ezio".
  const menorGeral = await chamar('pendencias:pagamentoGeral', { valor: 0.01 });
  assert.strictEqual(menorGeral.ok, true);
  assert.strictEqual(menorGeral.sobra, 0.01);
  assert.strictEqual(menorGeral.baseJaPago, 0);
  assert.strictEqual(menorGeral.usuariosZerados, 0);

  // Validação PARCIAL: dois quitados (Beraht R$30 maior, Fulaninho R$10 menor) e um valor que só
  // cobre o maior — só ele é validado, e nada vai pro "ezio" dessa vez (a coluna não ficou vazia).
  const rBeraht = await chamar('usuarios:add', { nome: 'Beraht', telefone: '27900007777' });
  assert.strictEqual(rBeraht.ok, true);
  await chamar('items:adjust', {
    itemId, tipo: 'saida', quantidade: 3, usuarioId: rBeraht.usuario.id, tipoEntrega: 'retirada', pendente: true,
  });
  const berahtAntes = await chamar('pendencias:detalharUsuario', rBeraht.usuario.id);
  assert.strictEqual((await chamar('pagamentos:adicionar', { usuarioId: rBeraht.usuario.id, valor: berahtAntes.totalPendente, observacao: 'Pagou tudo' })).ok, true);

  const rFulaninho = await chamar('usuarios:add', { nome: 'Fulaninho', telefone: '27900006666' });
  assert.strictEqual(rFulaninho.ok, true);
  await chamar('items:adjust', {
    itemId, tipo: 'saida', quantidade: 1, usuarioId: rFulaninho.usuario.id, tipoEntrega: 'retirada', pendente: true,
  });
  const fulaninhoAntes = await chamar('pendencias:detalharUsuario', rFulaninho.usuario.id);
  assert.strictEqual((await chamar('pagamentos:adicionar', { usuarioId: rFulaninho.usuario.id, valor: fulaninhoAntes.totalPendente, observacao: 'Pagou tudo' })).ok, true);

  const quitadosOrdemParcial = await chamar('pendencias:listarQuitados');
  assert.ok(quitadosOrdemParcial[0].totalPago > quitadosOrdemParcial[1].totalPago); // maior primeiro
  const ezioAntesParcial = await chamar('pendencias:detalharUsuario', rEzio.usuario.id);

  const parcial = await chamar('pendencias:pagamentoGeral', { valor: quitadosOrdemParcial[0].totalPago });
  assert.strictEqual(parcial.ok, true);
  assert.strictEqual(parcial.sobra, 0); // nada pro ezio — Fulaninho não coube
  assert.strictEqual(parcial.usuariosZerados, 1); // só o maior
  assert.strictEqual(parcial.pagamento, null);
  const ezioDepoisParcial = await chamar('pendencias:detalharUsuario', rEzio.usuario.id);
  assert.strictEqual(ezioDepoisParcial.totalPendente, ezioAntesParcial.totalPendente); // intocado

  assert.ok(!(await chamar('pendencias:listarQuitados')).some((u) => u.usuarioId === rBeraht.usuario.id)); // validado
  assert.ok((await chamar('pendencias:listarQuitados')).some((u) => u.usuarioId === rFulaninho.usuario.id)); // intocado

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
