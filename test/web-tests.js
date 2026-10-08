'use strict';

/**
 * Testes da versão WEB (servidor + armazenamento), com `node` puro — sem navegador e sem
 * internet: o "Supabase" aqui é um servidor falso local que imita só as rotas que o app usa.
 * Rode com: node test/web-tests.js
 */

const assert = require('assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const { criarServidor } = require('../web/server');
const { criarArmazenamentoArquivo, criarArmazenamentoSupabase } = require('../web/armazenamento');

const temporarios = [];
function pastaTemp() {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), 'estoque-web-'));
  temporarios.push(p);
  return p;
}

let passou = 0;
let falhou = 0;
async function t(nome, fn) {
  try {
    await fn();
    passou++;
    console.log(`  OK  - ${nome}`);
  } catch (erro) {
    falhou++;
    console.error(`FALHOU - ${nome}`);
    console.error('       ', erro.stack || erro.message);
  }
}

// ---------------------------------------------------------------------------
// Supabase falso (PostgREST + Storage, só o necessário)
// ---------------------------------------------------------------------------

function criarSupabaseFalso(chaveEsperada) {
  const estado = { linha: null, objetos: new Map(), bucket: false, requisicoes: [] };
  const servidor = http.createServer((req, res) => {
    const partes = [];
    req.on('data', (p) => partes.push(p));
    req.on('end', () => {
      const corpo = Buffer.concat(partes);
      const url = new URL(req.url, 'http://x');
      estado.requisicoes.push(`${req.method} ${url.pathname}`);
      const json = (status, obj) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (req.headers.apikey !== chaveEsperada) return json(401, { message: 'Invalid API key' });

      if (url.pathname === '/rest/v1/estado') {
        if (req.method === 'GET') return json(200, estado.linha ? [{ versao: estado.linha.versao, dados: estado.linha.dados }] : []);
        if (req.method === 'POST') {
          if (estado.linha) return json(409, { message: 'duplicate key' });
          const b = JSON.parse(corpo.toString());
          estado.linha = { versao: b.versao, dados: b.dados };
          res.writeHead(201);
          return res.end();
        }
        if (req.method === 'PATCH') {
          const versao = Number((url.searchParams.get('versao') || '').replace('eq.', ''));
          if (!estado.linha || estado.linha.versao !== versao) return json(200, []);
          const b = JSON.parse(corpo.toString());
          estado.linha = { versao: b.versao, dados: b.dados };
          return json(200, [{ versao: b.versao }]);
        }
      }
      if (url.pathname === '/storage/v1/bucket' && req.method === 'POST') {
        if (estado.bucket) return json(409, { message: 'The resource already exists' });
        estado.bucket = true;
        return json(200, { name: 'midias' });
      }
      const mObj = /^\/storage\/v1\/object\/midias\/([0-9a-f]{64})$/.exec(url.pathname);
      if (mObj && req.method === 'POST') {
        estado.objetos.set(mObj[1], corpo);
        return json(200, { Key: `midias/${mObj[1]}` });
      }
      const mLer = /^\/storage\/v1\/object\/authenticated\/midias\/([0-9a-f]{64})$/.exec(url.pathname);
      if (mLer && req.method === 'GET') {
        const b = estado.objetos.get(mLer[1]);
        if (!b) return json(400, { message: 'Object not found' });
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        return res.end(b);
      }
      if (url.pathname === '/storage/v1/object/list/midias' && req.method === 'POST') {
        const b = JSON.parse(corpo.toString());
        const nomes = [...estado.objetos.keys()].slice(b.offset || 0, (b.offset || 0) + (b.limit || 100));
        return json(200, nomes.map((name) => ({ name })));
      }
      if (url.pathname === '/storage/v1/object/midias' && req.method === 'DELETE') {
        for (const id of JSON.parse(corpo.toString()).prefixes) estado.objetos.delete(id);
        return json(200, []);
      }
      return json(404, { message: 'rota não existe no falso' });
    });
  });
  return { servidor, estado };
}

// ---------------------------------------------------------------------------
// Cliente HTTP com "pote de cookies"
// ---------------------------------------------------------------------------

function criarCliente(base) {
  let cookie = '';
  async function rpc(canal, ...args) {
    const resp = await fetch(base + '/api/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'estoque-web', ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify({ canal, args }),
    });
    const setCookie = resp.headers.get('set-cookie');
    if (setCookie) {
      const valor = setCookie.split(';')[0];
      cookie = valor.endsWith('=') ? '' : valor;
    }
    const json = await resp.json();
    return json.r;
  }
  return {
    rpc,
    get cookie() { return cookie; },
    set cookie(v) { cookie = v; },
    async get(caminho, cabecalhos = {}) {
      return fetch(base + caminho, { headers: { ...(cookie ? { Cookie: cookie } : {}), ...cabecalhos } });
    },
  };
}

async function subir(config) {
  const { servidor, iniciarDados, estaPronto } = criarServidor({ porta: 0, tokenPrimeiroAcesso: '', ...config });
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  await iniciarDados();
  assert.ok(estaPronto(), 'servidor deveria estar pronto');
  const base = `http://127.0.0.1:${servidor.address().port}`;
  return { base, servidor, fechar: () => new Promise((r) => servidor.close(r)) };
}

const PNG_1x1 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

(async () => {
  console.log('== web: o window.api da web tem exatamente a mesma forma do preload do desktop ==');

  await t('api-web.js expõe os mesmos grupos e funções que o preload.js', () => {
    let apiDesktop = null;
    const sandboxPreload = {
      require: (m) => {
        if (m !== 'electron') throw new Error(m);
        return { contextBridge: { exposeInMainWorld: (_n, api) => { apiDesktop = api; } }, ipcRenderer: { invoke() {} } };
      },
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8'), sandboxPreload);

    const janela = {
      location: { search: '', pathname: '/' },
      history: { replaceState() {} },
      document: { documentElement: { classList: { add() {} } } },
    };
    const sandboxWeb = { window: janela, document: janela.document, URLSearchParams, setTimeout, clearTimeout, fetch: async () => ({}) };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'web', 'public', 'api-web.js'), 'utf8'), sandboxWeb);

    const forma = (api) =>
      Object.keys(api).sort().map((g) => `${g}: ${Object.keys(api[g]).sort().join(',')}`).join('\n');
    assert.strictEqual(forma(janela.api), forma(apiDesktop));
  });

  console.log('== web: servidor (armazenamento local) ==');
  const pasta = pastaTemp();
  const chaveDados = 'chave-de-teste-bem-comprida-123456';
  let srv = await subir({ armazenamento: criarArmazenamentoArquivo({ pasta }), chaveDados });
  const admin = criarCliente(srv.base);
  let fotoUrl;
  let usuarioId;
  let itemId;

  await t('sem o cabeçalho próprio do app (proteção CSRF) a ação é recusada', async () => {
    const r = await fetch(srv.base + '/api/rpc', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"canal":"auth:getPerfil"}',
    });
    assert.strictEqual(r.status, 403);
    const r2 = await fetch(srv.base + '/api/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'estoque-web', Origin: 'https://site-malicioso.com' },
      body: '{"canal":"auth:getPerfil"}',
    });
    assert.strictEqual(r2.status, 403);
  });

  await t('antes do login, nada além das telas de login funciona (e o corpo da requisição é limitado)', async () => {
    const r = await admin.rpc('items:list');
    assert.strictEqual(r.sessaoExpirada, true);
    const grande = await fetch(srv.base + '/api/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'estoque-web' },
      body: JSON.stringify({ canal: 'auth:login', args: [{ usuario: 'x'.repeat(200000) }] }),
    });
    assert.strictEqual(grande.status, 413);
  });

  await t('primeiro acesso: cria o Admin e já entra', async () => {
    assert.strictEqual(await admin.rpc('auth:precisaConfigurarLogin', {}), true);
    const r = await admin.rpc('auth:configurarLoginInicial', { usuario: 'dono', senha: 'senhaForte1' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(await admin.rpc('auth:getPerfil'), 'admin');
    assert.ok(admin.cookie.startsWith('sessao='));
  });

  await t('item com foto: a foto vira /api/midia/<hash>, é servida só pra quem está logado, e a resposta nunca traz o banco inteiro', async () => {
    const r = await admin.rpc('items:add', { nome: 'Caixa de Água', quantidade: 5, foto: PNG_1x1 });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.data, undefined, 'resposta não pode trazer `data` (hashes de senha)');
    itemId = r.item.id;
    const lista = await admin.rpc('items:list');
    fotoUrl = lista[0].foto;
    assert.match(fotoUrl, /^\/api\/midia\/[0-9a-f]{64}$/);

    const img = await admin.get(fotoUrl);
    assert.strictEqual(img.status, 200);
    assert.strictEqual(img.headers.get('content-type'), 'image/png');
    assert.strictEqual(Buffer.from(await img.arrayBuffer()).toString('base64'), PNG_1x1.split(',')[1]);
    const parcial = await admin.get(fotoUrl, { Range: 'bytes=0-3' });
    assert.strictEqual(parcial.status, 206);
    assert.strictEqual((await parcial.arrayBuffer()).byteLength, 4);

    const anonimo = await fetch(srv.base + fotoUrl);
    assert.strictEqual(anonimo.status, 401);
  });

  await t('foto "esquisita" (SVG, link externo, texto) nunca é gravada', async () => {
    const svg = 'data:image/svg+xml;base64,' + Buffer.from('<svg onload="alert(1)"/>').toString('base64');
    const r = await admin.rpc('items:add', { nome: 'SVG', quantidade: 1, foto: svg });
    assert.strictEqual(r.ok, false);
    assert.match(r.erro, /Formato/);
    for (const foto of ['https://exemplo.com/x.png', '" onerror="alert(1)']) {
      const r = await admin.rpc('items:add', { nome: 'Teste ' + foto.slice(0, 5), quantidade: 1, foto });
      assert.strictEqual(r.ok, true);
    }
    const lista = await admin.rpc('items:list');
    for (const i of lista.filter((x) => x.nome.startsWith('Teste'))) assert.strictEqual(i.foto, null);
    for (const i of lista.filter((x) => x.nome.startsWith('Teste'))) await admin.rpc('items:remove', i.id);
  });

  await t('vídeo grande demais pro plano grátis é recusado antes de gravar', async () => {
    const video = 'data:video/mp4;base64,' + Buffer.alloc(11 * 1024 * 1024).toString('base64');
    const r = await admin.rpc('items:edit', { itemId, foto: video });
    assert.strictEqual(r.ok, false);
    assert.match(r.erro, /grande demais/);
  });

  await t('nada fica em texto puro no armazenamento (estado e fotos criptografados)', async () => {
    const usr = await admin.rpc('usuarios:add', { nome: 'Fulana de Tal', telefone: '27999991111' });
    usuarioId = usr.usuario.id;
    const bruto = fs.readFileSync(path.join(pasta, 'estado.json'), 'utf8');
    for (const texto of ['Caixa de Água', 'Fulana', 'dono', 'hashSenha']) assert.ok(!bruto.includes(texto), texto);
    const midias = fs.readdirSync(path.join(pasta, 'midias'));
    assert.strictEqual(midias.length, 1);
    const conteudo = fs.readFileSync(path.join(pasta, 'midias', midias[0]));
    assert.ok(!conteudo.includes(Buffer.from(PNG_1x1.split(',')[1], 'base64').subarray(1, 4)));
  });

  await t('relatório em PDF na web: volta o HTML do relatório pra o navegador imprimir', async () => {
    await admin.rpc('items:adjust', { itemId, tipo: 'saida', quantidade: 2, usuarioId, tipoEntrega: 'entrega', pendente: true });
    const r = await admin.rpc('relatorio:gerarPdfPendenciaUsuario', { usuarioId });
    assert.strictEqual(r.ok, true);
    assert.match(r.html, /Fulana de Tal/);
    assert.match(r.nomeArquivo, /^pendencia-fulana-de-tal-/);
    const c = await admin.rpc('relatorio:gerarPdfConsulta', { modo: 'item', itemId });
    assert.match(c.html, /Caixa de Água/);
  });

  let backupConteudo;
  await t('exportar backup devolve o arquivo com a foto embutida (dá pra importar no desktop)', async () => {
    const r = await admin.rpc('backup:exportar', { senha: 'backup123' });
    assert.strictEqual(r.ok, true);
    backupConteudo = r.conteudo;
    const arq = JSON.parse(backupConteudo);
    const cu = require('../src/crypto-utils');
    const pacote = cu.descriptografarJSON(arq.payload, cu.derivarChaveDeSenha('backup123', arq.salt));
    assert.strictEqual(pacote.items[0].foto, PNG_1x1);
    assert.strictEqual(pacote.admin, undefined);
  });

  const outro = criarCliente(srv.base);
  await t('conta do Default: senha temporária → troca → entra; Admin redefinindo a senha derruba a sessão dela', async () => {
    const c = await admin.rpc('contasLogin:criar', { usuario: 'joana', senha: 'temp123' });
    assert.strictEqual(c.ok, true);
    const lg = await outro.rpc('auth:login', { usuario: 'joana', senha: 'temp123' });
    assert.strictEqual(lg.precisaTrocarSenha, true);
    assert.strictEqual((await outro.rpc('items:list')).sessaoExpirada, true); // ainda não entrou de vez
    const tr = await outro.rpc('auth:trocarSenhaPrimeiroAcesso', { contaId: lg.contaId, senhaAtual: 'temp123', novaSenha: 'minha123' });
    assert.strictEqual(tr.ok, true);
    assert.strictEqual(await outro.rpc('auth:getPerfil'), 'default');
    assert.ok(Array.isArray(await outro.rpc('items:list')));
    assert.strictEqual((await outro.rpc('items:add', { nome: 'X' })).ok, false); // só Admin

    await admin.rpc('contasLogin:resetarSenha', { contaId: lg.contaId, novaSenha: 'outra123' });
    assert.strictEqual((await outro.rpc('items:list')).sessaoExpirada, true);
  });

  await t('Default: exporta backup completo (como no desktop) e não pode importar "mesclando"', async () => {
    const def = criarCliente(srv.base);
    await admin.rpc('contasLogin:criar', { usuario: 'carlos', senha: 'temp123' });
    const lg = await def.rpc('auth:login', { usuario: 'carlos', senha: 'temp123' });
    await def.rpc('auth:trocarSenhaPrimeiroAcesso', { contaId: lg.contaId, senhaAtual: 'temp123', novaSenha: 'carlos123' });
    const mesclar = await def.rpc('backup:importar', { senha: 'backup123', modo: 'mesclar', conteudo: backupConteudo });
    assert.strictEqual(mesclar.ok, false);
    assert.match(mesclar.erro, /admin/i);

    const exp = await def.rpc('backup:exportar', { senha: 'carlos-bkp' });
    assert.strictEqual(exp.ok, true);
    assert.ok(exp.totalContasLogin >= 1);
    // E um argumento nulo não derruba nada (vira erro normal de validação).
    const nulo = await def.rpc('usuarios:editar', null);
    assert.strictEqual(nulo.ok, false);
  });

  await t('Default importa "substituir tudo" pelo envio grande (?grande=1): volta pro login, só valem as contas do arquivo', async () => {
    const pastaX = pastaTemp();
    const sx = await subir({ armazenamento: criarArmazenamentoArquivo({ pasta: pastaX }), chaveDados });
    const adm = criarCliente(sx.base);
    await adm.rpc('auth:configurarLoginInicial', { usuario: 'chefe', senha: 'chefe123' });
    await adm.rpc('contasLogin:criar', { usuario: 'ezio', senha: 'ezio123' });
    const def = criarCliente(sx.base);
    const lg = await def.rpc('auth:login', { usuario: 'ezio', senha: 'ezio123' });
    await def.rpc('auth:trocarSenhaPrimeiroAcesso', { contaId: lg.contaId, senhaAtual: 'ezio123', novaSenha: 'ezio456' });

    const resp = await fetch(sx.base + '/api/rpc?grande=1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'estoque-web', Cookie: def.cookie },
      body: JSON.stringify({ canal: 'backup:importar', args: [{ senha: 'backup123', modo: 'total', conteudo: backupConteudo }] }),
    });
    const imp = (await resp.json()).r;
    assert.strictEqual(imp.ok, true);
    assert.strictEqual(imp.perfil, null);
    assert.strictEqual((await adm.rpc('items:list')).sessaoExpirada, true); // Admin antigo caiu
    const novo = criarCliente(sx.base);
    assert.strictEqual((await novo.rpc('auth:login', { usuario: 'chefe', senha: 'chefe123' })).ok, false);
    const itens = await (async () => {
      const lgJ = await novo.rpc('auth:login', { usuario: 'joana', senha: 'temp123' }); // conta que veio no arquivo
      return lgJ;
    })();
    assert.strictEqual(itens.ok, false); // joana foi criada depois desse backup — não vem
    await sx.fechar();
  });

  await t('cookie de sessão adulterado não vale nada', async () => {
    const falso = criarCliente(srv.base);
    falso.cookie = admin.cookie.slice(0, -4) + 'AAAA';
    assert.strictEqual(await falso.rpc('auth:getPerfil'), null);
  });

  await t('a sessão sobrevive ao servidor reiniciar (plano grátis dorme e acorda)', async () => {
    await srv.fechar();
    srv = await subir({ armazenamento: criarArmazenamentoArquivo({ pasta }), chaveDados });
    const reaberto = criarCliente(srv.base);
    reaberto.cookie = admin.cookie;
    assert.strictEqual(await reaberto.rpc('auth:getPerfil'), 'admin');
    const lista = await reaberto.rpc('items:list');
    assert.strictEqual(lista[0].nome, 'Caixa de Água');
  });

  await t('muitas senhas erradas seguidas bloqueiam novas tentativas por 15 minutos (sem trancar os outros usuários)', async () => {
    const atacante = criarCliente(srv.base);
    for (let i = 0; i < 10; i++) {
      const r = await atacante.rpc('auth:login', { usuario: 'dono', senha: 'errada' + i });
      assert.strictEqual(r.ok, false);
    }
    const bloqueado = await atacante.rpc('auth:login', { usuario: 'Dono ', senha: 'senhaForte1' });
    assert.match(bloqueado.erro, /Muitas tentativas/);
    const outroUsuario = await atacante.rpc('auth:login', { usuario: 'carlos', senha: 'carlos123' });
    assert.strictEqual(outroUsuario.ok, true);
    // Chutar o token do link do Admin também conta (e quem não manda token nunca é afetado).
    const chutador = criarCliente(srv.base);
    for (let i = 0; i < 12; i++) await chutador.rpc('auth:precisaConfigurarLogin', { tokenConfiguracao: 'chute' + i });
    assert.strictEqual(await chutador.rpc('auth:precisaConfigurarLogin', {}), false);
  });

  await t('importação total: Admin zerado, todas as sessões de Admin caem, e ninguém recria o Admin sem o token', async () => {
    const adm = criarCliente(srv.base);
    adm.cookie = admin.cookie;
    const imp = await adm.rpc('backup:importar', { senha: 'backup123', modo: 'total', conteudo: backupConteudo });
    assert.strictEqual(imp.ok, true);
    assert.strictEqual(imp.data, undefined);
    assert.strictEqual(await adm.rpc('auth:getPerfil'), null);
    assert.strictEqual(await adm.rpc('auth:precisaConfigurarLogin', {}), false);
    const invasor = criarCliente(srv.base);
    assert.strictEqual((await invasor.rpc('auth:configurarLoginInicial', { usuario: 'hacker', senha: 'hacker1' })).ok, false);
    // Só valem as contas que vieram no arquivo — a "joana" foi criada depois do backup.
    const joana = criarCliente(srv.base);
    assert.strictEqual((await joana.rpc('auth:login', { usuario: 'joana', senha: 'outra123' })).ok, false);
    const sessaoAntigaDaJoana = criarCliente(srv.base);
    sessaoAntigaDaJoana.cookie = outro.cookie;
    assert.strictEqual(await sessaoAntigaDaJoana.rpc('auth:getPerfil'), null);
  });

  await t('dados criptografados com outra CHAVE_DADOS: o servidor se recusa a subir (nunca sobrescreve)', async () => {
    await srv.fechar();
    const { servidor, iniciarDados, estaPronto } = criarServidor({
      porta: 0, tokenPrimeiroAcesso: '', armazenamento: criarArmazenamentoArquivo({ pasta }), chaveDados: 'outra-chave-totalmente-diferente',
    });
    await iniciarDados();
    assert.strictEqual(estaPronto(), false);
    servidor.close();
  });

  console.log('== web: migrar os dados do desktop (backup → "Mesclar" num app web novo) ==');
  {
    const pastaOrigem = pastaTemp();
    const pastaDestino = pastaTemp();
    const origem = await subir({ armazenamento: criarArmazenamentoArquivo({ pasta: pastaOrigem }), chaveDados });
    const destino = await subir({ armazenamento: criarArmazenamentoArquivo({ pasta: pastaDestino }), chaveDados: 'outra-chave-do-servidor-web-123' });
    await t('mesclar num app vazio traz tudo (quantidades, fotos, histórico, contas) e mantém o Admin novo', async () => {
      const o = criarCliente(origem.base);
      await o.rpc('auth:configurarLoginInicial', { usuario: 'antigo', senha: 'antigo123' });
      const it = await o.rpc('items:add', { nome: 'Sabão', quantidade: 20, foto: PNG_1x1 });
      const u = await o.rpc('usuarios:add', { nome: 'Rita', telefone: '27900001111' });
      await o.rpc('items:definirPreco', { itemId: it.item.id, preco: 3 });
      await o.rpc('items:adjust', { itemId: it.item.id, tipo: 'saida', quantidade: 4, usuarioId: u.usuario.id, tipoEntrega: 'retirada', pendente: true });
      await o.rpc('pagamentos:adicionar', { usuarioId: u.usuario.id, valor: 5, observacao: 'Pix' });
      await o.rpc('contasLogin:criar', { usuario: 'caixa', senha: 'caixa123' });
      const exp = await o.rpc('backup:exportar', { senha: 'migrar123' });

      const d = criarCliente(destino.base);
      await d.rpc('auth:configurarLoginInicial', { usuario: 'novoAdmin', senha: 'novo1234' });
      const imp = await d.rpc('backup:importar', { senha: 'migrar123', modo: 'mesclar', conteudo: exp.conteudo });
      assert.strictEqual(imp.ok, true);

      const novo = criarCliente(destino.base);
      assert.strictEqual((await novo.rpc('auth:login', { usuario: 'novoAdmin', senha: 'novo1234' })).perfil, 'admin');
      const itens = await novo.rpc('items:list');
      assert.strictEqual(itens.length, 1);
      assert.strictEqual(itens[0].quantidade, 16);
      assert.strictEqual((await novo.get(itens[0].foto)).status, 200);
      const pend = await novo.rpc('pendencias:listarUsuarios');
      assert.strictEqual(pend[0].totalPendente, 7); // 4 × R$3 − R$5
      const caixa = criarCliente(destino.base);
      assert.strictEqual((await caixa.rpc('auth:login', { usuario: 'caixa', senha: 'caixa123' })).precisaTrocarSenha, true);
    });
    await origem.fechar();
    await destino.fechar();
  }

  console.log('== web: token do link de configuração do Admin ==');
  {
    const pasta2 = pastaTemp();
    const s2 = await subir({ armazenamento: criarArmazenamentoArquivo({ pasta: pasta2 }), chaveDados, tokenPrimeiroAcesso: 'TOKEN+SECRETO/1=' });
    const c = criarCliente(s2.base);
    await t('instalação nova com token configurado: a tela aparece, mas só cria o Admin com o token certo', async () => {
      assert.strictEqual(await c.rpc('auth:precisaConfigurarLogin', {}), true);
      const sem = await c.rpc('auth:configurarLoginInicial', { usuario: 'a', senha: 'senha123' });
      assert.strictEqual(sem.ok, false);
      assert.match(sem.erro, /configurar=/);
      const errado = await c.rpc('auth:configurarLoginInicial', { usuario: 'a', senha: 'senha123', tokenConfiguracao: 'chute' });
      assert.strictEqual(errado.ok, false);
      const certo = await c.rpc('auth:configurarLoginInicial', { usuario: 'a', senha: 'senha123', tokenConfiguracao: 'TOKEN+SECRETO/1=' });
      assert.strictEqual(certo.ok, true);
    });
    await t('depois de uma importação total, o dono recria o Admin abrindo o link com o token', async () => {
      await c.rpc('contasLogin:criar', { usuario: 'func', senha: 'func123' });
      const exp = await c.rpc('backup:exportar', { senha: 'bkp1234' });
      await c.rpc('backup:importar', { senha: 'bkp1234', modo: 'total', conteudo: exp.conteudo });
      assert.strictEqual(await c.rpc('auth:precisaConfigurarLogin', {}), false);
      assert.strictEqual(await c.rpc('auth:precisaConfigurarLogin', { tokenConfiguracao: 'TOKEN SECRETO/1=' }), true); // '+' que virou espaço no link
      const r = await c.rpc('auth:configurarLoginInicial', { usuario: 'novoDono', senha: 'senha456', tokenConfiguracao: 'TOKEN+SECRETO/1=' });
      assert.strictEqual(r.ok, true);
      assert.strictEqual(await c.rpc('auth:getPerfil'), 'admin');
    });
    await s2.fechar();
  }

  console.log('== web: armazenamento no Supabase (servidor falso) ==');
  {
    const falso = criarSupabaseFalso('sb_secret_teste');
    await new Promise((r) => falso.servidor.listen(0, '127.0.0.1', r));
    const urlFalso = `http://127.0.0.1:${falso.servidor.address().port}`;
    const novoArmazenamento = () =>
      criarArmazenamentoSupabase({ url: urlFalso, chave: 'sb_secret_teste', permitirHttp: true });

    let s3 = await subir({ armazenamento: novoArmazenamento(), chaveDados });
    const c = criarCliente(s3.base);
    await t('fluxo completo gravando no Supabase: estado na tabela, foto no Storage, tudo cifrado', async () => {
      assert.ok(falso.estado.bucket, 'deveria ter criado o bucket');
      await c.rpc('auth:configurarLoginInicial', { usuario: 'dono', senha: 'senha123' });
      const r = await c.rpc('items:add', { nome: 'Refrigerante', quantidade: 3, foto: PNG_1x1 });
      assert.strictEqual(r.ok, true);
      assert.strictEqual(falso.estado.objetos.size, 1);
      assert.ok(falso.estado.linha.versao >= 2);
      assert.ok(!falso.estado.linha.dados.includes('Refrigerante'));
      const lista = await c.rpc('items:list');
      const img = await c.get(lista[0].foto);
      assert.strictEqual(img.status, 200);
    });
    await t('trocar a foto apaga a antiga do Storage (não acumula lixo no plano grátis)', async () => {
      const lista = await c.rpc('items:list');
      const outraFoto = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
      await c.rpc('items:edit', { itemId: lista[0].id, foto: outraFoto });
      assert.strictEqual(falso.estado.objetos.size, 1);
      const nova = (await c.rpc('items:list'))[0].foto;
      assert.ok(falso.estado.objetos.has(nova.split('/').pop()));
    });
    await t('depois de reiniciar, lê tudo de volta do Supabase', async () => {
      await s3.fechar();
      s3 = await subir({ armazenamento: novoArmazenamento(), chaveDados });
      const c2 = criarCliente(s3.base);
      c2.cookie = c.cookie;
      const lista = await c2.rpc('items:list');
      assert.strictEqual(lista[0].nome, 'Refrigerante');
      assert.strictEqual((await c2.get(lista[0].foto)).status, 200);
      const saude = await fetch(s3.base + '/api/saude');
      assert.strictEqual(saude.status, 200);
    });
    await t('chave errada do Supabase: erro claro, sem derrubar o site', async () => {
      const { servidor, iniciarDados, estaPronto } = criarServidor({
        porta: 0, tokenPrimeiroAcesso: '', chaveDados,
        armazenamento: criarArmazenamentoSupabase({ url: urlFalso, chave: 'errada', permitirHttp: true }),
      });
      await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
      await iniciarDados();
      assert.strictEqual(estaPronto(), false);
      const vivo = await fetch(`http://127.0.0.1:${servidor.address().port}/api/vivo`);
      assert.strictEqual(vivo.status, 200);
      servidor.close();
    });
    await s3.fechar();
    falso.servidor.close();
  }

  for (const p of temporarios) fs.rmSync(p, { recursive: true, force: true });
  console.log(`\n${passou} teste(s) da versão web passaram${falhou ? `, ${falhou} FALHARAM` : ''}.`);
  process.exit(falhou ? 1 : 0);
})().catch((erro) => {
  console.error(erro);
  process.exit(1);
});
