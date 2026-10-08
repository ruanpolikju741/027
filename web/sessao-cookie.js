'use strict';

/**
 * Sessão de login guardada num cookie CRIPTOGRAFADO (AES-256-GCM), em vez da memória do servidor.
 *
 * Por quê: no plano gratuito do Render o servidor "dorme" depois de 15 minutos sem uso e perde
 * tudo que estava na memória. Com a sessão no cookie, quem estava usando o app continua logado
 * quando o servidor acorda. O cookie é ilegível e à prova de adulteração pro navegador (só o
 * servidor tem a chave), é HttpOnly (JavaScript da página não lê), Secure (só HTTPS) e
 * SameSite=Strict (não é enviado por outros sites).
 *
 * Além do prazo (inativo por 4h ou 12h desde o login), cada sessão carrega uma "impressão" curta
 * da senha da conta/do Admin: se a senha mudar, a conta for excluída ou o Admin for zerado por
 * uma importação, a sessão antiga deixa de valer na hora (ver web/server.js).
 */

const crypto = require('crypto');
const { novaSessao } = require('../src/handlers');

const INATIVIDADE_MAX_MS = 4 * 60 * 60 * 1000;
const DURACAO_MAX_MS = 12 * 60 * 60 * 1000;
const MAX_PILHA_DESFAZER = 50;

function criarGerenciadorSessao(segredo) {
  const chave = crypto.createHmac('sha256', String(segredo)).update('estoque:sessao:v1').digest();

  function codificar(sessao, meta) {
    const corpo = JSON.stringify({
      p: sessao.perfil,
      c: sessao.contaLoginId,
      t: sessao.pendenteTrocaSenhaContaId,
      d: sessao.pilhaDesfazer.slice(-MAX_PILHA_DESFAZER),
      f: meta.impressao || null,
      i: meta.inicio,
      u: Date.now(),
    });
    const iv = crypto.randomBytes(12);
    const cifra = crypto.createCipheriv('aes-256-gcm', chave, iv);
    const ct = Buffer.concat([cifra.update(corpo, 'utf8'), cifra.final()]);
    return Buffer.concat([iv, cifra.getAuthTag(), ct]).toString('base64url');
  }

  /** Devolve { sessao, meta } — uma sessão nova (deslogada) se o cookie faltar, expirar ou for inválido. */
  function decodificar(valor) {
    const vazia = () => ({ sessao: novaSessao(), meta: { inicio: Date.now(), impressao: null } });
    if (!valor || valor.length > 4096) return vazia();
    try {
      const bruto = Buffer.from(valor, 'base64url');
      const decifra = crypto.createDecipheriv('aes-256-gcm', chave, bruto.subarray(0, 12));
      decifra.setAuthTag(bruto.subarray(12, 28));
      const o = JSON.parse(Buffer.concat([decifra.update(bruto.subarray(28)), decifra.final()]).toString('utf8'));
      const agora = Date.now();
      if (agora - o.u > INATIVIDADE_MAX_MS || agora - o.i > DURACAO_MAX_MS) return vazia();
      const sessao = novaSessao();
      sessao.perfil = o.p === 'admin' || o.p === 'default' ? o.p : null;
      sessao.contaLoginId = typeof o.c === 'string' ? o.c : null;
      sessao.pendenteTrocaSenhaContaId = typeof o.t === 'string' ? o.t : null;
      sessao.pilhaDesfazer = Array.isArray(o.d) ? o.d.filter((x) => typeof x === 'string') : [];
      return { sessao, meta: { inicio: o.i, impressao: o.f } };
    } catch (erro) {
      return vazia();
    }
  }

  return { codificar, decodificar };
}

/**
 * "Impressão" da identidade da sessão: muda se a senha/conta/Admin por trás dela mudar.
 * `null` = sessão sem login (nada a conferir); `false` = a conta/Admin não existe mais.
 */
function impressaoDaSessao(data, sessao) {
  if (!sessao.perfil) return null;
  const partes = [];
  if (sessao.contaLoginId) {
    const conta = (data.contasLogin || []).find((c) => c.id === sessao.contaLoginId);
    if (!conta) return false;
    partes.push('D', conta.id, conta.hashSenha);
  }
  if (sessao.perfil === 'admin') {
    if (!data.admin) return false;
    partes.push('A', data.admin.usuario, data.admin.hashSenha);
  }
  return crypto.createHash('sha256').update(partes.join('|')).digest('hex').slice(0, 24);
}

module.exports = { criarGerenciadorSessao, impressaoDaSessao };
