'use strict';

/**
 * Camada entre as regras do app (src/handlers.js) e o armazenamento (web/armazenamento.js):
 *
 *  - Criptografia: o estado inteiro do app (catálogo, usuários, histórico, logins…) é cifrado com
 *    AES-256-GCM antes de sair do servidor, com uma chave que só existe na variável de ambiente
 *    CHAVE_DADOS do servidor. Fotos e vídeos também. O banco só guarda texto cifrado.
 *  - Fotos/vídeos fora do estado: o app guarda cada foto como um "data URL" dentro do item/da
 *    movimentação. Aqui, ao gravar, cada data URL é separado num arquivo próprio (nome = hash do
 *    conteúdo, então a mesma foto nunca é guardada duas vezes) e trocado por um endereço
 *    `/api/midia/<hash>` — assim o estado continua pequeno e rápido de ler/gravar. Fotos que
 *    deixaram de ser usadas são apagadas logo depois.
 *  - Cache + fila: o estado fica na memória (o servidor é um só), e toda leitura/gravação passa por
 *    uma fila (uma de cada vez), pra duas pessoas mexendo ao mesmo tempo nunca sobrescreverem uma à
 *    outra. A gravação ainda confere a versão no banco (controle otimista) por segurança extra.
 */

const crypto = require('crypto');
const cryptoUtils = require('../src/crypto-utils');
const logic = require('../src/logic');
const { migrar } = require('../src/migracao');
const { ErroConflito } = require('./armazenamento');

// Imagens comuns e qualquer vídeo. Nunca SVG/HTML/XML (podem conter script se abertos direto).
const RE_TIPO_IMAGEM = /^image\/(jpeg|png|webp|gif|bmp|avif|heic|heif)$/;
const RE_TIPO_VIDEO = /^video\/[a-z0-9.+-]+$/;
function tipoMidiaPermitido(tipo) {
  return RE_TIPO_IMAGEM.test(tipo) || RE_TIPO_VIDEO.test(tipo);
}
/** Limite pra QUALQUER mídia gravada (inclusive vinda de um backup do desktop, que aceita até 25MB). */
const TAMANHO_MAX_MIDIA_GRAVADA = 26 * 1024 * 1024;
const RE_DATA_URL = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i;
const RE_URL_MIDIA = /^\/api\/midia\/([0-9a-f]{64})(\?tipo=video)?$/;
const CACHE_MIDIA_MAX_BYTES = 40 * 1024 * 1024;

function derivarChave(segredo) {
  if (!segredo || String(segredo).length < 16) {
    throw new Error('CHAVE_DADOS ausente ou curta demais (use pelo menos 16 caracteres aleatórios).');
  }
  return crypto.createHash('sha256').update(String(segredo), 'utf8').digest();
}

/** Decodifica um data URL de foto/vídeo aceito, ou devolve null. */
function lerDataUrl(texto) {
  const m = RE_DATA_URL.exec(String(texto || ''));
  if (!m) return null;
  const tipo = m[1].toLowerCase();
  if (!tipoMidiaPermitido(tipo)) return null;
  return { tipo, bytes: Buffer.from(m[2], 'base64') };
}

function urlDaMidia(id, tipo) {
  return `/api/midia/${id}${tipo.startsWith('video/') ? '?tipo=video' : ''}`;
}

/** Percorre todo lugar do estado que pode ter uma foto/vídeo, chamando `fn(valorAtual) -> novoValor`. */
function paraCadaMidia(data, fn) {
  for (const lista of [data.items || [], data.transacoes || []]) {
    for (const reg of lista) {
      if (reg && reg.foto != null) reg.foto = fn(reg.foto);
    }
  }
}

function criarRepositorio({ armazenamento, chaveDados, log = () => {} }) {
  const chave = derivarChave(chaveDados);
  let cache = null; // { data, versao }
  let idsMidiaConhecidos = new Set();
  const cacheMidia = new Map(); // id -> { tipo, bytes } (LRU simples)
  let bytesCacheMidia = 0;
  let fila = Promise.resolve();

  /** Executa `fn` com exclusividade (uma operação por vez sobre o estado). */
  function comTrava(fn) {
    const resultado = fila.then(fn, fn);
    fila = resultado.catch(() => {});
    return resultado;
  }

  async function lerDoBanco() {
    const linha = await armazenamento.lerEstado();
    if (!linha) return { data: logic.criarDadosIniciais(), versao: 0 };
    let data;
    try {
      data = cryptoUtils.descriptografarJSON(linha.dados, chave);
    } catch (erro) {
      // NUNCA seguir em frente aqui: começar "do zero" sobrescreveria os dados de verdade.
      throw new Error(
        'Não foi possível descriptografar os dados salvos: a CHAVE_DADOS do servidor não é a mesma ' +
          'usada pra gravá-los. Restaure o valor original dessa variável.'
      );
    }
    return { data: migrar(data), versao: linha.versao };
  }

  function guardarNoCacheMidia(id, valor) {
    if (valor.bytes.length > CACHE_MIDIA_MAX_BYTES / 4) return;
    cacheMidia.set(id, valor);
    bytesCacheMidia += valor.bytes.length;
    for (const [idAntigo, antigo] of cacheMidia) {
      if (bytesCacheMidia <= CACHE_MIDIA_MAX_BYTES) break;
      cacheMidia.delete(idAntigo);
      bytesCacheMidia -= antigo.bytes.length;
    }
  }

  /** Tira as fotos/vídeos novos de dentro do estado e grava cada um à parte (criptografado). */
  async function separarMidias(data) {
    const novas = new Map();
    paraCadaMidia(data, (valor) => {
      if (typeof valor !== 'string') return null;
      if (RE_URL_MIDIA.test(valor)) return valor;
      const midia = lerDataUrl(valor);
      if (!midia || midia.bytes.length === 0 || midia.bytes.length > TAMANHO_MAX_MIDIA_GRAVADA) {
        // Qualquer outra coisa (texto arbitrário, SVG, link externo…) é descartada: nunca vai parar
        // num `src` da interface.
        return null;
      }
      const id = crypto.createHash('sha256').update(midia.tipo + '\n').update(midia.bytes).digest('hex');
      if (!idsMidiaConhecidos.has(id)) novas.set(id, midia);
      return urlDaMidia(id, midia.tipo);
    });
    for (const [id, midia] of novas) {
      const claro = Buffer.concat([Buffer.from(midia.tipo + '\n', 'utf8'), midia.bytes]);
      await armazenamento.gravarMidia(id, cryptoUtils.criptografarBuffer(claro, chave));
      idsMidiaConhecidos.add(id);
      guardarNoCacheMidia(id, midia);
    }
  }

  /** Apaga as fotos/vídeos que nenhum item/movimentação usa mais. */
  async function limparMidiasOrfas(data) {
    const usadas = new Set();
    paraCadaMidia(data, (valor) => {
      const m = RE_URL_MIDIA.exec(String(valor));
      if (m) usadas.add(m[1]);
      return valor;
    });
    const orfas = [...idsMidiaConhecidos].filter((id) => !usadas.has(id));
    if (!orfas.length) return;
    try {
      await armazenamento.apagarMidias(orfas);
      for (const id of orfas) {
        idsMidiaConhecidos.delete(id);
        const c = cacheMidia.get(id);
        if (c) {
          bytesCacheMidia -= c.bytes.length;
          cacheMidia.delete(id);
        }
      }
    } catch (erro) {
      log('Aviso: não foi possível apagar mídias sem uso agora (tenta de novo na próxima gravação):', erro.message);
    }
  }

  return {
    async iniciar() {
      await armazenamento.garantirEstrutura();
      cache = await lerDoBanco();
      idsMidiaConhecidos = new Set(await armazenamento.listarMidias());
      log(`Dados carregados (versão ${cache.versao}, ${idsMidiaConhecidos.size} foto(s)/vídeo(s)).`);
    },

    comTrava,

    /** Estado atual (da memória). Só chamar dentro de `comTrava`. */
    carregar() {
      return cache.data;
    },

    /** Grava um estado novo (dentro de `comTrava`). */
    async persistir(novo) {
      const data = JSON.parse(JSON.stringify(novo));
      await separarMidias(data);
      const dados = cryptoUtils.criptografarJSON(data, chave);
      try {
        const versao = await armazenamento.gravarEstado(dados, cache.versao);
        cache = { data, versao };
      } catch (erro) {
        if (erro instanceof ErroConflito) cache = await lerDoBanco(); // fica com o que está no banco
        throw erro;
      }
      await limparMidiasOrfas(data);
    },

    /** Lê uma foto/vídeo pelo id (hash). Devolve { tipo, bytes } ou null. */
    async lerMidia(id) {
      if (!/^[0-9a-f]{64}$/.test(id)) return null;
      const doCache = cacheMidia.get(id);
      if (doCache) {
        cacheMidia.delete(id); // reinsere no fim (mais recente)
        cacheMidia.set(id, doCache);
        return doCache;
      }
      const cifrado = await armazenamento.lerMidia(id);
      if (!cifrado) return null;
      const claro = cryptoUtils.descriptografarBuffer(cifrado, chave);
      const fimTipo = claro.indexOf(0x0a);
      const valor = { tipo: claro.subarray(0, fimTipo).toString('utf8'), bytes: claro.subarray(fimTipo + 1) };
      guardarNoCacheMidia(id, valor);
      return valor;
    },

    /**
     * Pra exportar um backup: troca cada `/api/midia/<id>` de volta pelo data URL completo, pra que o
     * arquivo seja autossuficiente (e importável no app desktop também).
     */
    async embutirMidias(pacote) {
      const copia = JSON.parse(JSON.stringify(pacote));
      const ids = new Set();
      paraCadaMidia(copia, (valor) => {
        const m = RE_URL_MIDIA.exec(String(valor));
        if (m) ids.add(m[1]);
        return valor;
      });
      const dataUrls = new Map();
      for (const id of ids) {
        const midia = await this.lerMidia(id);
        if (midia) dataUrls.set(id, `data:${midia.tipo};base64,${midia.bytes.toString('base64')}`);
      }
      paraCadaMidia(copia, (valor) => {
        const m = RE_URL_MIDIA.exec(String(valor));
        return m ? dataUrls.get(m[1]) || null : valor;
      });
      return copia;
    },

    async ping() {
      await armazenamento.ping();
    },
  };
}

module.exports = { criarRepositorio, lerDataUrl, tipoMidiaPermitido };
