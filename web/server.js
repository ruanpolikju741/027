'use strict';

/**
 * Versão WEB do Controle de Estoque — o mesmo app do desktop, acessível por um endereço (URL) no
 * PC ou no celular. Sem nenhuma dependência externa (só o Node 18+), pra rodar de graça no Render.
 *
 *  - A interface é a MESMA do desktop (renderer/), servida como site; um arquivo pequeno
 *    (web/public/api-web.js) faz o papel do preload.js, mandando cada ação pra cá via HTTP.
 *  - As regras são as MESMAS do desktop (src/handlers.js + src/logic.js).
 *  - Os dados ficam no Supabase, criptografados (ver web/repositorio.js e web/armazenamento.js).
 *
 * Variáveis de ambiente (ver README, seção "Versão web"):
 *   SUPABASE_URL, SUPABASE_CHAVE_SECRETA  — banco (sem elas, usa uma pasta local: só pra testes)
 *   CHAVE_DADOS                           — chave que criptografa tudo (GUARDE uma cópia!)
 *   TOKEN_PRIMEIRO_ACESSO                 — senha do link que cria/recria o login do Admin
 *   PORT                                  — porta HTTP (o Render define sozinho)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const logic = require('../src/logic');
const { criarHandlers, executar, CANAIS_SEM_SESSAO, limparSessao } = require('../src/handlers');
const { criarArmazenamentoSupabase, criarArmazenamentoArquivo, ErroConflito } = require('./armazenamento');
const { criarRepositorio, tipoMidiaPermitido } = require('./repositorio');
const { criarGerenciadorSessao, impressaoDaSessao } = require('./sessao-cookie');

const RAIZ = path.join(__dirname, '..');
const ATRAS_DE_PROXY = !!(process.env.RENDER || process.env.ATRAS_DE_PROXY);

const LIMITE_CORPO_ANONIMO = 64 * 1024; // antes do login: só telas de login
const LIMITE_CORPO_LOGADO = 15 * 1024 * 1024; // depois: fotos/vídeos
const LIMITE_CORPO_BACKUP = 80 * 1024 * 1024; // importação de backup (uma de cada vez)
// Teto de bytes sendo recebidos ao mesmo tempo por quem está LOGADO (o plano grátis tem 512 MB de
// memória, e cada requisição grande é copiada algumas vezes até virar dado), também por endereço
// de internet — e um teto de envios simultâneos de quem ainda não logou, por endereço.
const LIMITE_BYTES_SIMULTANEOS = 120 * 1024 * 1024;
const LIMITE_BYTES_SIMULTANEOS_POR_IP = 40 * 1024 * 1024;
const MAX_ENVIOS_ANONIMOS_POR_IP = 10;
// Prazo pra terminar de receber o corpo da requisição (contra conexões "lentas de propósito").
const PRAZO_CORPO_ANONIMO_MS = 15 * 1000;
const PRAZO_CORPO_LOGADO_MS = 3 * 60 * 1000;
const TAMANHO_MAX_VIDEO_WEB = 10 * 1024 * 1024; // vídeo novo enviado pela web (o plano grátis tem 1GB)
const TAMANHO_MAX_IMAGEM_WEB = 4 * 1024 * 1024;

/** Canais com senha (ou token) — contam pro limite de tentativas erradas. */
const CANAIS_COM_SENHA = new Set([
  'auth:login',
  'auth:loginAdmin',
  'auth:configurarLoginInicial',
  'auth:precisaConfigurarLogin',
  'auth:trocarSenhaPrimeiroAcesso',
  'auth:redefinirLoginAdmin',
  'backup:importar',
]);
// Limites de erros em 15 minutos, sempre ligados ao endereço de internet de quem erra — assim
// ninguém consegue travar o login de outra pessoa errando a senha dela de propósito:
//  - 10 pro mesmo usuário (ou pro mesmo canal, nos que não têm usuário: token do Admin, senha do
//    backup…) vindo do mesmo endereço — quem erra a própria senha não tranca o escritório inteiro;
//  - 100 no total vindos do mesmo endereço (contra quem testa uma senha em vários usuários).
const MAX_FALHAS_IP_E_ALVO = 10;
const MAX_FALHAS_IP = 100;
const JANELA_FALHAS_MS = 15 * 60 * 1000;

function log(...partes) {
  console.log(new Date().toISOString(), ...partes);
}

// ---------------------------------------------------------------------------
// Configuração
// ---------------------------------------------------------------------------

function lerConfiguracao() {
  const env = process.env;
  let chaveDados = env.CHAVE_DADOS;
  let armazenamento;

  if (env.SUPABASE_URL) {
    armazenamento = criarArmazenamentoSupabase({ url: env.SUPABASE_URL, chave: env.SUPABASE_CHAVE_SECRETA });
  } else {
    if (env.RENDER) {
      throw new Error(
        'Faltam SUPABASE_URL e SUPABASE_CHAVE_SECRETA. No Render o disco é apagado a cada reinício — ' +
          'sem o Supabase os dados se perderiam. Configure as duas variáveis (veja o README).'
      );
    }
    const pasta = path.resolve(env.PASTA_DADOS_LOCAL || path.join(RAIZ, 'dados-web-local'));
    armazenamento = criarArmazenamentoArquivo({ pasta });
    if (!chaveDados) {
      // Só pra testar no próprio computador: gera e guarda uma chave na pasta local.
      const arqChave = path.join(pasta, '.chave-dados-local');
      if (!fs.existsSync(arqChave)) fs.writeFileSync(arqChave, crypto.randomBytes(32).toString('base64'), { mode: 0o600 });
      chaveDados = fs.readFileSync(arqChave, 'utf8').trim();
    }
    log(`Usando armazenamento LOCAL em ${pasta} (modo de teste — em produção use o Supabase).`);
  }
  if (!chaveDados) throw new Error('Falta a variável CHAVE_DADOS (a chave que criptografa os dados).');

  return {
    porta: Number(env.PORT) || 3000,
    armazenamento,
    chaveDados,
    tokenPrimeiroAcesso: env.TOKEN_PRIMEIRO_ACESSO || '',
  };
}

function iguaisTempoConstante(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

// ---------------------------------------------------------------------------
// Arquivos da interface (a mesma do desktop + o "preload" web)
// ---------------------------------------------------------------------------

function montarArquivosEstaticos() {
  const tipos = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
  };
  const arquivos = new Map();
  function adicionar(rota, caminho, transformar) {
    let conteudo = fs.readFileSync(caminho);
    if (transformar) conteudo = Buffer.from(transformar(conteudo.toString('utf8')), 'utf8');
    arquivos.set(rota, {
      conteudo,
      tipo: tipos[path.extname(caminho)] || 'application/octet-stream',
      etag: '"' + crypto.createHash('sha256').update(conteudo).digest('base64url').slice(0, 20) + '"',
    });
  }

  adicionar('/', path.join(RAIZ, 'renderer', 'index.html'), (html) => {
    const cabeca =
      '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />\n' +
      '  <meta name="theme-color" content="#a76bff" />\n' +
      '  <link rel="manifest" href="manifest.webmanifest" />\n' +
      '  <link rel="icon" href="icone.svg" type="image/svg+xml" />\n' +
      '  <link rel="apple-touch-icon" href="icone-192.png" />\n' +
      '  <meta name="apple-mobile-web-app-capable" content="yes" />';
    let saida = html.replace(/<meta charset="UTF-8" \/>/i, (m) => `${m}\n  ${cabeca}`);
    saida = saida.replace(
      '<link rel="stylesheet" href="styles.css" />',
      '<link rel="stylesheet" href="styles.css" />\n  <link rel="stylesheet" href="web.css" />'
    );
    saida = saida.replace('<script src="app.js"></script>', '<script src="api-web.js"></script>\n  <script src="app.js"></script>');
    if (!saida.includes('api-web.js') || !saida.includes('viewport')) {
      throw new Error('Não consegui adaptar renderer/index.html pra web (o cabeçalho mudou?).');
    }
    return saida;
  });
  adicionar('/app.js', path.join(RAIZ, 'renderer', 'app.js'));
  adicionar('/styles.css', path.join(RAIZ, 'renderer', 'styles.css'));
  for (const nome of fs.readdirSync(path.join(__dirname, 'public'))) {
    adicionar('/' + nome, path.join(__dirname, 'public', nome));
  }
  return arquivos;
}

// ---------------------------------------------------------------------------
// Utilitários HTTP
// ---------------------------------------------------------------------------

const CSP_PAGINA = [
  "default-src 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
].join('; ');

function ehHttps(req) {
  if (ATRAS_DE_PROXY) return String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
  return !!req.socket.encrypted;
}

function ipDoCliente(req) {
  if (ATRAS_DE_PROXY) {
    // O Cloudflare (na frente do Render) sempre reescreve este cabeçalho; os outros podem vir do
    // próprio cliente. De todo jeito, o limite por usuário (acima) não depende do IP.
    const cf = req.headers['cf-connecting-ip'];
    if (cf) return String(cf).trim();
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (xff.length) return xff[xff.length - 1];
  }
  return req.socket.remoteAddress || '?';
}

function cabecalhosSeguranca(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), payment=(), usb=()');
  if (ehHttps(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

function responderJson(res, status, corpo) {
  const texto = JSON.stringify(corpo);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(texto),
  });
  res.end(texto);
}

function lerCookies(req) {
  const saida = {};
  for (const parte of String(req.headers.cookie || '').split(';')) {
    const i = parte.indexOf('=');
    if (i > 0) saida[parte.slice(0, i).trim()] = parte.slice(i + 1).trim();
  }
  return saida;
}

function lerCorpo(req, limite) {
  return new Promise((resolve, reject) => {
    const partes = [];
    let total = 0;
    req.on('data', (pedaco) => {
      total += pedaco.length;
      if (total > limite) {
        // Para de guardar o que chega; quem chamou responde 413 e fecha a conexão.
        const erro = new Error('corpo grande demais');
        erro.status = 413;
        req.removeAllListeners('data');
        req.pause();
        reject(erro);
        return;
      }
      partes.push(pedaco);
    });
    req.on('end', () => resolve(Buffer.concat(partes).toString('utf8')));
    req.on('error', reject);
  });
}

/** Tamanho real (em bytes) de um data URL base64, sem decodificar. */
function bytesDoDataUrl(texto) {
  const i = texto.indexOf(',');
  return Math.floor(((texto.length - i - 1) * 3) / 4);
}

/** Recusa fotos/vídeos novos grandes demais pro plano gratuito, antes de chegar nas regras. */
function conferirTamanhoMidia(canal, args) {
  if (!['items:add', 'items:edit', 'items:adjust'].includes(canal)) return null;
  const foto = args && args[0] && args[0].foto;
  if (typeof foto !== 'string' || !foto.startsWith('data:')) return null;
  const tipo = foto.slice(5, foto.indexOf(';')).toLowerCase();
  if (!tipoMidiaPermitido(tipo)) {
    return tipo.startsWith('video/')
      ? 'Formato de vídeo não aceito na versão web — use um vídeo MP4 (o padrão da câmera do celular).'
      : 'Formato de arquivo não aceito — escolha uma foto (JPG/PNG) ou um vídeo MP4.';
  }
  const video = foto.startsWith('data:video/');
  const limite = video ? TAMANHO_MAX_VIDEO_WEB : TAMANHO_MAX_IMAGEM_WEB;
  if (bytesDoDataUrl(foto) > limite) {
    return `${video ? 'Vídeo' : 'Foto'} grande demais para a versão web (máx. ${limite / (1024 * 1024)} MB).`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Servidor
// ---------------------------------------------------------------------------

function criarServidor(config) {
  const repo = criarRepositorio({ armazenamento: config.armazenamento, chaveDados: config.chaveDados, log });
  const sessoes = criarGerenciadorSessao(config.chaveDados);
  const estaticos = montarArquivosEstaticos();
  const falhas = new Map(); // chave -> { qtd, desde }
  let bytesRecebendo = 0;
  const bytesPorIp = new Map(); // ip -> bytes reservados (logados)
  const enviosAnonimosPorIp = new Map(); // ip -> envios em andamento (sem login)
  let backupEmAndamento = false;
  let pronto = false;
  let erroInicio = null;

  // (Num link, o "+" do token pode chegar como espaço — por isso a troca antes de comparar.)
  const tokenOk = (token) =>
    !!config.tokenPrimeiroAcesso &&
    typeof token === 'string' &&
    iguaisTempoConstante(token.trim().replace(/ /g, '+'), config.tokenPrimeiroAcesso.trim());

  const handlers = criarHandlers({
    carregar: () => repo.carregar(),
    persistir: (data) => repo.persistir(data),
    // Na web o "PDF" é a própria página do relatório: o navegador abre e imprime ("Salvar como PDF").
    salvarPdf: async (html, { nomeArquivo }) => ({ ok: true, html, nomeArquivo }),
    // Na web o arquivo de backup volta pro navegador, que baixa (exportar) ou envia (importar).
    salvarBackup: async (conteudo, { nomeArquivo }) => ({ ok: true, conteudo, nomeArquivo }),
    lerBackup: async ({ conteudo }) =>
      typeof conteudo === 'string' && conteudo ? { ok: true, conteudo } : { ok: false, cancelado: true },
    prepararPacoteExportacao: (pacote) => repo.embutirMidias(pacote),
    // A tela de criar o Admin aparece numa instalação nova, ou (pra recriar depois de uma
    // importação total) quando o dono abre o link com o token secreto do servidor.
    mostrarTelaConfigurarAdmin: (data, { tokenConfiguracao }) =>
      !data.admin && (!data.primeiroAcessoConcluido || tokenOk(tokenConfiguracao)),
    podeConfigurarAdmin: (data, { tokenConfiguracao }) => {
      if (data.admin) return false;
      if (config.tokenPrimeiroAcesso) {
        return tokenOk(tokenConfiguracao)
          ? true
          : 'Para criar o login do Admin, abra o endereço de configuração com o token secreto ' +
              '(o link termina em ?configurar=… — veja "Primeiro acesso" no README).';
      }
      return logic.precisaConfigurarLoginInicial(data);
    },
  });

  function chavesDeFalha(ip, canal, args) {
    const a = args && args[0];
    let alvo = canal;
    // Login e "entrar como Admin" contam por usuário (e somam juntos).
    if ((canal === 'auth:login' || canal === 'auth:loginAdmin') && a && typeof a.usuario === 'string') {
      alvo = 'login:' + a.usuario.trim().toLowerCase().slice(0, 80);
    }
    return [
      { chave: `${ip}|${alvo}`, max: MAX_FALHAS_IP_E_ALVO },
      { chave: `${ip}|*`, max: MAX_FALHAS_IP },
    ];
  }
  function contagem(chave) {
    const reg = falhas.get(chave);
    if (!reg || Date.now() - reg.desde > JANELA_FALHAS_MS) return 0;
    return reg.qtd;
  }
  function estaBloqueado(chaves) {
    return chaves.some(({ chave, max }) => contagem(chave) >= max);
  }
  function registrarFalha(chaves) {
    const agora = Date.now();
    for (const { chave } of chaves) {
      const reg = falhas.get(chave);
      if (!reg || agora - reg.desde > JANELA_FALHAS_MS) {
        falhas.delete(chave);
        falhas.set(chave, { qtd: 1, desde: agora });
      } else reg.qtd += 1;
    }
    if (falhas.size > 20000) {
      // Tira primeiro o que já venceu; se ainda estiver cheio, os registros mais antigos.
      for (const [chave, reg] of falhas) if (agora - reg.desde > JANELA_FALHAS_MS) falhas.delete(chave);
      for (const chave of falhas.keys()) {
        if (falhas.size <= 15000) break;
        falhas.delete(chave);
      }
    }
  }

  function gravarCookieSessao(req, res, sessao, meta) {
    const seguro = ehHttps(req);
    const nome = seguro ? '__Host-sessao' : 'sessao';
    const atributos = `Path=/; HttpOnly; SameSite=Strict${seguro ? '; Secure' : ''}`;
    if (!sessao.perfil && !sessao.pendenteTrocaSenhaContaId) {
      res.setHeader('Set-Cookie', `${nome}=; ${atributos}; Max-Age=0`);
      return;
    }
    res.setHeader('Set-Cookie', `${nome}=${sessoes.codificar(sessao, meta)}; ${atributos}; Max-Age=${12 * 3600}`);
  }

  function lerSessao(req) {
    const cookies = lerCookies(req);
    // Em HTTPS só vale o cookie "__Host-" (o navegador garante que só este site consegue gravá-lo).
    return sessoes.decodificar(ehHttps(req) ? cookies['__Host-sessao'] : cookies.sessao);
  }

  async function tratarRpc(req, res) {
    // Proteção contra outro site disparando ações em nome de quem está logado (CSRF): exige o
    // cabeçalho próprio do app (outros sites não conseguem mandar sem permissão de CORS, que não
    // existe aqui) e, se o navegador informar a origem, ela tem que ser este mesmo endereço.
    if (req.headers['x-requested-with'] !== 'estoque-web') return responderJson(res, 403, { erro: 'Proibido.' });
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
      return responderJson(res, 415, { erro: 'Tipo de conteúdo inválido.' });
    }
    const origem = req.headers.origin;
    if (origem && origem !== `${ehHttps(req) ? 'https' : 'http'}://${req.headers.host}`) {
      return responderJson(res, 403, { erro: 'Origem não permitida.' });
    }
    if (!pronto) {
      return responderJson(res, 503, {
        r: { ok: false, erro: 'O servidor ainda está conectando ao banco de dados — tente de novo em instantes.' },
      });
    }

    const { sessao, meta } = lerSessao(req);
    // Requisição grande (importar backup): só pra quem está logado, uma de cada vez.
    const ehBackup = new URL(req.url, 'http://x').searchParams.get('grande') === '1';
    if (ehBackup && (!sessao.perfil || backupEmAndamento)) {
      res.setHeader('Connection', 'close');
      res.on('finish', () => req.destroy());
      return responderJson(res, 200, {
        r: {
          ok: false,
          erro: backupEmAndamento
            ? 'Já existe uma importação de backup em andamento — aguarde ela terminar.'
            : 'Sua sessão expirou — entre novamente.',
          sessaoExpirada: !backupEmAndamento,
        },
      });
    }
    const logado = !!sessao.perfil;
    const limite = !logado ? LIMITE_CORPO_ANONIMO : ehBackup ? LIMITE_CORPO_BACKUP : LIMITE_CORPO_LOGADO;
    const anunciado = Number(req.headers['content-length']) || 0;
    const ip = ipDoCliente(req);
    const reservado = logado ? Math.min(anunciado || limite, limite) : 0;
    const recusar = (status, erro) => {
      res.setHeader('Connection', 'close');
      res.on('finish', () => req.destroy());
      return responderJson(res, status, { r: { ok: false, erro } });
    };
    if (anunciado > limite) return recusar(413, 'Arquivo grande demais para enviar.');
    if (
      logado
        ? bytesRecebendo + reservado > LIMITE_BYTES_SIMULTANEOS ||
          (bytesPorIp.get(ip) || 0) + reservado > LIMITE_BYTES_SIMULTANEOS_POR_IP
        : (enviosAnonimosPorIp.get(ip) || 0) >= MAX_ENVIOS_ANONIMOS_POR_IP
    ) {
      return recusar(429, 'Muitos envios ao mesmo tempo — aguarde um instante e tente de novo.');
    }

    // Reserva (e libera, aconteça o que acontecer) a "vaga" desta requisição.
    if (logado) {
      bytesRecebendo += reservado;
      bytesPorIp.set(ip, (bytesPorIp.get(ip) || 0) + reservado);
    } else {
      enviosAnonimosPorIp.set(ip, (enviosAnonimosPorIp.get(ip) || 0) + 1);
    }
    if (ehBackup) backupEmAndamento = true;
    let liberado = false;
    const liberar = () => {
      if (liberado) return;
      liberado = true;
      if (logado) {
        bytesRecebendo -= reservado;
        const resto = (bytesPorIp.get(ip) || 0) - reservado;
        if (resto > 0) bytesPorIp.set(ip, resto);
        else bytesPorIp.delete(ip);
      } else {
        const resto = (enviosAnonimosPorIp.get(ip) || 0) - 1;
        if (resto > 0) enviosAnonimosPorIp.set(ip, resto);
        else enviosAnonimosPorIp.delete(ip);
      }
    };

    let corpo;
    const prazo = setTimeout(() => {
      const erro = new Error('envio lento demais');
      erro.status = 408;
      req.emit('error', erro);
    }, logado ? PRAZO_CORPO_LOGADO_MS : PRAZO_CORPO_ANONIMO_MS);
    try {
      const texto = await lerCorpo(req, limite);
      corpo = JSON.parse(texto);
    } catch (erro) {
      liberar();
      if (ehBackup) backupEmAndamento = false;
      if (erro.status === 413) return recusar(413, 'Arquivo grande demais para enviar.');
      if (erro.status === 408) return recusar(408, 'O envio demorou demais — verifique a internet e tente de novo.');
      return responderJson(res, 400, { r: { ok: false, erro: 'Requisição inválida.' } });
    } finally {
      clearTimeout(prazo);
    }
    liberar();
    try {
      return await processarRpc(req, res, sessao, meta, corpo, ehBackup);
    } finally {
      if (ehBackup) backupEmAndamento = false;
    }
  }

  async function processarRpc(req, res, sessao, meta, corpo, ehBackup) {
    const canal = corpo && corpo.canal;
    if (typeof canal !== 'string' || (ehBackup && canal !== 'backup:importar')) {
      return responderJson(res, 400, { r: { ok: false, erro: 'Requisição inválida.' } });
    }
    const args = Array.isArray(corpo && corpo.args) ? corpo.args : [];
    const ip = ipDoCliente(req);
    // Troca de senha do primeiro acesso sem uma conta pendente nesta sessão não é "chute de senha".
    const semTrocaPendente = canal === 'auth:trocarSenhaPrimeiroAcesso' && !sessao.pendenteTrocaSenhaContaId;

    const chavesFalha = chavesDeFalha(ip, canal, args);
    // `auth:precisaConfigurarLogin` só "usa senha" quando vem com o token do link do Admin.
    const comToken = !!(args[0] && args[0].tokenConfiguracao);
    const usaSenha =
      CANAIS_COM_SENHA.has(canal) && !semTrocaPendente && (canal !== 'auth:precisaConfigurarLogin' || comToken);
    if (usaSenha && estaBloqueado(chavesFalha)) {
      if (canal === 'auth:precisaConfigurarLogin') return responderJson(res, 200, { r: false });
      return responderJson(res, 429, {
        r: { ok: false, erro: 'Muitas tentativas com senha errada. Aguarde 15 minutos e tente de novo.' },
      });
    }
    const erroMidia = conferirTamanhoMidia(canal, args);
    if (erroMidia) return responderJson(res, 200, { r: { ok: false, erro: erroMidia } });

    let resultado;
    try {
      resultado = await repo.comTrava(async () => {
        const data = repo.carregar();
        // Senha trocada, conta excluída, Admin zerado por importação… → essa sessão deixa de valer.
        if (sessao.perfil && impressaoDaSessao(data, sessao) !== meta.impressao) limparSessao(sessao);
        if (!sessao.perfil && !CANAIS_SEM_SESSAO.has(canal)) {
          return { ok: false, erro: 'Sua sessão expirou — entre novamente.', sessaoExpirada: true };
        }
        const r = await executar(handlers, canal, sessao, args);
        meta.impressao = impressaoDaSessao(repo.carregar(), sessao);
        return r;
      });
    } catch (erro) {
      if (erro instanceof ErroConflito) {
        resultado = { ok: false, erro: erro.message };
      } else {
        log('Erro em', canal, '-', erro.stack || erro.message);
        resultado = { ok: false, erro: 'Erro no servidor ao salvar/ler os dados — tente de novo em instantes.' };
      }
    }

    const tokenErrado = canal === 'auth:precisaConfigurarLogin' && comToken && resultado === false;
    if (tokenErrado || (usaSenha && resultado && resultado.ok === false && !resultado.cancelado)) {
      registrarFalha(chavesFalha);
    }
    // Um login novo começa a contar o prazo da sessão do zero.
    if (['auth:login', 'auth:configurarLoginInicial'].includes(canal) && resultado && resultado.ok) meta.inicio = Date.now();
    gravarCookieSessao(req, res, sessao, meta);
    return responderJson(res, 200, { r: resultado === undefined ? null : resultado });
  }

  async function tratarMidia(req, res, id) {
    const { sessao, meta } = lerSessao(req);
    if (!pronto || !sessao.perfil || impressaoDaSessao(repo.carregar(), sessao) !== meta.impressao) {
      res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Não autorizado');
    }
    const midia = await repo.lerMidia(id);
    if (!midia) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Não encontrado');
    }
    const cabecalhos = {
      'Content-Type': midia.tipo,
      'Cache-Control': 'private, max-age=31536000, immutable',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Accept-Ranges': 'bytes',
    };
    // Vídeo no iPhone exige respostas por pedaço (Range).
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
    const total = midia.bytes.length;
    if (range && (range[1] || range[2])) {
      let ini = range[1] ? Number(range[1]) : total - Number(range[2]);
      let fim = range[1] && range[2] ? Number(range[2]) : total - 1;
      ini = Math.max(0, ini);
      fim = Math.min(total - 1, fim);
      if (ini > fim) {
        res.writeHead(416, { 'Content-Range': `bytes */${total}` });
        return res.end();
      }
      res.writeHead(206, { ...cabecalhos, 'Content-Range': `bytes ${ini}-${fim}/${total}`, 'Content-Length': fim - ini + 1 });
      return res.end(req.method === 'HEAD' ? undefined : midia.bytes.subarray(ini, fim + 1));
    }
    res.writeHead(200, { ...cabecalhos, 'Content-Length': total });
    return res.end(req.method === 'HEAD' ? undefined : midia.bytes);
  }

  const servidor = http.createServer(async (req, res) => {
    try {
      cabecalhosSeguranca(req, res);
      const url = new URL(req.url, 'http://localhost');
      const rota = url.pathname;

      if (rota === '/api/vivo') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end('ok');
      }
      if (rota === '/api/saude') {
        // Usado pelo GitHub Actions a cada poucos dias pra manter o Supabase gratuito ativo.
        if (!pronto) return responderJson(res, 503, { ok: false, erro: erroInicio || 'iniciando' });
        try {
          await repo.ping();
          return responderJson(res, 200, { ok: true });
        } catch (erro) {
          return responderJson(res, 503, { ok: false, erro: 'banco indisponível' });
        }
      }
      if (rota === '/api/rpc') {
        if (req.method !== 'POST') return responderJson(res, 405, { erro: 'Use POST.' });
        return await tratarRpc(req, res);
      }
      const mMidia = /^\/api\/midia\/([0-9a-f]{64})$/.exec(rota);
      if (mMidia && (req.method === 'GET' || req.method === 'HEAD')) return await tratarMidia(req, res, mMidia[1]);

      const arquivo = estaticos.get(rota === '/index.html' ? '/' : rota);
      if (arquivo && (req.method === 'GET' || req.method === 'HEAD')) {
        const cab = {
          'Content-Type': arquivo.tipo,
          'Cache-Control': 'no-cache',
          ETag: arquivo.etag,
        };
        if (arquivo.tipo.startsWith('text/html')) cab['Content-Security-Policy'] = CSP_PAGINA;
        if (req.headers['if-none-match'] === arquivo.etag) {
          res.writeHead(304, cab);
          return res.end();
        }
        res.writeHead(200, { ...cab, 'Content-Length': arquivo.conteudo.length });
        return res.end(req.method === 'HEAD' ? undefined : arquivo.conteudo);
      }

      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Não encontrado');
    } catch (erro) {
      log('Erro inesperado:', erro.stack || erro.message);
      if (!res.headersSent) responderJson(res, 500, { erro: 'Erro interno.' });
      else res.end();
    }
  });
  servidor.requestTimeout = 5 * 60 * 1000;
  servidor.headersTimeout = 60 * 1000;

  /** Conecta no banco; se falhar (ex.: Supabase pausado), tenta de novo a cada 30s sem derrubar o site. */
  async function iniciarDados() {
    try {
      await repo.iniciar();
      pronto = true;
      erroInicio = null;
    } catch (erro) {
      erroInicio = erro.message;
      log('Falha ao carregar os dados:', erro.message);
      if (/CHAVE_DADOS/.test(erro.message)) return; // tentar de novo não resolve
      setTimeout(iniciarDados, 30000).unref();
    }
  }

  return { servidor, iniciarDados, estaPronto: () => pronto };
}

if (require.main === module) {
  let config;
  try {
    config = lerConfiguracao();
  } catch (erro) {
    console.error('Configuração inválida:', erro.message);
    process.exit(1);
  }
  const { servidor, iniciarDados } = criarServidor(config);
  servidor.listen(config.porta, () => log(`Controle de Estoque (web) ouvindo na porta ${config.porta}.`));
  iniciarDados();
  process.on('SIGTERM', () => servidor.close(() => process.exit(0)));
}

module.exports = { criarServidor, lerConfiguracao };
