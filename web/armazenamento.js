'use strict';

/**
 * Onde a versão web guarda as coisas — dois "backends" com a mesma interface:
 *
 *  - Supabase (produção, gratuito): o estado do app fica numa linha da tabela `estado` (acessada
 *    pela API REST do Supabase) e cada foto/vídeo fica num arquivo do bucket privado `midias`
 *    (Supabase Storage). Tudo chega lá JÁ CRIPTOGRAFADO (ver web/repositorio.js) — o Supabase
 *    nunca vê os dados em texto puro.
 *  - Arquivo local (desenvolvimento/testes, ou se um dia rodar num servidor com disco próprio):
 *    a mesma coisa, só que numa pasta.
 *
 * Nenhuma dependência externa: a API do Supabase é chamada com o `fetch` nativo do Node 18+.
 *
 * Interface (tudo assíncrono, tudo lidando com conteúdo já criptografado):
 *   lerEstado()                       -> { versao, dados } | null
 *   gravarEstado(dados, versaoAtual)  -> nova versão; lança ErroConflito se alguém gravou antes
 *   gravarMidia(id, buffer) / lerMidia(id) -> Buffer|null / listarMidias() -> [id] / apagarMidias([id])
 *   ping()                            -> confirma que o banco está acessível
 */

const fs = require('fs');
const path = require('path');

class ErroConflito extends Error {
  constructor() {
    super('Os dados foram alterados por outro acesso ao mesmo tempo — tente de novo.');
    this.name = 'ErroConflito';
  }
}

const BUCKET = 'midias';
const TIMEOUT_MS = 30000;

/**
 * Aceita a SUPABASE_URL do jeito que a pessoa colar: a "Project URL" certinha
 * (https://abcd.supabase.co), com caminho no fim (…/rest/v1/), sem "https://", só o id do projeto,
 * ou até o endereço do painel (https://supabase.com/dashboard/project/abcd/…). Devolve a origem
 * (https://abcd.supabase.co) ou null.
 */
function normalizarUrlSupabase(valor, permitirHttp) {
  let texto = String(valor || '').trim().replace(/^["']|["']$/g, '');
  const painel = /supabase\.com\/dashboard\/project\/([a-z0-9]+)/i.exec(texto);
  if (painel) return `https://${painel[1].toLowerCase()}.supabase.co`;
  if (/^[a-z0-9]{15,30}$/i.test(texto)) return `https://${texto.toLowerCase()}.supabase.co`;
  if (!/^[a-z]+:\/\//i.test(texto)) texto = 'https://' + texto;
  let u;
  try {
    u = new URL(texto);
  } catch (erro) {
    return null;
  }
  if (u.protocol !== 'https:' && !(permitirHttp && u.protocol === 'http:')) return null;
  return u.origin;
}

function criarArmazenamentoSupabase({ url, chave, permitirHttp = false }) {
  const base = normalizarUrlSupabase(url, permitirHttp);
  if (!base) {
    throw new Error(
      `SUPABASE_URL inválida (recebi: "${String(url || '').slice(0, 120)}") — use a "Project URL" do Supabase ` +
        '(ex.: https://abcd1234.supabase.co).'
    );
  }
  chave = String(chave || '').trim();
  if (!chave) throw new Error('Falta a variável SUPABASE_CHAVE_SECRETA (a "secret key" do projeto no Supabase).');

  // Chaves novas (sb_secret_...) vão só no cabeçalho `apikey`; a chave antiga (service_role, um
  // JWT que começa com "eyJ") também precisa ir como Bearer.
  const cabecalhosAuth = { apikey: chave };
  if (chave.startsWith('eyJ')) cabecalhosAuth.Authorization = `Bearer ${chave}`;

  async function req(caminho, { metodo = 'GET', cabecalhos = {}, corpo, aceitar = [] } = {}) {
    const resp = await fetch(base + caminho, {
      method: metodo,
      headers: { ...cabecalhosAuth, ...cabecalhos },
      body: corpo,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!resp.ok && !aceitar.includes(resp.status)) {
      const texto = (await resp.text().catch(() => '')).slice(0, 300);
      const erro = new Error(`Supabase respondeu ${resp.status} em ${metodo} ${caminho.split('?')[0]}: ${texto}`);
      erro.status = resp.status;
      throw erro;
    }
    return resp;
  }

  const json = { 'Content-Type': 'application/json' };

  return {
    tipo: 'supabase',

    async garantirEstrutura() {
      // O bucket também é criado pelo SQL do README; isto só cobre quem pulou essa parte.
      await req('/storage/v1/bucket', {
        metodo: 'POST',
        cabecalhos: json,
        corpo: JSON.stringify({ id: BUCKET, name: BUCKET, public: false }),
        aceitar: [400, 409],
      });
    },

    async lerEstado() {
      const resp = await req('/rest/v1/estado?id=eq.1&select=versao,dados');
      const linhas = await resp.json();
      if (!linhas.length) return null;
      return { versao: Number(linhas[0].versao), dados: linhas[0].dados };
    },

    async gravarEstado(dados, versaoAtual) {
      if (!versaoAtual) {
        const resp = await req('/rest/v1/estado', {
          metodo: 'POST',
          cabecalhos: { ...json, Prefer: 'return=minimal' },
          corpo: JSON.stringify({ id: 1, versao: 1, dados }),
          aceitar: [409],
        });
        if (resp.status === 409) throw new ErroConflito();
        return 1;
      }
      // Só grava se ninguém tiver gravado desde a versão que temos (controle otimista).
      const resp = await req(`/rest/v1/estado?id=eq.1&versao=eq.${Number(versaoAtual)}&select=versao`, {
        metodo: 'PATCH',
        cabecalhos: { ...json, Prefer: 'return=representation' },
        corpo: JSON.stringify({ versao: versaoAtual + 1, dados, atualizado_em: new Date().toISOString() }),
      });
      const linhas = await resp.json();
      if (!linhas.length) throw new ErroConflito();
      return Number(linhas[0].versao);
    },

    async gravarMidia(id, buffer) {
      await req(`/storage/v1/object/${BUCKET}/${id}`, {
        metodo: 'POST',
        cabecalhos: { 'Content-Type': 'application/octet-stream', 'x-upsert': 'true' },
        corpo: buffer,
      });
    },

    async lerMidia(id) {
      const resp = await req(`/storage/v1/object/authenticated/${BUCKET}/${id}`, { aceitar: [400, 404] });
      if (!resp.ok) return null;
      return Buffer.from(await resp.arrayBuffer());
    },

    async listarMidias() {
      const ids = [];
      for (let offset = 0; ; offset += 1000) {
        const resp = await req(`/storage/v1/object/list/${BUCKET}`, {
          metodo: 'POST',
          cabecalhos: json,
          corpo: JSON.stringify({ prefix: '', limit: 1000, offset }),
        });
        const lote = await resp.json();
        for (const obj of lote) if (obj && obj.name) ids.push(obj.name);
        if (lote.length < 1000) break;
      }
      return ids;
    },

    async apagarMidias(ids) {
      for (let i = 0; i < ids.length; i += 100) {
        await req(`/storage/v1/object/${BUCKET}`, {
          metodo: 'DELETE',
          cabecalhos: json,
          corpo: JSON.stringify({ prefixes: ids.slice(i, i + 100) }),
        });
      }
    },

    async ping() {
      await req('/rest/v1/estado?id=eq.1&select=versao');
    },
  };
}

function criarArmazenamentoArquivo({ pasta }) {
  const pastaMidias = path.join(pasta, 'midias');
  const arqEstado = path.join(pasta, 'estado.json');
  fs.mkdirSync(pastaMidias, { recursive: true });

  function gravarAtomico(arquivo, conteudo) {
    const tmp = `${arquivo}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, conteudo, { mode: 0o600 });
    fs.renameSync(tmp, arquivo);
  }
  const caminhoMidia = (id) => path.join(pastaMidias, `${id}.bin`);

  return {
    tipo: 'arquivo',
    async garantirEstrutura() {},
    async lerEstado() {
      if (!fs.existsSync(arqEstado)) return null;
      return JSON.parse(fs.readFileSync(arqEstado, 'utf8'));
    },
    async gravarEstado(dados, versaoAtual) {
      const atual = fs.existsSync(arqEstado) ? JSON.parse(fs.readFileSync(arqEstado, 'utf8')).versao : 0;
      if (atual !== (versaoAtual || 0)) throw new ErroConflito();
      const nova = atual + 1;
      gravarAtomico(arqEstado, JSON.stringify({ versao: nova, dados }));
      return nova;
    },
    async gravarMidia(id, buffer) {
      gravarAtomico(caminhoMidia(id), buffer);
    },
    async lerMidia(id) {
      return fs.existsSync(caminhoMidia(id)) ? fs.readFileSync(caminhoMidia(id)) : null;
    },
    async listarMidias() {
      return fs.readdirSync(pastaMidias).filter((n) => n.endsWith('.bin')).map((n) => n.slice(0, -4));
    },
    async apagarMidias(ids) {
      for (const id of ids) fs.rmSync(caminhoMidia(id), { force: true });
    },
    async ping() {},
  };
}

module.exports = { ErroConflito, criarArmazenamentoSupabase, criarArmazenamentoArquivo };
