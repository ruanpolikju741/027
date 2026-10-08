'use strict';

const state = {
  perfil: null, // null (ainda não logou) | 'default' | 'admin'
  usuarioLogado: null, // usuário (texto) da conta autenticada nesta sessão — só pra exibir na tela
  usuarioAdmin: null, // conta com acesso de Admin que está no modo Admin agora (null = Admin principal)
  items: [],
  usuarios: [],
  busca: '',
  buscaUsuario: '',
  filtroHistoricoImportado: false,
  filtroHistoricoPendente: false,
  filtroHistoricoUsuario: '', // '' = todos os usuários
  // Por padrão (os dois null) a aba Histórico mostra TUDO — "De"/"Até" são um filtro opcional.
  historicoDataInicio: null,
  historicoDataFim: null,
  consultarModo: 'usuario', // 'usuario' | 'item'
  consultaAtual: null, // filtro (modo, usuarioId/itemId, período) do último "Consultar" bem-sucedido — usado pelo botão "Exportar PDF"
  pendenciaUsuarioAtual: null, // usuário aberto no detalhamento da aba "Pendências"
};

// ---------------------------------------------------------------------------
// Utilitários
// ---------------------------------------------------------------------------

function qs(sel, root) { return (root || document).querySelector(sel); }
function qsa(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }

function escapeHtml(texto) {
  return String(texto)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

let toastTimeout = null;
function toast(mensagem, tipo) {
  const el = qs('#toast');
  el.textContent = mensagem;
  el.className = 'toast' + (tipo === 'erro' ? ' erro' : '');
  el.classList.remove('hidden');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => el.classList.add('hidden'), 3200);
}

function formatarDataHora(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function formatarDia(diaISO) {
  const [ano, mes, dia] = diaISO.split('-');
  return `${dia}/${mes}/${ano}`;
}

function formatarDataHoraCompleta(iso) {
  return new Date(iso).toLocaleString('pt-BR');
}

/** Mantém a mesma regra de identificação de usuário usada no processo principal
 * (src/logic.js): nome se houver, senão "Nº final XXXX" pelo telefone. */
function apenasDigitos(valor) {
  return String(valor || '').replace(/\D/g, '');
}
function final4Telefone(telefone) {
  const digitos = apenasDigitos(telefone);
  if (!digitos) return '????';
  return digitos.slice(-4).padStart(4, '0');
}
function rotuloUsuario(usuario) {
  if (usuario.nome && String(usuario.nome).trim()) {
    return `${String(usuario.nome).trim()} (•${final4Telefone(usuario.telefone)})`;
  }
  return `Nº final ${final4Telefone(usuario.telefone)}`;
}

/** Rótulo usado em listas/seletores de usuário, com uma estrela na frente quando favorito. */
function rotuloUsuarioComEstrela(usuario) {
  return usuario.favorito ? `★ ${rotuloUsuario(usuario)}` : rotuloUsuario(usuario);
}

/** true se a data URL for de vídeo (ex.: "data:video/mp4;base64,..."). */
function ehVideoDataUrl(url) {
  // No desktop a mídia é sempre um data URL; na versão web, depois de salva, vira um endereço
  // `/api/midia/<id>` — que termina em `?tipo=video` quando é vídeo.
  return typeof url === 'string' && (url.startsWith('data:video') || /[?&]tipo=video(&|$)/.test(url));
}

/** Tamanho máximo aceito para vídeo anexado (fica embutido no arquivo de dados local criptografado). */
const TAMANHO_MAX_VIDEO_BYTES = 25 * 1024 * 1024; // 25MB

/**
 * Processa um arquivo de mídia (foto ou vídeo) escolhido pelo usuário antes de anexar:
 * imagens são redimensionadas/comprimidas (ver redimensionarImagem); vídeos não dá pra
 * comprimir só com o navegador, então são lidos como estão, com um limite de tamanho pra
 * não inchar demais o arquivo de dados local.
 */
function processarArquivoMidia(file, { maxDim = 700, qualidade = 0.72 } = {}) {
  if (file.type && file.type.startsWith('video/')) {
    if (file.size > TAMANHO_MAX_VIDEO_BYTES) {
      return Promise.reject(
        new Error(
          `Vídeo muito grande (máx. ${Math.round(TAMANHO_MAX_VIDEO_BYTES / (1024 * 1024))}MB) — escolha um arquivo menor.`
        )
      );
    }
    return new Promise((resolve, reject) => {
      const leitor = new FileReader();
      leitor.onerror = () => reject(new Error('Falha ao ler o arquivo de vídeo.'));
      leitor.onload = () => resolve(leitor.result);
      leitor.readAsDataURL(file);
    });
  }
  return redimensionarImagem(file, maxDim, qualidade);
}

/** Mostra (ou limpa) a pré-visualização de uma mídia num container genérico (div), como
 * imagem ou vídeo conforme o tipo — e guarda a data URL em `dataset.dataurl` pra ser lida
 * na hora de salvar. */
function definirPreviewMidia(containerEl, dataUrl) {
  if (!containerEl) return;
  if (!dataUrl) {
    containerEl.innerHTML = '';
    containerEl.dataset.dataurl = '';
    containerEl.classList.add('hidden');
    return;
  }
  containerEl.dataset.dataurl = dataUrl;
  containerEl.innerHTML = ehVideoDataUrl(dataUrl)
    ? `<video src="${dataUrl}" controls></video>`
    : `<img src="${dataUrl}" alt="Pré-visualização" />`;
  containerEl.classList.remove('hidden');
}

/** Selo visual de origem de uma transação: veio de uma importação (mesclada ou total) ou é local. */
function origemBadgeHtml(t) {
  return t.importado
    ? '<span class="badge-origem badge-origem-import">Importado</span>'
    : '<span class="badge-origem badge-origem-local">Local</span>';
}

/** Selo visual de status de pagamento de uma transação: Pendente ou Concluído. */
function statusBadgeHtml(t) {
  if (!t.usuarioId && !t.usuarioNome) return '—';
  const badge = t.pendente
    ? '<span class="badge-status badge-status-pendente">Pendente</span>'
    : '<span class="badge-status badge-status-concluido">Concluído</span>';
  // Controle informal do Default (ver `marcarRecebidoDefaultTransacao`/`...Lancamento`): não
  // resolve a pendência de verdade, só avisa o Admin que o Default já diz ter recebido.
  const avisoRecebido =
    t.pendente && t.marcadoRecebidoDefault
      ? ' <span class="badge-recebido-default" title="O perfil Default marcou como recebido — a pendência só some de verdade quando o Admin confirmar">📝 Default marcou como recebido</span>'
      : '';
  return badge + avisoRecebido;
}

/**
 * Botão do controle informal do Default ("flegar" como recebido, ver `statusBadgeHtml` acima):
 * só aparece pro perfil Default, e só enquanto o registro ainda está pendente (uma vez
 * concluído pelo Admin, a marcação já foi zerada — ver `definirPendenteTransacao`/
 * `definirPendenteLancamento`). `dataAttr` é o nome (kebab-case) do atributo `data-*` usado
 * pra identificar o registro, ex.: "marcar-recebido-transacao" → dataset.marcarRecebidoTransacao.
 */
function botaoRecebidoDefaultHtml(registro, dataAttr) {
  if (state.perfil === 'admin' || !registro.pendente) return '';
  const marcado = !!registro.marcadoRecebidoDefault;
  return `<button class="btn-marcar-recebido" data-${dataAttr}="${registro.id}" data-marcado-atual="${marcado ? '1' : '0'}" title="${
    marcado
      ? 'Desmarcar (a pendência ainda não foi confirmada pelo Admin)'
      : 'Marcar como recebido — é só um controle seu, a pendência some mesmo é quando o Admin confirmar'
  }">${marcado ? '📝 Marcado — desmarcar' : '📝 Marcar como recebido'}</button>`;
}

/** Texto de entrega/retirada de uma transação, ou "—" quando não há usuário atrelado. */
function entregaTextoHtml(t) {
  if (!t.tipoEntrega) return '—';
  return t.tipoEntrega === 'entrega' ? 'Entrega' : 'Retirada';
}

/** Formata um número como valor em reais (R$ 0,00). */
function formatarMoeda(valor) {
  const numero = Number(valor) || 0;
  return numero.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

/** Gera o <img>/<video> de miniatura clicável do histórico (abre no lightbox ao clicar). */
function thumbMidiaHtml(url, chaveClique) {
  if (!url) return '—';
  return ehVideoDataUrl(url)
    ? `<video class="thumb-historico" src="${url}" data-foto="${chaveClique}" muted preload="metadata"></video>`
    : `<img class="thumb-historico" src="${url}" data-foto="${chaveClique}" />`;
}

/** Redimensiona/comprime uma imagem no navegador antes de enviar para o backend. */
function redimensionarImagem(file, maxDim, qualidade) {
  maxDim = maxDim || 700;
  qualidade = qualidade || 0.72;
  return new Promise((resolve, reject) => {
    const leitor = new FileReader();
    leitor.onerror = () => reject(new Error('Falha ao ler o arquivo de imagem.'));
    leitor.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Arquivo de imagem inválido.'));
      img.onload = () => {
        let { width, height } = img;
        if (width > height && width > maxDim) {
          height = Math.round((height * maxDim) / width);
          width = maxDim;
        } else if (height > maxDim) {
          width = Math.round((width * maxDim) / height);
          height = maxDim;
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', qualidade));
      };
      img.src = leitor.result;
    };
    leitor.readAsDataURL(file);
  });
}

// ---------------------------------------------------------------------------
// Inicialização
// ---------------------------------------------------------------------------

async function init() {
  // A montagem dos listeners (uma única vez, na vida do app) vem ANTES de qualquer tela de
  // login — tanto a de primeiro acesso quanto a obrigatória — porque as duas usam botões
  // estáticos do HTML que já existem no DOM; nenhuma delas depende de dado carregado ainda.
  configurarEventosEstaticos();
  configurarDelegacaoCatalogo();
  configurarConsultar();
  configurarPrecificacao();
  configurarModalLancamentos();
  configurarPendencias();

  const precisaConfigurar = await window.api.auth.precisaConfigurarLogin();
  if (precisaConfigurar) {
    // Só numa instalação genuinamente nova (nenhum admin configurado ainda) — cria o login do
    // Admin e já entra automaticamente com ele, sem passar pela tela de login normal.
    await exigirConfiguracaoInicial();
  } else {
    // Toda outra execução (inclusive instalações já existentes, que já tinham o Admin configurado
    // antes desse recurso existir) precisa logar — não existe mais entrada livre do Default.
    await exigirLogin();
  }

  await carregarDadosDoApp();
}

/**
 * Carrega/renderiza tudo que depende de já estar autenticado. Além da primeira vez (chamada por
 * `init` depois do login), roda de novo depois de um logout/troca de usuário (`voltarParaTelaDeLogin`),
 * já que os dados (e o perfil) podem ser bem diferentes do que estavam antes.
 */
/** Atualiza perfil + nomes exibidos a partir da sessão (vale também depois de recarregar a página). */
async function atualizarQuemSou() {
  const eu = await window.api.auth.quemSou();
  state.perfil = eu.perfil;
  state.usuarioLogado = eu.usuario;
  state.usuarioAdmin = eu.usuarioAdmin;
}

async function carregarDadosDoApp() {
  await atualizarQuemSou();
  await Promise.all([carregarItens(), carregarUsuarios()]);
  aplicarPerfilNaUI();
  renderCatalogo();
  renderUsuarios();
  atualizarSelectsConsultar();
  await inicializarHistorico();
  await atualizarBannerDesfazer();
  await renderPrecificacao();
  await renderPendencias();
  if (state.perfil === 'admin') {
    await renderContasLogin();
  }
}

/**
 * Primeira execução do app nesta máquina DE VERDADE: ainda não existe login de Admin configurado
 * e a máquina nunca passou por essa tela antes (ver `primeiroAcessoConcluido` em
 * `criarDadosIniciais`/`precisaConfigurarLoginInicial` em src/logic.js). Bloqueia com um modal
 * (sem botão de cancelar — é obrigatório) até a pessoa criar seu próprio usuário/senha; só então
 * o resto do app é inicializado. A senha é guardada criptografada como qualquer outro dado.
 *
 * Importante: uma importação TOTAL de backup zera o Admin local (ver `aplicarPacoteImportacao`),
 * mas propositalmente NÃO faz essa tela reaparecer — depois dela o app só volta pra tela de login
 * normal (`exigirLogin`), onde, sem nenhum Admin configurado, só as contas trazidas pelo arquivo
 * conseguem entrar. Isso evita que qualquer pessoa (mesmo alguém logado como Default, que também
 * pode fazer essa importação) vire Admin desta máquina só de importar um arquivo e passar por
 * este assistente.
 */
function exigirConfiguracaoInicial() {
  return new Promise((resolve) => {
    const modal = qs('#modal-primeiro-acesso');
    const erroEl = qs('#primeiro-acesso-erro');
    modal.classList.remove('hidden');
    qs('#primeiro-acesso-usuario').focus();

    async function tentarCriar() {
      const usuario = qs('#primeiro-acesso-usuario').value.trim();
      const senha = qs('#primeiro-acesso-senha').value;
      const confirmarSenha = qs('#primeiro-acesso-confirmar').value;
      erroEl.classList.add('hidden');

      if (!usuario) {
        mostrarErroInline(erroEl, 'Informe um nome de usuário.');
        return;
      }
      if (!senha || senha.length < 6) {
        mostrarErroInline(erroEl, 'A senha precisa ter no mínimo 6 caracteres (letras, números e símbolos são permitidos).');
        return;
      }
      if (senha !== confirmarSenha) {
        mostrarErroInline(erroEl, 'As senhas não coincidem.');
        return;
      }
      const res = await window.api.auth.configurarLoginInicial(usuario, senha);
      if (!res.ok) {
        mostrarErroInline(erroEl, res.erro || 'Não foi possível criar o login.');
        return;
      }
      modal.classList.add('hidden');
      qs('#primeiro-acesso-confirmar-btn').removeEventListener('click', tentarCriar);
      resolve();
    }

    qs('#primeiro-acesso-confirmar-btn').addEventListener('click', tentarCriar);
    [qs('#primeiro-acesso-usuario'), qs('#primeiro-acesso-senha'), qs('#primeiro-acesso-confirmar')].forEach((input) => {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') tentarCriar();
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Modal: login obrigatório (toda vez que o app abre, exceto na primeiríssima
// execução — ver exigirConfiguracaoInicial acima — e depois de qualquer
// importação de backup, ver voltarParaTelaDeLogin/configurarBackup)
// ---------------------------------------------------------------------------
//
// Diferente de exigirConfiguracaoInicial (que só roda uma vez na vida do app), este modal pode
// aparecer várias vezes na mesma sessão — por isso os listeners dos botões/inputs são montados
// UMA VEZ (configurarModalLogin, chamada por configurarEventosEstaticos) e exigirLogin() só
// prepara os campos e devolve uma Promise que fica pendente até o login (com troca de senha, se
// for o caso) terminar.

let resolverLoginPendente = null;
let contaPendenteTrocaSenhaId = null;
let senhaAtualParaTrocaPendente = null;

function configurarModalLogin() {
  const erroEl = qs('#login-erro');
  const erroTrocarEl = qs('#login-trocar-senha-erro');

  function finalizarLogin() {
    qs('#modal-login').classList.add('hidden');
    contaPendenteTrocaSenhaId = null;
    senhaAtualParaTrocaPendente = null;
    const resolver = resolverLoginPendente;
    resolverLoginPendente = null;
    if (resolver) resolver();
  }

  async function tentarLogin() {
    erroEl.classList.add('hidden');
    const usuario = qs('#login-usuario').value.trim();
    const senha = qs('#login-senha').value;
    if (!usuario || !senha) {
      mostrarErroInline(erroEl, 'Informe usuário e senha.');
      return;
    }
    const res = await window.api.auth.login(usuario, senha);
    if (!res.ok) {
      mostrarErroInline(erroEl, res.erro || 'Usuário ou senha inválidos.');
      return;
    }
    if (res.precisaTrocarSenha) {
      // Conta com senha temporária (recém-criada ou resetada pelo Admin) — precisa escolher uma
      // senha nova antes de liberar o acesso (ver auth:trocarSenhaPrimeiroAcesso em main.js).
      contaPendenteTrocaSenhaId = res.contaId;
      senhaAtualParaTrocaPendente = senha;
      state.usuarioLogado = res.usuario || null;
      qs('#login-passo-credenciais').classList.add('hidden');
      qs('#login-passo-trocar-senha').classList.remove('hidden');
      qs('#login-nova-senha').value = '';
      qs('#login-nova-senha-confirmar').value = '';
      erroTrocarEl.classList.add('hidden');
      qs('#login-nova-senha').focus();
      return;
    }
    state.usuarioLogado = res.usuario || null;
    finalizarLogin();
  }

  async function tentarTrocarSenhaPrimeiroAcesso() {
    erroTrocarEl.classList.add('hidden');
    const novaSenha = qs('#login-nova-senha').value;
    const confirmarSenha = qs('#login-nova-senha-confirmar').value;
    if (!novaSenha || novaSenha.length < 6) {
      mostrarErroInline(
        erroTrocarEl,
        'A nova senha precisa ter no mínimo 6 caracteres (letras, números e símbolos são permitidos).'
      );
      return;
    }
    if (novaSenha !== confirmarSenha) {
      mostrarErroInline(erroTrocarEl, 'As senhas não coincidem.');
      return;
    }
    const res = await window.api.auth.trocarSenhaPrimeiroAcesso(
      contaPendenteTrocaSenhaId,
      senhaAtualParaTrocaPendente,
      novaSenha
    );
    if (!res.ok) {
      mostrarErroInline(erroTrocarEl, res.erro || 'Não foi possível trocar a senha.');
      return;
    }
    finalizarLogin();
  }

  qs('#login-confirmar-btn').addEventListener('click', tentarLogin);
  qs('#login-trocar-senha-btn').addEventListener('click', tentarTrocarSenhaPrimeiroAcesso);
  [qs('#login-usuario'), qs('#login-senha')].forEach((input) => {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') tentarLogin();
    });
  });
  [qs('#login-nova-senha'), qs('#login-nova-senha-confirmar')].forEach((input) => {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') tentarTrocarSenhaPrimeiroAcesso();
    });
  });
}

function exigirLogin() {
  return new Promise((resolve) => {
    resolverLoginPendente = resolve;
    qs('#login-passo-credenciais').classList.remove('hidden');
    qs('#login-passo-trocar-senha').classList.add('hidden');
    qs('#login-usuario').value = '';
    qs('#login-senha').value = '';
    qs('#login-erro').classList.add('hidden');
    qs('#login-trocar-senha-erro').classList.add('hidden');
    qs('#modal-login').classList.remove('hidden');
    qs('#login-usuario').focus();
  });
}

/**
 * Sai de vez da sessão atual (botão "Sair", ou depois de qualquer importação de backup — ver
 * configurarBackup) e volta pra tela de login obrigatória, já refletindo os dados/contas que
 * ficaram valendo (no caso de uma importação, os que vieram no arquivo).
 *
 * Uma importação TOTAL ("substituir tudo") zera o login do Admin desta máquina de propósito (ver
 * `aplicarPacoteImportacao` em src/logic.js), mas isso NÃO faz a tela de "criar login de Admin"
 * reaparecer (`precisaConfigurarLogin` continua `false` — ver `precisaConfigurarLoginInicial`):
 * a checagem abaixo é só uma defesa a mais para o caso (que não deveria acontecer na prática, já
 * que chegar aqui exige estar logado, o que já exige ter passado pelo primeiro acesso antes) de
 * `precisaConfigurarLogin` vir `true`. No caminho normal, o app sempre volta pro modal de login de
 * sempre — e, sem nenhum Admin configurado depois de uma importação total, só as contas de login
 * trazidas pelo arquivo conseguem entrar (nunca um Admin novo criado na hora).
 */
async function voltarParaTelaDeLogin() {
  state.perfil = null;
  state.usuarioLogado = null;
  state.usuarioAdmin = null;
  // Estado de navegação/filtro que só fazia sentido pra sessão anterior.
  state.busca = '';
  state.buscaUsuario = '';
  state.filtroHistoricoUsuario = '';
  state.pendenciaUsuarioAtual = null;
  qs('#busca-item').value = '';
  qs('#busca-usuario').value = '';
  qs('#pendencias-detalhe').classList.add('hidden');
  qsa('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === 'catalogo'));
  qsa('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === 'tab-catalogo'));

  const precisaConfigurar = await window.api.auth.precisaConfigurarLogin();
  if (precisaConfigurar) {
    await exigirConfiguracaoInicial();
  } else {
    await exigirLogin();
  }
  await carregarDadosDoApp();
}

async function carregarItens() {
  state.items = await window.api.items.list();
}
async function carregarUsuarios() {
  state.usuarios = await window.api.usuarios.list();
}

function aplicarPerfilNaUI() {
  const label = qs('#perfil-label');
  const btnToggle = qs('#btn-admin-toggle');
  if (state.perfil === 'admin') {
    // O Admin é um usuário próprio, não um "privilégio" emprestado de uma conta do Default — o
    // rótulo nunca mostra o usuário de uma conta do Default por baixo, mesmo quando o modo Admin
    // foi alcançado por uma escalada mid-sessão (botão "Entrar como Admin" a partir do Default —
    // ver `sessao.contaLoginId` em main.js, que só serve pra saber pra onde voltar ao SAIR do
    // modo Admin, não pra identificar quem está logado agora).
    // Uma conta promovida a Admin pelo Admin aparece com o próprio nome (é ela que é Admin).
    label.textContent = 'Perfil: Admin' + (state.usuarioAdmin ? ` (${state.usuarioAdmin})` : '');
    label.classList.add('admin');
    btnToggle.textContent = 'Sair do modo Admin';
  } else {
    const sufixoUsuario = state.usuarioLogado ? ` (${state.usuarioLogado})` : '';
    label.textContent = 'Perfil: Default' + sufixoUsuario;
    label.classList.remove('admin');
    btnToggle.textContent = 'Entrar como Admin';
  }
  qsa('.admin-only').forEach((el) => {
    el.classList.toggle('hidden', state.perfil !== 'admin');
  });
  qsa('.default-only').forEach((el) => {
    el.classList.toggle('hidden', state.perfil === 'admin');
  });
  // "Trocar login do Admin" mexe só no Admin principal — uma conta promovida troca a própria senha
  // pedindo a outro Admin um "Resetar senha".
  const btnTrocarLogin = qs('#btn-trocar-login-admin');
  if (btnTrocarLogin) btnTrocarLogin.classList.toggle('hidden', state.perfil !== 'admin' || !!state.usuarioAdmin);
}

// ---------------------------------------------------------------------------
// Abas
// ---------------------------------------------------------------------------

function configurarEventosEstaticos() {
  qsa('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      qsa('.tab-btn').forEach((b) => b.classList.remove('active'));
      qsa('.tab-panel').forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      qs('#tab-' + btn.dataset.tab).classList.add('active');
    });
  });

  qs('#busca-item').addEventListener('input', (e) => {
    state.busca = e.target.value.trim().toLowerCase();
    renderCatalogo();
  });

  qs('#busca-usuario').addEventListener('input', (e) => {
    state.buscaUsuario = e.target.value.trim().toLowerCase();
    renderUsuarios();
  });

  configurarBuscaEmSelectUsuario(qs('#consultar-usuario-busca'), qs('#consultar-usuario-select'));

  qs('#btn-admin-toggle').addEventListener('click', () => {
    if (state.perfil === 'admin') {
      sairAdmin();
    } else {
      abrirModalLoginAdmin();
    }
  });

  qs('#btn-sair').addEventListener('click', () => {
    abrirConfirm(
      'Sair',
      'Sair da conta atual e voltar pra tela de login? Isso não afeta nenhum dado — é só pra trocar de usuário.',
      async () => {
        await window.api.auth.logout();
        await voltarParaTelaDeLogin();
      }
    );
  });

  configurarModalLogin();
  configurarModalLoginAdmin();
  configurarModalTrocarLoginAdmin();
  configurarContasLogin();
  configurarModalItem();
  configurarModalEditarUsuario();
  configurarModalMovimentar();
  configurarModalConfirm();
  configurarLightbox();
  configurarBackup();
  configurarBannerDesfazer();

  qs('#btn-add-usuario').addEventListener('click', onAdicionarUsuarioClick);
  ['#novo-usuario-telefone', '#novo-usuario-nome'].forEach((sel) => {
    qs(sel).addEventListener('keydown', (e) => {
      if (e.key === 'Enter') onAdicionarUsuarioClick();
    });
  });

  qs('#historico-data-inicio').addEventListener('change', (e) => {
    state.historicoDataInicio = e.target.value || null;
    renderHistoricoDoDia();
  });
  qs('#historico-data-fim').addEventListener('change', (e) => {
    state.historicoDataFim = e.target.value || null;
    renderHistoricoDoDia();
  });
  qs('#btn-historico-limpar-periodo').addEventListener('click', () => {
    state.historicoDataInicio = null;
    state.historicoDataFim = null;
    qs('#historico-data-inicio').value = '';
    qs('#historico-data-fim').value = '';
    renderHistoricoDoDia();
  });
  qs('#historico-filtro-importado').addEventListener('change', (e) => {
    state.filtroHistoricoImportado = e.target.checked;
    renderHistoricoDoDia();
  });
  qs('#historico-filtro-pendente').addEventListener('change', (e) => {
    state.filtroHistoricoPendente = e.target.checked;
    renderHistoricoDoDia();
  });
  configurarAutocompleteHistoricoUsuario();
  configurarExclusaoHistorico();
  configurarRelatorioPdf();
  configurarExportarQuantidadesPdf();

  qs('#btn-usuarios-excluir-todos').addEventListener('click', () => {
    if (state.usuarios.length === 0) return;
    abrirConfirm(
      'Excluir todos os usuários',
      `Excluir todos os ${state.usuarios.length} usuário(s) cadastrado(s)? O histórico já registrado é ` +
        'mantido (com o nome/telefone gravado na hora), só o cadastro de usuários é apagado. Não pode ser ' +
        'desfeito.',
      async () => {
        const res = await window.api.usuarios.excluirTodos();
        if (!res.ok) {
          toast(res.erro, 'erro');
          return;
        }
        await carregarUsuarios();
        renderUsuarios();
        renderCatalogo();
        atualizarSelectsConsultar();
        toast(`${res.removidos} usuário(s) excluído(s).`);
      }
    );
  });
}

// ---------------------------------------------------------------------------
// Modal: login admin
// ---------------------------------------------------------------------------

function abrirModalLoginAdmin() {
  qs('#admin-usuario').value = '';
  qs('#admin-senha').value = '';
  qs('#admin-login-erro').classList.add('hidden');
  qs('#modal-admin-login').classList.remove('hidden');
  qs('#admin-usuario').focus();
}

function fecharModalLoginAdmin() {
  qs('#modal-admin-login').classList.add('hidden');
}

function configurarModalLoginAdmin() {
  qs('#admin-login-cancelar').addEventListener('click', fecharModalLoginAdmin);
  qs('#admin-senha').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') qs('#admin-login-confirmar').click();
  });
  qs('#admin-login-confirmar').addEventListener('click', async () => {
    const usuario = qs('#admin-usuario').value.trim();
    const senha = qs('#admin-senha').value;
    const res = await window.api.auth.loginAdmin(usuario, senha);
    if (res.ok) {
      state.perfil = res.perfil;
      state.usuarioAdmin = res.usuarioAdmin || null;
      fecharModalLoginAdmin();
      aplicarPerfilNaUI();
      renderCatalogo();
      await renderHistoricoDoDia();
      await atualizarBannerDesfazer();
      await renderPrecificacao();
      await renderPendencias();
      await renderContasLogin();
      toast('Modo admin ativado.');
    } else {
      const erroEl = qs('#admin-login-erro');
      erroEl.textContent = res.erro || 'Não foi possível entrar.';
      erroEl.classList.remove('hidden');
    }
  });
}

// ---------------------------------------------------------------------------
// Modal: trocar login do Admin (usuário/senha) — exclusivo do Admin
// ---------------------------------------------------------------------------

function abrirModalTrocarLoginAdmin() {
  qs('#trocar-login-senha-atual').value = '';
  qs('#trocar-login-novo-usuario').value = '';
  qs('#trocar-login-nova-senha').value = '';
  qs('#trocar-login-confirmar-senha').value = '';
  qs('#trocar-login-erro').classList.add('hidden');
  qs('#modal-trocar-login-admin').classList.remove('hidden');
  qs('#trocar-login-senha-atual').focus();
}

function fecharModalTrocarLoginAdmin() {
  qs('#modal-trocar-login-admin').classList.add('hidden');
}

function configurarModalTrocarLoginAdmin() {
  qs('#btn-trocar-login-admin').addEventListener('click', abrirModalTrocarLoginAdmin);
  qs('#trocar-login-cancelar').addEventListener('click', fecharModalTrocarLoginAdmin);

  qs('#trocar-login-confirmar').addEventListener('click', async () => {
    const erroEl = qs('#trocar-login-erro');
    erroEl.classList.add('hidden');

    const senhaAtual = qs('#trocar-login-senha-atual').value;
    const novoUsuario = qs('#trocar-login-novo-usuario').value.trim();
    const novaSenha = qs('#trocar-login-nova-senha').value;
    const confirmarSenha = qs('#trocar-login-confirmar-senha').value;

    if (!senhaAtual) {
      mostrarErroInline(erroEl, 'Informe a senha atual do Admin.');
      return;
    }
    if (!novoUsuario) {
      mostrarErroInline(erroEl, 'Informe o novo usuário do Admin.');
      return;
    }
    if (!novaSenha || novaSenha.length < 6) {
      mostrarErroInline(erroEl, 'A nova senha precisa ter no mínimo 6 caracteres (letras, números e símbolos são permitidos).');
      return;
    }
    if (novaSenha !== confirmarSenha) {
      mostrarErroInline(erroEl, 'As senhas não coincidem.');
      return;
    }

    const res = await window.api.auth.redefinirLoginAdmin(senhaAtual, novoUsuario, novaSenha);
    if (!res.ok) {
      mostrarErroInline(erroEl, res.erro || 'Não foi possível trocar o login.');
      return;
    }
    fecharModalTrocarLoginAdmin();
    toast('Login do Admin atualizado.');
  });
}

async function sairAdmin() {
  const res = await window.api.auth.logoutAdmin();
  state.perfil = res.perfil;
  state.usuarioAdmin = null;
  aplicarPerfilNaUI();
  renderCatalogo();
  await renderHistoricoDoDia();
  await atualizarBannerDesfazer();
  await renderPrecificacao();
  await renderPendencias();
  toast('Voltou para o perfil Default.');
}

// ---------------------------------------------------------------------------
// Catálogo
// ---------------------------------------------------------------------------

function itensFiltrados() {
  if (!state.busca) return state.items;
  return state.items.filter((i) => i.nome.toLowerCase().includes(state.busca));
}

function renderCatalogo() {
  const grid = qs('#catalogo-grid');
  const lista = itensFiltrados();
  qs('#catalogo-vazio').classList.toggle('hidden', state.items.length !== 0);
  grid.innerHTML = lista.map(cardHTML).join('');
}

function cardHTML(item) {
  const isAdmin = state.perfil === 'admin';
  const fotoHtml = item.foto
    ? ehVideoDataUrl(item.foto)
      ? `<video src="${item.foto}" muted preload="metadata"></video>`
      : `<img src="${item.foto}" alt="${escapeHtml(item.nome)}" />`
    : `<span class="placeholder"><svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h3l2-2h6l2 2h3v11H4V8Z"/><circle cx="12" cy="13.5" r="3.2"/></svg></span>`;
  const usuariosOptions = state.usuarios
    .map(
      (u) =>
        `<option value="${u.id}" data-busca="${escapeHtml(buscaTextoUsuario(u))}">${escapeHtml(rotuloUsuarioComEstrela(u))}</option>`
    )
    .join('');

  return `
    <div class="card" data-item-id="${item.id}">
      <div class="card-foto" data-action="ver-foto-item">${fotoHtml}</div>
      <div class="card-body">
        <h3>${escapeHtml(item.nome)}</h3>
        <div class="qtd-atual">${item.quantidade} <span>un.</span></div>

        <div class="card-secao-movimentar">
          <div class="qtd-controls">
            <button class="btn-minus" data-action="selecionar-saida" title="Selecionar remover quantidade">−</button>
            <input type="number" class="qtd-input" min="1" step="1" value="1" />
            <button class="btn-plus${isAdmin ? '' : ' hidden'}" data-action="selecionar-entrada" title="Selecionar adicionar quantidade">+</button>
          </div>
          <button class="btn btn-primary btn-pequeno btn-confirmar-qtd" data-action="confirmar-qtd" disabled>Confirmar</button>
          ${
            isAdmin
              ? `<button class="btn-toggle-extra" data-action="toggle-extra"><span class="seta-toggle">▸</span> Usuário / foto (opcional)</button>`
              : `<label class="campo-label campo-obrigatorio">Usuário <span class="tag-obrigatorio">obrigatório</span></label>`
          }
          <div class="extra-panel${isAdmin ? ' hidden' : ''}">
            <input type="text" class="usuario-busca" placeholder="Buscar usuário por nome ou telefone…" />
            <select class="sel-usuario">
              <option value="">${isAdmin ? '— nenhum usuário —' : 'Selecione um usuário…'}</option>
              ${usuariosOptions}
              <option value="__novo__">${isAdmin ? '+ Novo usuário…' : '+ Novo usuário (só para remover)…'}</option>
            </select>
            <div class="novo-usuario-campos hidden">
              <input type="tel" class="novo-usuario-telefone" placeholder="Telefone (obrigatório)" maxlength="20" />
              <input type="text" class="novo-usuario-nome-inline" placeholder="Nome (opcional)" maxlength="80" />
            </div>
            <div class="pagamento-row hidden">
              <label><input type="radio" name="entrega-${item.id}" value="entrega" /> Entrega</label>
              <label><input type="radio" name="entrega-${item.id}" value="retirada" /> Retirada</label>
              ${
                isAdmin
                  ? `<label class="pendente-checkbox"><input type="checkbox" class="chk-pendente" /> Pendente</label>`
                  : `<span class="pendente-fixo" title="O perfil Default sempre registra como pendente — só o Admin confirma depois">🔒 Sempre pendente</span>`
              }
            </div>
            <div class="foto-row${isAdmin ? '' : ' hidden'}">
              <input type="file" accept="image/*,video/*" class="foto-input" />
              <div class="preview-pequena hidden"></div>
            </div>
            ${
              isAdmin
                ? ''
                : '<p class="dica-pequena">O perfil Default só pode <strong>remover</strong> quantidade (nunca adicionar). Errou? Use "Desfazer última movimentação" no topo desta aba (só funciona nesta sessão do app).</p>'
            }
            <p class="erro-inline hidden"></p>
          </div>
        </div>

        <button class="btn-link-discreto" data-action="ver-historico-item">🕘 Ver histórico deste item</button>
        <div class="card-rodape admin-only${isAdmin ? '' : ' hidden'}">
          <button class="btn btn-texto btn-pequeno" data-action="edit-item">Editar</button>
          <button class="btn btn-perigo btn-pequeno" data-action="remove-item">Remover do catálogo</button>
        </div>
      </div>
    </div>
  `;
}

function configurarDelegacaoCatalogo() {
  const grid = qs('#catalogo-grid');

  grid.addEventListener('click', async (e) => {
    const card = e.target.closest('.card');
    if (!card) return;
    const itemId = card.dataset.itemId;
    const acao = e.target.closest('[data-action]')?.dataset.action;
    if (!acao) return;

    if (acao === 'toggle-extra') {
      const painelExtra = qs('.extra-panel', card);
      const aberto = painelExtra.classList.toggle('hidden') === false; // toggle() devolve se a classe FICOU presente
      const btnToggle = e.target.closest('[data-action="toggle-extra"]');
      const seta = qs('.seta-toggle', btnToggle);
      if (seta) seta.textContent = aberto ? '▾' : '▸';
      btnToggle.classList.toggle('aberto', aberto);
      return;
    }
    if (acao === 'ver-foto-item') {
      const item = state.items.find((i) => i.id === itemId);
      if (item && item.foto) abrirLightbox(item.foto);
      return;
    }
    if (acao === 'selecionar-entrada' || acao === 'selecionar-saida') {
      selecionarAcaoQuantidade(card, acao === 'selecionar-entrada' ? 'entrada' : 'saida');
      return;
    }
    if (acao === 'confirmar-qtd') {
      const tipoPendente = card.dataset.acaoPendente;
      if (!tipoPendente) {
        mostrarErroInline(qs('.erro-inline', card), 'Toque em + ou − antes de confirmar.');
        return;
      }
      await aplicarMovimentacao(card, itemId, tipoPendente);
      return;
    }
    if (acao === 'remove-item') {
      const item = state.items.find((i) => i.id === itemId);
      abrirConfirm(
        'Remover item',
        `Remover "${item.nome}" do catálogo? O histórico de movimentações já registrado será mantido.`,
        async () => {
          const res = await window.api.items.remove(itemId);
          if (res.ok) {
            await carregarItens();
            renderCatalogo();
            atualizarSelectsConsultar();
            await renderPrecificacao();
            await renderPendencias();
            toast('Item removido do catálogo.');
          } else {
            toast(res.erro, 'erro');
          }
        }
      );
      return;
    }
    if (acao === 'edit-item') {
      const item = state.items.find((i) => i.id === itemId);
      abrirModalItem(item);
      return;
    }
    if (acao === 'ver-historico-item') {
      abrirConsultarParaItem(itemId);
      return;
    }
  });

  grid.addEventListener('change', (e) => {
    const card = e.target.closest('.card');
    if (!card) return;

    if (e.target.classList.contains('sel-usuario')) {
      const painel = qs('.extra-panel', card);
      const valor = e.target.value;
      const camposNovo = qs('.novo-usuario-campos', painel);
      const pagamentoRow = qs('.pagamento-row', painel);
      const fotoRow = qs('.foto-row', painel);

      camposNovo.classList.toggle('hidden', valor !== '__novo__');
      if (valor === '__novo__') qs('.novo-usuario-telefone', camposNovo).focus();

      const temUsuario = valor !== '';
      pagamentoRow.classList.toggle('hidden', !temUsuario);
      if (state.perfil !== 'admin') {
        fotoRow.classList.toggle('hidden', !temUsuario);
      }
      return;
    }

    if (e.target.classList.contains('foto-input')) {
      const painel = e.target.closest('.extra-panel');
      const preview = qs('.preview-pequena', painel);
      const file = e.target.files[0];
      if (!file) {
        definirPreviewMidia(preview, null);
        return;
      }
      processarArquivoMidia(file, { maxDim: 500, qualidade: 0.7 })
        .then((dataUrl) => definirPreviewMidia(preview, dataUrl))
        .catch((err) => {
          toast(err.message || 'Não foi possível processar o arquivo.', 'erro');
          e.target.value = '';
          definirPreviewMidia(preview, null);
        });
      return;
    }
  });

  grid.addEventListener('input', (e) => {
    if (e.target.classList.contains('novo-usuario-telefone')) {
      const card = e.target.closest('.card');
      const pagamentoRow = qs('.pagamento-row', card);
      const fotoRow = qs('.foto-row', card);
      const temTelefone = e.target.value.trim() !== '';
      pagamentoRow.classList.toggle('hidden', !temTelefone);
      if (state.perfil !== 'admin') {
        fotoRow.classList.toggle('hidden', !temTelefone);
      }
      return;
    }
    if (e.target.classList.contains('usuario-busca')) {
      const painel = e.target.closest('.extra-panel');
      filtrarOpcoesSelectUsuario(e.target, qs('.sel-usuario', painel));
    }
  });
}

/** Marca + ou − como selecionado (a movimentação só é aplicada ao clicar em "Confirmar").
 * O botão "+" só existe no DOM para o Admin (Default nunca pode adicionar) — por isso
 * cada toggle é feito com verificação de existência, para nunca quebrar o clique em "−"
 * (que é a ÚNICA ação disponível para o Default) caso o elemento não esteja presente. */
function selecionarAcaoQuantidade(card, tipo) {
  card.dataset.acaoPendente = tipo;
  const btnPlus = qs('.btn-plus', card);
  const btnMinus = qs('.btn-minus', card);
  if (btnPlus) btnPlus.classList.toggle('selecionado', tipo === 'entrada');
  if (btnMinus) btnMinus.classList.toggle('selecionado', tipo === 'saida');
  const btnConfirmar = qs('.btn-confirmar-qtd', card);
  btnConfirmar.disabled = false;
  btnConfirmar.textContent = tipo === 'entrada' ? 'Confirmar adição (+)' : 'Confirmar remoção (−)';
  qs('.erro-inline', card).classList.add('hidden');
}

async function aplicarMovimentacao(card, itemId, tipo) {
  const erroEl = qs('.erro-inline', card);
  erroEl.classList.add('hidden');

  const qtdInput = qs('.qtd-input', card);
  const quantidade = parseInt(qtdInput.value, 10);
  if (!Number.isFinite(quantidade) || quantidade <= 0) {
    mostrarErroInline(erroEl, 'Informe uma quantidade válida.');
    return;
  }

  const painel = qs('.extra-panel', card);
  const selUsuario = qs('.sel-usuario', painel).value;
  const novoUsuarioTelefone = qs('.novo-usuario-telefone', painel).value.trim();
  const novoUsuarioNome = qs('.novo-usuario-nome-inline', painel).value.trim();
  const entregaEl = qs(`input[name="entrega-${itemId}"]:checked`, painel);
  const tipoEntrega = entregaEl ? entregaEl.value : null;
  // O perfil Default nunca escolhe: todo registro dele nasce pendente, só o Admin confirma
  // depois (ver `ajustarQuantidade` em src/logic.js). O checkbox só existe pro Admin.
  const pendente = state.perfil === 'admin' ? qs('.chk-pendente', painel)?.checked || false : true;
  const previewFoto = qs('.preview-pequena', painel);
  const foto = previewFoto && !previewFoto.classList.contains('hidden') ? previewFoto.dataset.dataurl || null : null;

  if (selUsuario === '__novo__' && !novoUsuarioTelefone) {
    mostrarErroInline(erroEl, 'Informe o telefone do novo usuário (obrigatório).');
    return;
  }

  const temUsuario = (selUsuario && selUsuario !== '__novo__') || (selUsuario === '__novo__' && novoUsuarioTelefone);

  if (state.perfil !== 'admin' && !temUsuario) {
    mostrarErroInline(erroEl, 'Selecione (ou cadastre) um usuário — é obrigatório para remover quantidade.');
    return;
  }
  if (temUsuario && !tipoEntrega) {
    mostrarErroInline(erroEl, 'Selecione Entrega ou Retirada.');
    return;
  }

  const params = {
    itemId,
    tipo,
    quantidade,
    usuarioId: selUsuario && selUsuario !== '__novo__' ? selUsuario : null,
    usuarioTelefoneNovo: selUsuario === '__novo__' ? novoUsuarioTelefone : null,
    usuarioNomeNovo: selUsuario === '__novo__' ? novoUsuarioNome : null,
    tipoEntrega: temUsuario ? tipoEntrega : null,
    pendente: temUsuario ? pendente : false,
    foto: foto || null,
  };

  const res = await window.api.items.adjust(params);
  if (!res.ok) {
    mostrarErroInline(erroEl, res.erro);
    return;
  }

  await Promise.all([carregarItens(), carregarUsuarios()]);
  renderCatalogo();
  renderUsuarios();
  await inicializarHistorico();
  atualizarSelectsConsultar();
  await atualizarBannerDesfazer();
  await renderPrecificacao();
  await renderPendencias();
  toast(tipo === 'entrada' ? 'Quantidade adicionada.' : 'Quantidade removida.');
}

function mostrarErroInline(el, msg) {
  el.textContent = msg;
  el.classList.remove('hidden');
}

// ---------------------------------------------------------------------------
// Modal: adicionar/editar item (admin)
// ---------------------------------------------------------------------------

let itemEmEdicaoId = null;
let fotoModalDataUrl = null;

function abrirModalItem(itemExistente) {
  itemEmEdicaoId = itemExistente ? itemExistente.id : null;
  fotoModalDataUrl = itemExistente ? itemExistente.foto : null;

  qs('#modal-item-titulo').textContent = itemExistente ? 'Editar item' : 'Novo item';
  qs('#item-nome').value = itemExistente ? itemExistente.nome : '';
  qs('#item-quantidade').value = itemExistente ? itemExistente.quantidade : 0;
  qs('#item-quantidade').disabled = !!itemExistente; // quantidade só muda via movimentações
  qs('#item-foto-input').value = '';
  definirPreviewMidia(qs('#item-foto-preview'), fotoModalDataUrl);
  qs('#modal-item-erro').classList.add('hidden');
  qs('#modal-item').classList.remove('hidden');
  qs('#item-nome').focus();
}

function fecharModalItem() {
  qs('#modal-item').classList.add('hidden');
}

function configurarModalItem() {
  qs('#btn-add-item').addEventListener('click', () => abrirModalItem(null));
  qs('#item-cancelar').addEventListener('click', fecharModalItem);

  qs('#item-foto-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      fotoModalDataUrl = await processarArquivoMidia(file, { maxDim: 700, qualidade: 0.75 });
    } catch (err) {
      toast(err.message || 'Não foi possível processar o arquivo.', 'erro');
      e.target.value = '';
      return;
    }
    definirPreviewMidia(qs('#item-foto-preview'), fotoModalDataUrl);
  });

  qs('#item-salvar').addEventListener('click', async () => {
    const nome = qs('#item-nome').value.trim();
    const erroEl = qs('#modal-item-erro');
    if (!nome) {
      erroEl.textContent = 'Informe o nome do item.';
      erroEl.classList.remove('hidden');
      return;
    }

    let res;
    if (itemEmEdicaoId) {
      res = await window.api.items.edit(itemEmEdicaoId, { nome, foto: fotoModalDataUrl });
    } else {
      const quantidade = parseInt(qs('#item-quantidade').value, 10) || 0;
      res = await window.api.items.add({ nome, quantidade, foto: fotoModalDataUrl });
    }

    if (!res.ok) {
      erroEl.textContent = res.erro;
      erroEl.classList.remove('hidden');
      return;
    }
    fecharModalItem();
    await carregarItens();
    renderCatalogo();
    atualizarSelectsConsultar();
    await renderPrecificacao();
    toast(itemEmEdicaoId ? 'Item atualizado.' : 'Item adicionado ao catálogo.');
  });
}

// ---------------------------------------------------------------------------
// Modal: movimentar item de um usuário (atalho a partir da aba Usuários)
// ---------------------------------------------------------------------------
//
// Faz a mesma coisa que o botão − do card do catálogo, só que começando
// pelo usuário em vez de pelo item: você já escolheu a pessoa na aba
// Usuários, então só falta escolher o item e a quantidade. Usa o mesmo
// `items.adjust` do backend, então as mesmas regras de perfil valem aqui
// (Default: só remove, sempre com usuário — já dado —, nunca adiciona).

let movimentarUsuarioAtual = null;
let movimentarFotoDataUrl = null;

/** Monta a tabela de itens marcáveis do modal (uma vez por abertura — a busca só filtra/oculta linhas,
 * pra não perder as marcações/quantidades já preenchidas pela pessoa). */
function renderMovimentarItensTable() {
  const tbody = qs('#movimentar-itens-table tbody');
  tbody.innerHTML = state.items
    .map((i) => {
      const temPreco = Number(i.precoUnitario) > 0;
      return `
      <tr data-mov-item-nome="${escapeHtml(i.nome.toLowerCase())}" data-mov-tem-preco="${temPreco ? '1' : '0'}">
        <td><input type="checkbox" class="movimentar-item-check" data-mov-check="${i.id}" /></td>
        <td>${escapeHtml(i.nome)} <span class="badge-sem-preco hidden">sem preço definido</span></td>
        <td>${i.quantidade}</td>
        <td><input type="number" class="movimentar-item-qtd" data-mov-qtd="${i.id}" min="1" step="1" value="1" disabled /></td>
      </tr>`;
    })
    .join('');

  qsa('.movimentar-item-check', tbody).forEach((cb) => {
    cb.addEventListener('change', () => {
      const qtdInput = qs(`[data-mov-qtd="${cb.dataset.movCheck}"]`, tbody);
      qtdInput.disabled = !cb.checked;
      cb.closest('tr').classList.toggle('movimentar-item-marcado', cb.checked);
      atualizarBotaoConfirmarMovimentar();
    });
  });

  atualizarAvisosPrecoMovimentar();
}

/** Mostra, em tempo real (assim que + ou − é escolhido), quais itens marcados na tabela
 * ainda não têm preço definido — para o Admin não ser pego de surpresa só ao clicar em
 * "Confirmar" (a exigência de preço vale só para saída em lote, feita por este modal). */
function atualizarAvisosPrecoMovimentar() {
  const tipo = qs('#modal-movimentar').dataset.acaoPendente;
  const isAdmin = state.perfil === 'admin';
  const exige = isAdmin && tipo === 'saida';
  const avisoGeral = qs('#movimentar-aviso-preco');
  let algumSemPreco = false;

  qsa('#movimentar-itens-table tbody tr').forEach((tr) => {
    const semPreco = tr.dataset.movTemPreco === '0';
    const mostrarAviso = exige && semPreco;
    tr.querySelector('.badge-sem-preco').classList.toggle('hidden', !mostrarAviso);
    tr.classList.toggle('movimentar-item-sem-preco', mostrarAviso);
    if (mostrarAviso) algumSemPreco = true;
  });

  if (avisoGeral) avisoGeral.classList.toggle('hidden', !algumSemPreco);
}

function atualizarBotaoConfirmarMovimentar() {
  const tipo = qs('#modal-movimentar').dataset.acaoPendente;
  const algumMarcado = qsa('.movimentar-item-check:checked').length > 0;
  const btn = qs('#movimentar-confirmar');
  btn.disabled = !tipo || !algumMarcado;
  btn.textContent = !tipo
    ? 'Selecione + ou −'
    : tipo === 'entrada'
    ? 'Confirmar adição (+)'
    : 'Confirmar remoção (−)';
}

function abrirModalMovimentar(usuario) {
  movimentarUsuarioAtual = usuario;
  movimentarFotoDataUrl = null;

  qs('#movimentar-usuario-nome').textContent = rotuloUsuario(usuario);
  qs('#movimentar-item-busca').value = '';
  renderMovimentarItensTable();
  qs('#movimentar-foto-input').value = '';
  definirPreviewMidia(qs('#movimentar-foto-preview'), null);
  qsa('input[name="movimentar-entrega"]').forEach((r) => (r.checked = false));
  qs('#movimentar-pendente').checked = false;

  const modal = qs('#modal-movimentar');
  modal.dataset.acaoPendente = '';
  atualizarAvisosPrecoMovimentar();
  qs('#movimentar-btn-entrada').classList.remove('selecionado');
  qs('#movimentar-btn-saida').classList.remove('selecionado');
  // Default nunca pode adicionar quantidade — o botão de + some, sobrando só o de remover.
  qs('#movimentar-btn-entrada').classList.toggle('hidden', state.perfil !== 'admin');
  atualizarBotaoConfirmarMovimentar();
  qs('#movimentar-dica-default').classList.toggle('hidden', state.perfil === 'admin');
  qs('#modal-movimentar-erro').classList.add('hidden');

  modal.classList.remove('hidden');
}

function fecharModalMovimentar() {
  qs('#modal-movimentar').classList.add('hidden');
  movimentarUsuarioAtual = null;
}

function configurarModalMovimentar() {
  qs('#movimentar-cancelar').addEventListener('click', fecharModalMovimentar);

  qs('#movimentar-item-busca').addEventListener('input', (e) => {
    const termo = e.target.value.trim().toLowerCase();
    qsa('#movimentar-itens-table tbody tr').forEach((tr) => {
      tr.classList.toggle('hidden', termo !== '' && !tr.dataset.movItemNome.includes(termo));
    });
  });

  function selecionarTipoMovimentar(tipo) {
    qs('#modal-movimentar').dataset.acaoPendente = tipo;
    qs('#movimentar-btn-entrada').classList.toggle('selecionado', tipo === 'entrada');
    qs('#movimentar-btn-saida').classList.toggle('selecionado', tipo === 'saida');
    atualizarBotaoConfirmarMovimentar();
    atualizarAvisosPrecoMovimentar();
    qs('#modal-movimentar-erro').classList.add('hidden');
  }
  qs('#movimentar-btn-entrada').addEventListener('click', () => selecionarTipoMovimentar('entrada'));
  qs('#movimentar-btn-saida').addEventListener('click', () => selecionarTipoMovimentar('saida'));

  qs('#movimentar-foto-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) {
      definirPreviewMidia(qs('#movimentar-foto-preview'), null);
      return;
    }
    try {
      movimentarFotoDataUrl = await processarArquivoMidia(file, { maxDim: 500, qualidade: 0.7 });
    } catch (err) {
      toast(err.message || 'Não foi possível processar o arquivo.', 'erro');
      e.target.value = '';
      return;
    }
    definirPreviewMidia(qs('#movimentar-foto-preview'), movimentarFotoDataUrl);
  });

  qs('#movimentar-confirmar').addEventListener('click', async () => {
    const erroEl = qs('#modal-movimentar-erro');
    erroEl.classList.add('hidden');
    if (!movimentarUsuarioAtual) return;

    const tipo = qs('#modal-movimentar').dataset.acaoPendente;
    if (!tipo) {
      erroEl.textContent = 'Toque em + ou − antes de confirmar.';
      erroEl.classList.remove('hidden');
      return;
    }

    const linhasMarcadas = qsa('.movimentar-item-check:checked');
    if (!linhasMarcadas.length) {
      erroEl.textContent = 'Marque ao menos um item.';
      erroEl.classList.remove('hidden');
      return;
    }

    const entregaEl = qs('input[name="movimentar-entrega"]:checked');
    if (!entregaEl) {
      erroEl.textContent = 'Selecione Entrega ou Retirada.';
      erroEl.classList.remove('hidden');
      return;
    }

    // Validação client-side de cada linha marcada: quantidade válida e, no fluxo do Admin
    // fazendo uma saída, preço unitário definido (regra vale só aqui — ver aba Precificação).
    // Itens marcados sem preço são PULADOS (não bloqueiam mais o lote inteiro) — eles já
    // aparecem destacados em vermelho na tabela (ver `atualizarAvisosPrecoMovimentar`), então
    // aqui só confirmamos e deixamos os demais itens do lote seguirem normalmente.
    const isAdmin = state.perfil === 'admin';
    const itensParaEnviar = [];
    const semPreco = [];
    for (const cb of linhasMarcadas) {
      const itemId = cb.dataset.movCheck;
      const item = state.items.find((i) => i.id === itemId);
      const qtdInput = qs(`[data-mov-qtd="${itemId}"]`);
      const quantidade = parseInt(qtdInput.value, 10);
      if (!Number.isFinite(quantidade) || quantidade <= 0) {
        erroEl.textContent = `Informe uma quantidade válida para "${item ? item.nome : itemId}".`;
        erroEl.classList.remove('hidden');
        return;
      }
      const precisaPreco = isAdmin && tipo === 'saida' && !(Number(item && item.precoUnitario) > 0);
      if (precisaPreco) {
        semPreco.push(item ? item.nome : itemId);
      } else {
        itensParaEnviar.push({ itemId, quantidade, nome: item ? item.nome : itemId });
      }
    }

    if (!itensParaEnviar.length) {
      erroEl.textContent = semPreco.length
        ? `Nenhum item marcado pode ser enviado: defina um valor unitário na aba Precificação para — ${semPreco.join(', ')}.`
        : 'Marque ao menos um item.';
      erroEl.classList.remove('hidden');
      return;
    }

    const paramsComuns = {
      usuarioId: movimentarUsuarioAtual.id,
      tipoEntrega: entregaEl.value,
      // O perfil Default nunca escolhe: todo registro dele nasce pendente (ver `ajustarQuantidade`).
      pendente: isAdmin ? qs('#movimentar-pendente').checked : true,
      foto: movimentarFotoDataUrl || null,
      exigirPreco: isAdmin,
    };

    // Cada item marcado vira uma chamada independente ao backend (sem rollback conjunto —
    // se uma falhar no meio do lote, as anteriores já ficam registradas normalmente).
    let sucesso = 0;
    const falhas = [];
    for (const { itemId, quantidade, nome } of itensParaEnviar) {
      const res = await window.api.items.adjust({ itemId, tipo, quantidade, ...paramsComuns });
      if (res.ok) {
        sucesso += 1;
      } else {
        falhas.push(`${nome}: ${res.erro}`);
      }
    }

    await Promise.all([carregarItens(), carregarUsuarios()]);
    renderCatalogo();
    renderUsuarios();
    await inicializarHistorico();
    atualizarSelectsConsultar();
    await atualizarBannerDesfazer();
    await renderPrecificacao();
    await renderPendencias();

    if (falhas.length || semPreco.length) {
      const partes = [`${sucesso} de ${linhasMarcadas.length} item(ns) marcados confirmados.`];
      if (semPreco.length) partes.push(`Pulado por falta de preço — ${semPreco.join(', ')}.`);
      if (falhas.length) partes.push(`Falha em — ${falhas.join(' | ')}`);
      erroEl.textContent = partes.join(' ');
      erroEl.classList.remove('hidden');
      return;
    }

    fecharModalMovimentar();
    toast(tipo === 'entrada' ? 'Quantidade adicionada.' : 'Quantidade removida.');
  });
}

// ---------------------------------------------------------------------------
// Modal: lançamentos avulsos (valor + observação, sem item atrelado)
// ---------------------------------------------------------------------------
//
// Pendência solta atribuída a um usuário — ex.: uma cobrança combinada por
// telefone que não corresponde à saída de nenhum item do catálogo. Os dois
// perfis podem criar e editar (Default fica restrito a valores negativos
// para um usuário bloqueado pelo Admin — ver `abrirModalLancamentos`);
// excluir e alternar o status seguem exclusivos do Admin.

let lancamentosUsuarioAtual = null;

function renderLancamentosTable(lista) {
  const tabela = qs('#lancamentos-table');
  const vazio = qs('#lancamentos-vazio');
  if (!lista.length) {
    tabela.classList.add('hidden');
    vazio.classList.remove('hidden');
    return;
  }
  vazio.classList.add('hidden');
  tabela.classList.remove('hidden');
  const isAdmin = state.perfil === 'admin';

  qs('tbody', tabela).innerHTML = lista
    .map((l) => {
      const valorCol = `<input type="number" class="input-preco" step="0.01" value="${l.valor}" />`;
      const obsCol = `<input type="text" class="input-observacao" maxlength="500" value="${escapeHtml(l.observacao || '')}" />`;
      return `
      <tr data-lancamento-id="${l.id}">
        <td>${formatarDataHoraCompleta(l.dataHoraISO)}</td>
        <td>${valorCol}</td>
        <td>${obsCol}</td>
        <td class="col-status">
          ${statusBadgeHtml(l)}
          ${
            isAdmin
              ? `<button class="btn-toggle-pendente" data-toggle-lancamento="${l.id}" data-pendente-atual="${l.pendente ? '1' : '0'}" title="${
                  l.pendente ? 'Marcar como concluído' : 'Marcar como pendente'
                }">${l.pendente ? '✓ Concluir' : '⏳ Pendente'}</button>
              <button class="btn btn-perigo btn-pequeno" data-excluir-lancamento-modal="${l.id}">Excluir</button>`
              : botaoRecebidoDefaultHtml(l, 'marcar-recebido-lancamento')
          }
        </td>
      </tr>`;
    })
    .join('');

  if (isAdmin) {
    qsa('[data-toggle-lancamento]', tabela).forEach((btn) => {
      btn.addEventListener('click', async () => {
        const lancamentoId = btn.dataset.toggleLancamento;
        const pendenteAtual = btn.dataset.pendenteAtual === '1';
        const res = await window.api.lancamentos.definirPendente(lancamentoId, !pendenteAtual);
        if (!res.ok) {
          toast(res.erro, 'erro');
          return;
        }
        await recarregarModalLancamentos();
        await renderPendencias();
      });
    });
    qsa('[data-excluir-lancamento-modal]', tabela).forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.excluirLancamentoModal;
        abrirConfirm(
          'Excluir lançamento',
          'Excluir esse lançamento avulso definitivamente? Essa ação não pode ser desfeita.',
          async () => {
            const res = await window.api.lancamentos.remover(id);
            if (!res.ok) {
              toast(res.erro, 'erro');
              return;
            }
            await recarregarModalLancamentos();
            await renderPendencias();
            await renderHistoricoDoDia();
            toast('Lançamento excluído.');
          }
        );
      });
    });
  } else {
    qsa('[data-marcar-recebido-lancamento]', tabela).forEach((btn) => {
      btn.addEventListener('click', async () => {
        const lancamentoId = btn.dataset.marcarRecebidoLancamento;
        const marcadoAtual = btn.dataset.marcadoAtual === '1';
        const res = await window.api.lancamentos.marcarRecebidoDefault(lancamentoId, !marcadoAtual);
        if (!res.ok) {
          toast(res.erro, 'erro');
          return;
        }
        await recarregarModalLancamentos();
        toast(marcadoAtual ? 'Desmarcado.' : 'Marcado como recebido — o Admin ainda precisa confirmar.');
      });
    });
  }
}

async function recarregarModalLancamentos() {
  if (!lancamentosUsuarioAtual) return;
  const lista = await window.api.lancamentos.listarPorUsuario(lancamentosUsuarioAtual.id);
  renderLancamentosTable(lista);
}

function abrirModalLancamentos(usuario) {
  lancamentosUsuarioAtual = usuario;
  qs('#lancamentos-usuario-nome').textContent = rotuloUsuario(usuario);
  qs('#lancamento-valor').value = '';
  qs('#lancamento-observacao').value = '';
  qs('#lancamento-erro').classList.add('hidden');

  // Default pode criar um lançamento avulso pra qualquer usuário, mas para um usuário que o
  // Admin bloqueou (ver `usuarios:definirBloqueio`) só pode lançar valores negativos (créditos/
  // descontos) — por isso o formulário continua visível, só o aviso muda o que é permitido.
  // O Admin continua livre sobre qualquer usuário, com qualquer sinal.
  const bloqueado = state.perfil !== 'admin' && !!usuario.bloqueadoParaDefault;
  qs('#lancamento-bloqueado-aviso').classList.toggle('hidden', !bloqueado);

  qs('#modal-lancamentos').classList.remove('hidden');
  recarregarModalLancamentos();
}

function fecharModalLancamentos() {
  qs('#modal-lancamentos').classList.add('hidden');
  lancamentosUsuarioAtual = null;
}

function configurarModalLancamentos() {
  qs('#lancamentos-fechar').addEventListener('click', fecharModalLancamentos);

  qs('#lancamentos-table').addEventListener('change', async (e) => {
    const tr = e.target.closest('tr[data-lancamento-id]');
    if (!tr) return;
    const lancamentoId = tr.dataset.lancamentoId;
    const valorInput = qs('.input-preco', tr);
    const obsInput = qs('.input-observacao', tr);
    if (!valorInput || !obsInput) return;

    const valor = parseFloat(valorInput.value);
    if (!Number.isFinite(valor) || valor === 0) {
      toast('Informe um valor diferente de zero (negativo funciona como crédito/desconto).', 'erro');
      await recarregarModalLancamentos(); // desfaz a edição inválida na tela
      return;
    }
    const res = await window.api.lancamentos.editar(lancamentoId, valor, obsInput.value.trim());
    if (!res.ok) {
      toast(res.erro, 'erro');
      await recarregarModalLancamentos();
      return;
    }
    await recarregarModalLancamentos();
    await renderPendencias();
    await renderHistoricoDoDia();
    toast('Lançamento atualizado.');
  });

  qs('#lancamento-adicionar-btn').addEventListener('click', async () => {
    const erroEl = qs('#lancamento-erro');
    erroEl.classList.add('hidden');
    if (!lancamentosUsuarioAtual) return;

    const valor = parseFloat(qs('#lancamento-valor').value);
    if (!Number.isFinite(valor) || valor === 0) {
      mostrarErroInline(erroEl, 'Informe um valor diferente de zero (negativo funciona como crédito/desconto).');
      return;
    }
    const bloqueado = state.perfil !== 'admin' && !!lancamentosUsuarioAtual.bloqueadoParaDefault;
    if (bloqueado && valor > 0) {
      mostrarErroInline(
        erroEl,
        'O Admin bloqueou esse usuário: você só pode lançar valores negativos (créditos) para ele.'
      );
      return;
    }
    const observacao = qs('#lancamento-observacao').value.trim();

    const res = await window.api.lancamentos.adicionar(lancamentosUsuarioAtual.id, valor, observacao);
    if (!res.ok) {
      mostrarErroInline(erroEl, res.erro);
      return;
    }

    qs('#lancamento-valor').value = '';
    qs('#lancamento-observacao').value = '';
    await recarregarModalLancamentos();
    await renderPendencias();
    toast('Lançamento adicionado.');
  });
}

// ---------------------------------------------------------------------------
// Banner "desfazer última movimentação" (só perfil Default, só nesta sessão)
// ---------------------------------------------------------------------------
//
// Como o Default não pode mais adicionar quantidade (só remover), a única
// forma dele corrigir um erro é desfazer a última movimentação feita por
// ele nesta sessão do app — o backend (main.js) guarda essa informação só
// na memória do processo, então some sozinha se o app for reiniciado.

async function atualizarBannerDesfazer() {
  const banner = qs('#desfazer-banner');
  if (!banner) return;
  if (state.perfil === 'admin') {
    banner.classList.add('hidden');
    return;
  }
  const info = await window.api.historico.desfazerInfo();
  if (!info.disponivel) {
    banner.classList.add('hidden');
    return;
  }
  const t = info.transacao;
  qs('#desfazer-texto').textContent =
    `Última movimentação desta sessão: −${t.quantidade} de "${t.itemNome}"` +
    (t.usuarioNome ? ` (${t.usuarioNome})` : '') +
    '. Errou a quantidade?';
  banner.classList.remove('hidden');
}

function configurarBannerDesfazer() {
  qs('#btn-desfazer').addEventListener('click', () => {
    abrirConfirm(
      'Desfazer última movimentação',
      'Isso apaga o registro da sua última movimentação nesta sessão e devolve a quantidade retirada para o ' +
        'catálogo. Não pode ser desfeito depois disso. Deseja continuar?',
      async () => {
        const res = await window.api.historico.desfazerUltima();
        if (!res.ok) {
          toast(res.erro, 'erro');
          await atualizarBannerDesfazer();
          return;
        }
        await Promise.all([carregarItens(), carregarUsuarios()]);
        renderCatalogo();
        renderUsuarios();
        await inicializarHistorico();
        atualizarSelectsConsultar();
        await atualizarBannerDesfazer();
        await renderPrecificacao();
        await renderPendencias();
        toast('Movimentação desfeita — a quantidade voltou para o catálogo.');
      }
    );
  });
}

// ---------------------------------------------------------------------------
// Usuários
// ---------------------------------------------------------------------------

/** Texto usado para buscar/filtrar um usuário: nome + telefone (só dígitos), em minúsculas. */
function buscaTextoUsuario(usuario) {
  return `${(usuario.nome || '').toLowerCase()} ${apenasDigitos(usuario.telefone)}`;
}

function usuariosFiltrados() {
  if (!state.buscaUsuario) return state.usuarios;
  return state.usuarios.filter((u) => buscaTextoUsuario(u).includes(state.buscaUsuario));
}

/**
 * Liga uma caixa de busca a um <select> de usuários: digitar filtra as opções
 * visíveis (por nome ou telefone) sem perder o comportamento de select — dá
 * pra digitar para achar rápido ou simplesmente abrir e escolher da lista.
 * Opções sem `data-busca` (ex.: "— nenhum usuário —", "+ Novo usuário…") não
 * são afetadas pelo filtro, ficam sempre visíveis.
 */
function configurarBuscaEmSelectUsuario(inputEl, selectEl) {
  if (!inputEl || !selectEl) return;
  inputEl.addEventListener('input', () => filtrarOpcoesSelectUsuario(inputEl, selectEl));
}

/** Filtra (esconde/mostra) as <option> de usuário de um select conforme o texto digitado. */
function filtrarOpcoesSelectUsuario(inputEl, selectEl) {
  if (!inputEl || !selectEl) return;
  const termo = inputEl.value.trim().toLowerCase();
  qsa('option', selectEl).forEach((opt) => {
    if (opt.dataset.busca === undefined) return;
    opt.hidden = termo !== '' && !opt.dataset.busca.includes(termo);
  });
}

/**
 * Autocomplete do filtro "Usuário" na aba Histórico: em vez de um <select> (que só mostra as
 * opções filtradas quando é aberto), uma lista de sugestões aparece por baixo da caixa de texto
 * e vai atualizando a cada tecla digitada — o usuário já vê o resultado aparecendo, sem precisar
 * abrir nada nem "confirmar" a busca. Clicar numa sugestão aplica o filtro na hora.
 */
function configurarAutocompleteHistoricoUsuario() {
  const input = qs('#historico-usuario-busca');
  const lista = qs('#historico-usuario-sugestoes');
  const btnLimpar = qs('#btn-historico-usuario-limpar');
  if (!input || !lista || !btnLimpar) return;

  function renderSugestoes() {
    const termo = input.value.trim().toLowerCase();
    const candidatos = termo ? state.usuarios.filter((u) => buscaTextoUsuario(u).includes(termo)) : state.usuarios;
    const itensHtml = candidatos
      .slice(0, 30)
      .map(
        (u) =>
          `<div class="autocomplete-item" data-usuario-id="${u.id}">${escapeHtml(rotuloUsuarioComEstrela(u))} — ${escapeHtml(u.telefone || '—')}</div>`
      )
      .join('');
    lista.innerHTML =
      `<div class="autocomplete-item autocomplete-item-todos" data-usuario-id="">Todos os usuários</div>` +
      (itensHtml || `<div class="autocomplete-vazio">Nenhum usuário encontrado.</div>`);
    lista.classList.remove('hidden');
  }

  function escolher(usuarioId) {
    state.filtroHistoricoUsuario = usuarioId;
    const usuario = usuarioId ? state.usuarios.find((u) => u.id === usuarioId) : null;
    input.value = usuario ? `${rotuloUsuario(usuario)} — ${usuario.telefone || ''}` : '';
    lista.classList.add('hidden');
    atualizarBotaoLimparHistoricoUsuario();
    renderHistoricoDoDia();
  }

  input.addEventListener('input', renderSugestoes);
  input.addEventListener('focus', renderSugestoes);
  input.addEventListener('blur', () => {
    // pequeno atraso pra deixar o clique (mousedown) numa sugestão registrar antes de esconder a lista
    setTimeout(() => lista.classList.add('hidden'), 150);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      lista.classList.add('hidden');
      input.blur();
    }
  });
  lista.addEventListener('mousedown', (e) => {
    const item = e.target.closest('[data-usuario-id]');
    if (!item) return;
    e.preventDefault(); // evita o blur do input antes do clique ser processado
    escolher(item.dataset.usuarioId);
  });
  btnLimpar.addEventListener('click', () => escolher(''));
}

function atualizarBotaoLimparHistoricoUsuario() {
  const btn = qs('#btn-historico-usuario-limpar');
  if (btn) btn.classList.toggle('hidden', !state.filtroHistoricoUsuario);
}

/** Iniciais para o avatar do card de usuário: 1ª letra do nome, ou "#" quando só há telefone. */
function iniciaisUsuario(usuario) {
  const nome = (usuario.nome || '').trim();
  if (nome) return nome.charAt(0).toUpperCase();
  return '#';
}

function renderUsuarios() {
  const grid = qs('#usuarios-grid');
  const lista = usuariosFiltrados();
  const isAdmin = state.perfil === 'admin';
  qs('#usuarios-vazio').classList.toggle('hidden', lista.length !== 0);
  qs('#usuarios-vazio').textContent =
    state.usuarios.length === 0
      ? 'Nenhum usuário cadastrado ainda.'
      : 'Nenhum usuário encontrado para essa busca.';
  grid.innerHTML = lista
    .map(
      (u) => `
      <div class="card usuario-card${u.bloqueadoParaDefault ? ' usuario-card-bloqueado' : ''}" data-usuario-id="${u.id}">
        <button class="btn-favorito${u.favorito ? ' favorito-ativo' : ''}" data-usuario-favoritar="${u.id}"
          title="${u.favorito ? 'Remover dos favoritos' : 'Marcar como favorito'}">${u.favorito ? '★' : '☆'}</button>
        <div class="usuario-card-header">
          <div class="usuario-avatar">${escapeHtml(iniciaisUsuario(u))}</div>
          <div class="usuario-card-titulo">
            <h3>${escapeHtml(nomeOuIdentificador(u))}</h3>
            <span class="usuario-telefone">${escapeHtml(u.telefone || '—')}</span>
          </div>
        </div>
        ${
          u.bloqueadoParaDefault
            ? `<span class="tag-bloqueado" title="Bloqueado para o perfil Default">🔒 Bloqueado pro Default</span>`
            : ''
        }
        <span class="usuario-cadastrado-em">Cadastrado em ${formatarDataHoraCompleta(u.criadoEm)}</span>
        <div class="usuario-card-acoes">
          <button class="btn btn-outline btn-pequeno" data-usuario-movimentar="${u.id}">Movimentar item</button>
          <button class="btn btn-outline btn-pequeno" data-usuario-lancamentos="${u.id}">Lançamentos</button>
          <button class="btn btn-outline btn-pequeno" data-usuario-pendencia="${u.id}">Pendências</button>
          <button class="btn btn-outline btn-pequeno" data-usuario-consultar="${u.id}">Consultar</button>
          <button class="btn btn-texto btn-pequeno" data-usuario-editar="${u.id}">Editar</button>
          ${
            isAdmin
              ? `<button class="btn btn-texto btn-pequeno" data-usuario-bloquear="${u.id}"
                  data-bloqueado-atual="${u.bloqueadoParaDefault ? '1' : '0'}">${
                    u.bloqueadoParaDefault ? '🔓 Desbloquear' : '🔒 Bloquear'
                  }</button>`
              : ''
          }
          <button class="btn btn-perigo btn-pequeno" data-usuario-remover="${u.id}">Remover</button>
        </div>
      </div>`
    )
    .join('');

  qsa('[data-usuario-favoritar]', grid).forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.usuarioFavoritar;
      const usuario = state.usuarios.find((u) => u.id === id);
      if (!usuario) return;
      const res = await window.api.usuarios.favoritar(id, !usuario.favorito);
      if (!res.ok) {
        toast(res.erro, 'erro');
        return;
      }
      await carregarUsuarios();
      renderUsuarios();
      renderCatalogo();
      atualizarSelectsConsultar();
    });
  });

  qsa('[data-usuario-movimentar]', grid).forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.usuarioMovimentar;
      const usuario = state.usuarios.find((u) => u.id === id);
      if (usuario) abrirModalMovimentar(usuario);
    });
  });

  qsa('[data-usuario-lancamentos]', grid).forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.usuarioLancamentos;
      const usuario = state.usuarios.find((u) => u.id === id);
      if (usuario) abrirModalLancamentos(usuario);
    });
  });

  qsa('[data-usuario-pendencia]', grid).forEach((btn) => {
    btn.addEventListener('click', () => abrirPendenciaDoUsuarioNaAba(btn.dataset.usuarioPendencia));
  });

  qsa('[data-usuario-remover]', grid).forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.usuarioRemover;
      const usuario = state.usuarios.find((u) => u.id === id);
      abrirConfirm(
        'Remover usuário',
        `Remover "${nomeOuIdentificador(usuario)}" da lista de usuários? O histórico já registrado é mantido.`,
        async () => {
          const res = await window.api.usuarios.remove(id);
          if (res.ok) {
            await carregarUsuarios();
            renderUsuarios();
            renderCatalogo();
            atualizarSelectsConsultar();
            toast('Usuário removido.');
          } else {
            toast(res.erro, 'erro');
          }
        }
      );
    });
  });

  qsa('[data-usuario-consultar]', grid).forEach((btn) => {
    btn.addEventListener('click', () => abrirConsultarParaUsuario(btn.dataset.usuarioConsultar));
  });

  qsa('[data-usuario-editar]', grid).forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.usuarioEditar;
      const usuario = state.usuarios.find((u) => u.id === id);
      if (usuario) abrirModalEditarUsuario(usuario);
    });
  });

  qsa('[data-usuario-bloquear]', grid).forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.usuarioBloquear;
      const bloqueadoAtual = btn.dataset.bloqueadoAtual === '1';
      const usuario = state.usuarios.find((u) => u.id === id);
      const acaoTitulo = bloqueadoAtual ? 'Desbloquear usuário' : 'Bloquear usuário';
      const acaoMensagem = bloqueadoAtual
        ? `Desbloquear "${nomeOuIdentificador(usuario)}"? O perfil Default volta a poder lançar valores/pagamentos para ele.`
        : `Bloquear "${nomeOuIdentificador(usuario)}"? O perfil Default deixa de poder adicionar lançamentos avulsos ` +
          'ou registrar pagamentos para ele — só o Admin continua podendo.';
      abrirConfirm(acaoTitulo, acaoMensagem, async () => {
        const res = await window.api.usuarios.definirBloqueio(id, !bloqueadoAtual);
        if (!res.ok) {
          toast(res.erro, 'erro');
          return;
        }
        await carregarUsuarios();
        renderUsuarios();
        toast(bloqueadoAtual ? 'Usuário desbloqueado.' : 'Usuário bloqueado para o perfil Default.');
      });
    });
  });
}

function nomeOuIdentificador(usuario) {
  if (usuario.nome && String(usuario.nome).trim()) return String(usuario.nome).trim();
  return `Nº final ${final4Telefone(usuario.telefone)}`;
}

async function onAdicionarUsuarioClick() {
  const inputTelefone = qs('#novo-usuario-telefone');
  const inputNome = qs('#novo-usuario-nome');
  const telefone = inputTelefone.value.trim();
  const nome = inputNome.value.trim();
  if (!telefone) {
    toast('Informe o telefone do usuário (obrigatório).', 'erro');
    return;
  }
  const res = await window.api.usuarios.add(nome, telefone);
  if (!res.ok) {
    toast(res.erro, 'erro');
    return;
  }
  inputTelefone.value = '';
  inputNome.value = '';
  await carregarUsuarios();
  renderUsuarios();
  renderCatalogo();
  atualizarSelectsConsultar();
  toast('Usuário adicionado.');
}

// ---------------------------------------------------------------------------
// Modal: editar usuário (nome/telefone — disponível para os dois perfis;
// favoritar, bloquear e excluir continuam em botões/regras separados)
// ---------------------------------------------------------------------------

let usuarioEmEdicaoId = null;

function abrirModalEditarUsuario(usuario) {
  usuarioEmEdicaoId = usuario.id;
  qs('#editar-usuario-nome').value = usuario.nome || '';
  qs('#editar-usuario-telefone').value = usuario.telefone || '';
  qs('#modal-editar-usuario-erro').classList.add('hidden');
  qs('#modal-editar-usuario').classList.remove('hidden');
  qs('#editar-usuario-nome').focus();
}

function fecharModalEditarUsuario() {
  qs('#modal-editar-usuario').classList.add('hidden');
  usuarioEmEdicaoId = null;
}

function configurarModalEditarUsuario() {
  qs('#editar-usuario-cancelar').addEventListener('click', fecharModalEditarUsuario);

  qs('#editar-usuario-salvar').addEventListener('click', async () => {
    if (!usuarioEmEdicaoId) return;
    const erroEl = qs('#modal-editar-usuario-erro');
    erroEl.classList.add('hidden');

    const nome = qs('#editar-usuario-nome').value.trim();
    const telefone = qs('#editar-usuario-telefone').value.trim();
    if (!telefone) {
      mostrarErroInline(erroEl, 'Informe o telefone do usuário (obrigatório).');
      return;
    }

    const res = await window.api.usuarios.editar(usuarioEmEdicaoId, { nome, telefone });
    if (!res.ok) {
      mostrarErroInline(erroEl, res.erro);
      return;
    }
    fecharModalEditarUsuario();
    await carregarUsuarios();
    renderUsuarios();
    renderCatalogo();
    atualizarSelectsConsultar();
    toast('Usuário atualizado.');
  });
}

// ---------------------------------------------------------------------------
// Histórico diário
// ---------------------------------------------------------------------------

async function inicializarHistorico() {
  qs('#historico-data-inicio').value = state.historicoDataInicio || '';
  qs('#historico-data-fim').value = state.historicoDataFim || '';
  await renderHistoricoDoDia();
}

async function renderHistoricoDoDia() {
  const dataInicio = state.historicoDataInicio;
  const dataFim = state.historicoDataFim;
  const todasTransacoes = await window.api.historico.listarPeriodo(dataInicio, dataFim);
  let transacoes = todasTransacoes;
  if (state.filtroHistoricoImportado) transacoes = transacoes.filter((t) => t.importado);
  if (state.filtroHistoricoPendente) transacoes = transacoes.filter((t) => t.pendente);
  if (state.filtroHistoricoUsuario) transacoes = transacoes.filter((t) => t.usuarioId === state.filtroHistoricoUsuario);
  const tbody = qs('#historico-table tbody');
  qs('#historico-vazio').classList.toggle('hidden', transacoes.length !== 0);
  qs('#historico-vazio').textContent =
    todasTransacoes.length === 0
      ? 'Nenhuma movimentação registrada nesse período.'
      : 'Nenhuma movimentação encontrada com os filtros escolhidos.';
  const isAdmin = state.perfil === 'admin';

  tbody.innerHTML = transacoes
    .map((t) => {
      const sinal = t.tipo === 'entrada' ? '+' : '−';
      const classe = t.tipo === 'entrada' ? 'tag-entrada' : 'tag-saida';
      const fotoHtml = thumbMidiaHtml(t.foto, t.id);
      const checkboxHtml = isAdmin
        ? `<td class="col-historico-check"><input type="checkbox" class="historico-check" value="${t.id}" /></td>`
        : '';
      const statusHtml =
        t.usuarioId || t.usuarioNome
          ? `${statusBadgeHtml(t)}${
              isAdmin
                ? `<button class="btn-toggle-pendente" data-toggle-pendente="${t.id}" data-pendente-atual="${t.pendente ? '1' : '0'}" title="${
                    t.pendente ? 'Marcar como concluído' : 'Marcar como pendente'
                  }">${t.pendente ? '✓ Concluir' : '⏳ Pendente'}</button>`
                : botaoRecebidoDefaultHtml(t, 'marcar-recebido-transacao')
            }`
          : '—';
      return `
        <tr>
          ${checkboxHtml}
          <td>${formatarDataHoraCompleta(t.dataHoraISO)}</td>
          <td>${escapeHtml(t.itemNome)}</td>
          <td class="${classe}">${sinal} ${t.quantidade}</td>
          <td>${t.quantidadeResultante}</td>
          <td>${t.usuarioNome ? escapeHtml(t.usuarioNome) : '—'}</td>
          <td>${entregaTextoHtml(t)}</td>
          <td class="col-status">${statusHtml}</td>
          <td>${t.perfil === 'admin' ? 'Admin' : 'Default'}</td>
          <td>${origemBadgeHtml(t)}</td>
          <td>${fotoHtml}</td>
        </tr>`;
    })
    .join('');

  qsa('[data-foto]', tbody).forEach((img) => {
    img.addEventListener('click', () => abrirLightbox(img.src));
  });

  if (isAdmin) {
    qsa('.historico-check', tbody).forEach((cb) => {
      cb.addEventListener('change', atualizarBotaoHistoricoExcluirSelecionadas);
    });
    qsa('[data-toggle-pendente]', tbody).forEach((btn) => {
      btn.addEventListener('click', async () => {
        const transacaoId = btn.dataset.togglePendente;
        const pendenteAtual = btn.dataset.pendenteAtual === '1';
        const res = await window.api.historico.definirPendente(transacaoId, !pendenteAtual);
        if (!res.ok) {
          toast(res.erro, 'erro');
          return;
        }
        await renderHistoricoDoDia();
        await renderPrecificacao();
        await renderPendencias();
      });
    });
  } else {
    qsa('[data-marcar-recebido-transacao]', tbody).forEach((btn) => {
      btn.addEventListener('click', async () => {
        const transacaoId = btn.dataset.marcarRecebidoTransacao;
        const marcadoAtual = btn.dataset.marcadoAtual === '1';
        const res = await window.api.historico.marcarRecebidoDefault(transacaoId, !marcadoAtual);
        if (!res.ok) {
          toast(res.erro, 'erro');
          return;
        }
        await renderHistoricoDoDia();
        toast(marcadoAtual ? 'Desmarcado.' : 'Marcado como recebido — o Admin ainda precisa confirmar.');
      });
    });
  }
  const marcarTodas = qs('#historico-marcar-todas');
  if (marcarTodas) marcarTodas.checked = false;
  atualizarBotaoHistoricoExcluirSelecionadas();

  await renderHistoricoLancamentosPagamentos(dataInicio, dataFim);
}

/** Segunda tabela da aba Histórico: lançamentos avulsos e pagamentos do período (não são movimentação de item). */
async function renderHistoricoLancamentosPagamentos(dataInicio, dataFim) {
  let registros = await window.api.historico.listarLancamentosEPagamentosPeriodo(dataInicio, dataFim);
  if (state.filtroHistoricoUsuario) {
    registros = registros.filter((r) => r.usuarioId === state.filtroHistoricoUsuario);
  }
  const tabela = qs('#historico-lancamentos-table');
  const vazio = qs('#historico-lancamentos-vazio');
  const titulo = qs('#historico-lancamentos-titulo');

  if (!registros.length) {
    tabela.classList.add('hidden');
    vazio.classList.add('hidden');
    titulo.classList.add('hidden');
    return;
  }
  titulo.classList.remove('hidden');
  vazio.classList.add('hidden');
  tabela.classList.remove('hidden');
  const isAdmin = state.perfil === 'admin';

  qs('tbody', tabela).innerHTML = registros
    .map((r) => {
      const tipoLabel = r.tipoRegistro === 'pagamento' ? 'Pagamento' : 'Lançamento avulso';
      const statusHtml =
        r.tipoRegistro === 'lancamento'
          ? `${statusBadgeHtml(r)}${
              isAdmin
                ? `<button class="btn-toggle-pendente" data-toggle-lancamento-historico="${r.id}" data-pendente-atual="${r.pendente ? '1' : '0'}" title="${
                    r.pendente ? 'Marcar como concluído' : 'Marcar como pendente'
                  }">${r.pendente ? '✓ Concluir' : '⏳ Pendente'}</button>`
                : botaoRecebidoDefaultHtml(r, 'marcar-recebido-lancamento-historico')
            }`
          : '—'; // pagamento não tem status pendente/concluído — é sempre um recebimento já efetivado
      return `
        <tr>
          <td>${formatarDataHoraCompleta(r.dataHoraISO)}</td>
          <td>${r.usuarioNome ? escapeHtml(r.usuarioNome) : '—'}</td>
          <td>${tipoLabel}</td>
          <td>${formatarMoeda(r.valor)}</td>
          <td>${escapeHtml(r.observacao || '—')}</td>
          <td class="col-status">${statusHtml}</td>
        </tr>`;
    })
    .join('');

  if (isAdmin) {
    qsa('[data-toggle-lancamento-historico]', tabela).forEach((btn) => {
      btn.addEventListener('click', async () => {
        const lancamentoId = btn.dataset.toggleLancamentoHistorico;
        const pendenteAtual = btn.dataset.pendenteAtual === '1';
        const res = await window.api.lancamentos.definirPendente(lancamentoId, !pendenteAtual);
        if (!res.ok) {
          toast(res.erro, 'erro');
          return;
        }
        await renderHistoricoLancamentosPagamentos(dataInicio, dataFim);
        await renderPendencias();
      });
    });
  } else {
    qsa('[data-marcar-recebido-lancamento-historico]', tabela).forEach((btn) => {
      btn.addEventListener('click', async () => {
        const lancamentoId = btn.dataset.marcarRecebidoLancamentoHistorico;
        const marcadoAtual = btn.dataset.marcadoAtual === '1';
        const res = await window.api.lancamentos.marcarRecebidoDefault(lancamentoId, !marcadoAtual);
        if (!res.ok) {
          toast(res.erro, 'erro');
          return;
        }
        await renderHistoricoLancamentosPagamentos(dataInicio, dataFim);
        toast(marcadoAtual ? 'Desmarcado.' : 'Marcado como recebido — o Admin ainda precisa confirmar.');
      });
    });
  }
}

function atualizarBotaoHistoricoExcluirSelecionadas() {
  const btn = qs('#btn-historico-excluir-selecionados');
  if (!btn) return;
  const marcados = qsa('.historico-check:checked').length;
  btn.disabled = marcados === 0;
  btn.textContent = marcados > 0 ? `Excluir selecionadas (${marcados})` : 'Excluir selecionadas';
}

function configurarExclusaoHistorico() {
  const marcarTodas = qs('#historico-marcar-todas');
  if (marcarTodas) {
    marcarTodas.addEventListener('change', () => {
      qsa('.historico-check').forEach((cb) => {
        cb.checked = marcarTodas.checked;
      });
      atualizarBotaoHistoricoExcluirSelecionadas();
    });
  }

  qs('#btn-historico-excluir-selecionados').addEventListener('click', () => {
    const ids = qsa('.historico-check:checked').map((cb) => cb.value);
    if (ids.length === 0) return;
    abrirConfirm(
      'Excluir movimentações selecionadas',
      `Excluir ${ids.length} movimentação(ões) do histórico? A quantidade de cada uma volta pro item ` +
        'correspondente (uma saída volta a somar, uma entrada volta a subtrair), exceto se o item já não ' +
        'existir mais no catálogo. Não pode ser desfeito.',
      async () => {
        const res = await window.api.historico.excluirSelecionados(ids);
        if (!res.ok) {
          toast(res.erro, 'erro');
          return;
        }
        await carregarItens();
        renderCatalogo();
        await inicializarHistorico();
        limparResultadoConsultar();
        await renderPrecificacao();
        await renderPendencias();
        toast(`${res.removidos} movimentação(ões) excluída(s) do histórico — quantidade devolvida aos itens.`);
      }
    );
  });

  qs('#btn-historico-excluir-tudo').addEventListener('click', () => {
    abrirConfirm(
      'Excluir todo o histórico',
      'Isso apaga TODAS as movimentações do histórico, de todos os dias, e devolve a quantidade de cada uma ' +
        'pro item correspondente (uma saída volta a somar, uma entrada volta a subtrair), exceto se o item já ' +
        'não existir mais no catálogo. Não pode ser desfeito.',
      async () => {
        const res = await window.api.historico.excluirTudo();
        if (!res.ok) {
          toast(res.erro, 'erro');
          return;
        }
        await carregarItens();
        renderCatalogo();
        await inicializarHistorico();
        limparResultadoConsultar();
        await renderPrecificacao();
        await renderPendencias();
        toast(`Histórico excluído (${res.removidos} movimentação(ões)) — quantidade devolvida aos itens.`);
      }
    );
  });
}

// ---------------------------------------------------------------------------
// Relatório de pedidos em PDF (botão "Gerar PDF de pedidos…" na aba Histórico)
// ---------------------------------------------------------------------------
//
// Lista as saídas (pedidos) de um período — item, usuário e valor precificado de cada
// uma, mais o total geral — num arquivo PDF que a pessoa escolhe onde salvar. Abre já
// preenchido com o dia selecionado no Histórico, mas as datas podem ser trocadas pra
// cobrir qualquer período (ver `logic.listarPedidosParaRelatorio`/`main.js`).

function configurarRelatorioPdf() {
  const modal = qs('#modal-relatorio-pdf');
  const inputInicio = qs('#relatorio-pdf-data-inicio');
  const inputFim = qs('#relatorio-pdf-data-fim');
  const erroEl = qs('#relatorio-pdf-erro');
  const btnGerar = qs('#relatorio-pdf-gerar');

  qs('#btn-abrir-relatorio-pdf').addEventListener('click', () => {
    const hoje = new Date();
    const hojeISO = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}-${String(hoje.getDate()).padStart(2, '0')}`;
    inputInicio.value = state.historicoDataInicio || hojeISO;
    inputFim.value = state.historicoDataFim || hojeISO;
    erroEl.classList.add('hidden');
    modal.classList.remove('hidden');
  });

  qs('#relatorio-pdf-cancelar').addEventListener('click', () => {
    modal.classList.add('hidden');
  });

  btnGerar.addEventListener('click', async () => {
    erroEl.classList.add('hidden');
    const dataInicio = inputInicio.value;
    const dataFim = inputFim.value;
    if (!dataInicio || !dataFim) {
      mostrarErroInline(erroEl, 'Preencha as duas datas (De / Até).');
      return;
    }
    if (dataInicio > dataFim) {
      mostrarErroInline(erroEl, 'A data "De" não pode ser depois da data "Até".');
      return;
    }

    const textoOriginal = btnGerar.textContent;
    btnGerar.disabled = true;
    btnGerar.textContent = 'Gerando…';
    try {
      const res = await window.api.relatorio.gerarPdfPedidos(dataInicio, dataFim);
      if (res.cancelado) return; // cancelou o "Salvar como" — não é erro, só deixa o modal aberto
      if (!res.ok) {
        mostrarErroInline(erroEl, res.erro);
        return;
      }
      modal.classList.add('hidden');
      toast(
        res.totalPedidos > 0
          ? `PDF gerado com ${res.totalPedidos} pedido(s) — total ${formatarMoeda(res.totalValor)}.`
          : 'PDF gerado (nenhum pedido encontrado nesse período).'
      );
    } finally {
      btnGerar.disabled = false;
      btnGerar.textContent = textoOriginal;
    }
  });
}

// ---------------------------------------------------------------------------
// Exportar quantidades do catálogo em PDF (aba Catálogo)
// ---------------------------------------------------------------------------
//
// Diferente do relatório de pedidos acima (que olha pro histórico, num período), esse é
// uma foto do catálogo AGORA: nome e quantidade de cada item que tem quantidade > 0 (os
// zerados ficam de fora), num PDF — sem modal, sem período pra escolher, só clicar e
// salvar (ver `logic.listarQuantidadesAtuaisParaRelatorio`/`main.js`).

function configurarExportarQuantidadesPdf() {
  const btn = qs('#btn-exportar-quantidades-pdf');
  if (!btn) return;

  btn.addEventListener('click', async () => {
    const textoOriginal = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Gerando…';
    try {
      const res = await window.api.relatorio.gerarPdfQuantidades();
      if (res.cancelado) return; // cancelou o "Salvar como" — não é erro
      if (!res.ok) {
        toast(res.erro, 'erro');
        return;
      }
      toast(
        res.totalItens > 0
          ? `PDF gerado com ${res.totalItens} item(ns) — total ${res.totalQuantidade} unidade(s).`
          : 'PDF gerado (nenhum item com quantidade no catálogo).'
      );
    } finally {
      btn.disabled = false;
      btn.textContent = textoOriginal;
    }
  });
}

// ---------------------------------------------------------------------------
// Modal genérico de confirmação
// ---------------------------------------------------------------------------

let confirmCallback = null;

function abrirConfirm(titulo, mensagem, onConfirmar) {
  qs('#confirm-titulo').textContent = titulo;
  qs('#confirm-mensagem').textContent = mensagem;
  confirmCallback = onConfirmar;
  qs('#modal-confirm').classList.remove('hidden');
}

function configurarModalConfirm() {
  qs('#confirm-cancelar').addEventListener('click', () => {
    qs('#modal-confirm').classList.add('hidden');
    confirmCallback = null;
  });
  qs('#confirm-ok').addEventListener('click', async () => {
    qs('#modal-confirm').classList.add('hidden');
    const cb = confirmCallback;
    confirmCallback = null;
    if (cb) await cb();
  });
}

// ---------------------------------------------------------------------------
// Lightbox de fotos
// ---------------------------------------------------------------------------

function abrirLightbox(src) {
  const container = qs('#lightbox-img');
  container.innerHTML = ehVideoDataUrl(src)
    ? `<video src="${src}" controls autoplay></video>`
    : `<img src="${src}" alt="" />`;
  qs('#lightbox').classList.remove('hidden');
}

function fecharLightbox() {
  qs('#lightbox').classList.add('hidden');
  // Limpa o conteúdo para parar qualquer vídeo em reprodução.
  qs('#lightbox-img').innerHTML = '';
}

function configurarLightbox() {
  qs('#lightbox-fechar').addEventListener('click', fecharLightbox);
  qs('#lightbox').addEventListener('click', (e) => {
    if (e.target.id === 'lightbox') fecharLightbox();
  });
}

// ---------------------------------------------------------------------------
// Consultar (por usuário ou por item, com período personalizável)
// ---------------------------------------------------------------------------

function atualizarSelectsConsultar() {
  const selUsuario = qs('#consultar-usuario-select');
  const valorAnteriorUsuario = selUsuario.value;
  selUsuario.innerHTML = state.usuarios
    .map(
      (u) =>
        `<option value="${u.id}" data-busca="${escapeHtml(buscaTextoUsuario(u))}">${escapeHtml(rotuloUsuarioComEstrela(u))} — ${escapeHtml(u.telefone || '')}</option>`
    )
    .join('');
  if (valorAnteriorUsuario && state.usuarios.some((u) => u.id === valorAnteriorUsuario)) {
    selUsuario.value = valorAnteriorUsuario;
  }
  const buscaUsuarioConsultar = qs('#consultar-usuario-busca');
  if (buscaUsuarioConsultar) filtrarOpcoesSelectUsuario(buscaUsuarioConsultar, selUsuario);

  // Aba Histórico: filtro de usuário é uma caixa de busca com sugestões aparecendo ao vivo
  // (ver `configurarAutocompleteHistoricoUsuario`) — se o usuário escolhido não existe mais
  // (removido), o filtro volta pra "todos".
  if (state.filtroHistoricoUsuario && !state.usuarios.some((u) => u.id === state.filtroHistoricoUsuario)) {
    state.filtroHistoricoUsuario = '';
    const inputHistorico = qs('#historico-usuario-busca');
    if (inputHistorico) inputHistorico.value = '';
    atualizarBotaoLimparHistoricoUsuario();
  }

  const selItem = qs('#consultar-item-select');
  const valorAnteriorItem = selItem.value;
  selItem.innerHTML = state.items.map((i) => `<option value="${i.id}">${escapeHtml(i.nome)}</option>`).join('');
  if (valorAnteriorItem && state.items.some((i) => i.id === valorAnteriorItem)) {
    selItem.value = valorAnteriorItem;
  }
}

function configurarConsultar() {
  qsa('.modo-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.consultarModo = btn.dataset.modo;
      qsa('.modo-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      qs('#consultar-alvo-usuario').classList.toggle('hidden', state.consultarModo !== 'usuario');
      qs('#consultar-alvo-item').classList.toggle('hidden', state.consultarModo !== 'item');
      limparResultadoConsultar();
    });
  });

  qsa('input[name="consultar-periodo"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      const personalizado = qs('input[name="consultar-periodo"]:checked').value === 'personalizado';
      qs('#consultar-periodo-datas').classList.toggle('hidden', !personalizado);
    });
  });

  qs('#btn-consultar').addEventListener('click', executarConsulta);
  configurarExportarConsultaPdf();
}

/**
 * Botão "Exportar PDF" da aba Consultar — só aparece depois de um "Consultar" bem-sucedido (ver
 * `executarConsulta`/`limparResultadoConsultar`) e gera um PDF com exatamente o que está na tela:
 * o mesmo filtro (usuário ou item), o mesmo período, o resumo/totais e a tabela de movimentações
 * (ver `main.js`/`relatorio:gerarPdfConsulta`).
 */
function configurarExportarConsultaPdf() {
  const btn = qs('#btn-consultar-pdf');
  btn.addEventListener('click', async () => {
    if (!state.consultaAtual) return;
    const { modo, usuarioId, itemId, dataInicio, dataFim } = state.consultaAtual;
    const textoOriginal = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Gerando…';
    try {
      const res = await window.api.relatorio.gerarPdfConsulta(modo, usuarioId, itemId, dataInicio, dataFim);
      if (res.cancelado) return; // cancelou o "Salvar como" — não é erro
      if (!res.ok) {
        toast(res.erro, 'erro');
        return;
      }
      toast(
        res.totalMovimentacoes > 0
          ? `PDF gerado com ${res.totalMovimentacoes} movimentação(ões).`
          : 'PDF gerado (nenhuma movimentação encontrada nesse período).'
      );
    } finally {
      btn.disabled = false;
      btn.textContent = textoOriginal;
    }
  });
}

function limparResultadoConsultar() {
  qs('#consultar-vazio').classList.remove('hidden');
  qs('#consultar-resumo-usuario').classList.add('hidden');
  qs('#consultar-resumo-item').classList.add('hidden');
  qs('#consultar-transacoes-table').classList.add('hidden');
  qs('#consultar-transacoes-vazio').classList.add('hidden');
  state.consultaAtual = null;
  qs('#btn-consultar-pdf').classList.add('hidden');
}

function obterPeriodoSelecionado() {
  const personalizado = qs('input[name="consultar-periodo"]:checked').value === 'personalizado';
  if (!personalizado) return { dataInicio: null, dataFim: null };
  const dataInicio = qs('#consultar-data-inicio').value || null;
  const dataFim = qs('#consultar-data-fim').value || null;
  return { dataInicio, dataFim };
}

/** Abre a aba Consultar já filtrada para um item específico (atalho do card do catálogo). */
function abrirConsultarParaItem(itemId) {
  qsa('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === 'consultar'));
  qsa('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === 'tab-consultar'));

  state.consultarModo = 'item';
  qsa('.modo-btn').forEach((b) => b.classList.toggle('active', b.dataset.modo === 'item'));
  qs('#consultar-alvo-usuario').classList.add('hidden');
  qs('#consultar-alvo-item').classList.remove('hidden');
  qs('#consultar-item-select').value = itemId;

  qs('input[name="consultar-periodo"][value="inteiro"]').checked = true;
  qs('#consultar-periodo-datas').classList.add('hidden');

  executarConsulta();
}

/** Abre a aba Consultar já filtrada para um usuário específico (atalho da aba Usuários). */
function abrirConsultarParaUsuario(usuarioId) {
  qsa('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === 'consultar'));
  qsa('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === 'tab-consultar'));

  state.consultarModo = 'usuario';
  qsa('.modo-btn').forEach((b) => b.classList.toggle('active', b.dataset.modo === 'usuario'));
  qs('#consultar-alvo-item').classList.add('hidden');
  qs('#consultar-alvo-usuario').classList.remove('hidden');
  qs('#consultar-usuario-busca').value = '';
  filtrarOpcoesSelectUsuario(qs('#consultar-usuario-busca'), qs('#consultar-usuario-select'));
  qs('#consultar-usuario-select').value = usuarioId;

  qs('input[name="consultar-periodo"][value="inteiro"]').checked = true;
  qs('#consultar-periodo-datas').classList.add('hidden');

  executarConsulta();
}

async function executarConsulta() {
  const { dataInicio, dataFim } = obterPeriodoSelecionado();

  if (state.consultarModo === 'usuario') {
    const usuarioId = qs('#consultar-usuario-select').value;
    if (!usuarioId) {
      toast('Cadastre e selecione um usuário para consultar.', 'erro');
      return;
    }
    const resultado = await window.api.consulta.porUsuario(usuarioId, dataInicio, dataFim);
    renderConsultaUsuario(resultado);
    state.consultaAtual = { modo: 'usuario', usuarioId, dataInicio, dataFim };
  } else {
    const itemId = qs('#consultar-item-select').value;
    if (!itemId) {
      toast('Cadastre e selecione um item para consultar.', 'erro');
      return;
    }
    const resultado = await window.api.consulta.porItem(itemId, dataInicio, dataFim);
    renderConsultaItem(resultado);
    state.consultaAtual = { modo: 'item', itemId, dataInicio, dataFim };
  }
  qs('#btn-consultar-pdf').classList.remove('hidden');
}

function renderConsultaUsuario(resultado) {
  qs('#consultar-vazio').classList.add('hidden');
  qs('#consultar-resumo-item').classList.add('hidden');
  qs('#consultar-resumo-usuario').classList.remove('hidden');

  const corpoSoma = qs('#consultar-soma-item-body');
  corpoSoma.innerHTML = resultado.somaPorItem.length
    ? resultado.somaPorItem
        .map(
          (s) => `
        <tr>
          <td>${escapeHtml(s.itemNome)}</td>
          <td>${s.totalEntrada}</td>
          <td>${s.totalSaida}</td>
          <td>${s.saldoLiquido}</td>
        </tr>`
        )
        .join('')
    : '<tr><td colspan="4" class="vazio">Nenhuma movimentação no período.</td></tr>';

  const lancamentos = resultado.lancamentos || [];
  const tituloLancamentos = qs('#consultar-lancamentos-titulo');
  const tabelaLancamentos = qs('#consultar-lancamentos-table');
  const isAdmin = state.perfil === 'admin';
  if (lancamentos.length) {
    tituloLancamentos.classList.remove('hidden');
    tabelaLancamentos.classList.remove('hidden');
    qs('tbody', tabelaLancamentos).innerHTML = lancamentos
      .map(
        (l) => `
        <tr>
          <td>${formatarDataHoraCompleta(l.dataHoraISO)}</td>
          <td>${formatarMoeda(l.valor)}</td>
          <td>${escapeHtml(l.observacao || '—')}</td>
          <td class="col-status">
            ${statusBadgeHtml(l)}
            ${
              isAdmin
                ? `<button class="btn-toggle-pendente" data-toggle-lancamento-consulta="${l.id}" data-pendente-atual="${l.pendente ? '1' : '0'}" title="${
                    l.pendente ? 'Marcar como concluído' : 'Marcar como pendente'
                  }">${l.pendente ? '✓ Concluir' : '⏳ Pendente'}</button>`
                : botaoRecebidoDefaultHtml(l, 'marcar-recebido-lancamento-consulta')
            }
          </td>
        </tr>`
      )
      .join('');

    if (isAdmin) {
      qsa('[data-toggle-lancamento-consulta]', tabelaLancamentos).forEach((btn) => {
        btn.addEventListener('click', async () => {
          const lancamentoId = btn.dataset.toggleLancamentoConsulta;
          const pendenteAtual = btn.dataset.pendenteAtual === '1';
          const res = await window.api.lancamentos.definirPendente(lancamentoId, !pendenteAtual);
          if (!res.ok) {
            toast(res.erro, 'erro');
            return;
          }
          await executarConsulta();
          await renderPendencias();
        });
      });
    } else {
      qsa('[data-marcar-recebido-lancamento-consulta]', tabelaLancamentos).forEach((btn) => {
        btn.addEventListener('click', async () => {
          const lancamentoId = btn.dataset.marcarRecebidoLancamentoConsulta;
          const marcadoAtual = btn.dataset.marcadoAtual === '1';
          const res = await window.api.lancamentos.marcarRecebidoDefault(lancamentoId, !marcadoAtual);
          if (!res.ok) {
            toast(res.erro, 'erro');
            return;
          }
          await executarConsulta();
          toast(marcadoAtual ? 'Desmarcado.' : 'Marcado como recebido — o Admin ainda precisa confirmar.');
        });
      });
    }
  } else {
    tituloLancamentos.classList.add('hidden');
    tabelaLancamentos.classList.add('hidden');
  }

  renderTabelaTransacoes(resultado.transacoes);
}

function renderConsultaItem(resultado) {
  qs('#consultar-vazio').classList.add('hidden');
  qs('#consultar-resumo-usuario').classList.add('hidden');
  qs('#consultar-resumo-item').classList.remove('hidden');

  qs('#consultar-item-total-entrada').textContent = resultado.totalEntrada;
  qs('#consultar-item-total-saida').textContent = resultado.totalSaida;
  qs('#consultar-item-qtd-atual').textContent = resultado.quantidadeAtual ?? '— (item removido do catálogo)';

  const tituloUsuarios = qs('#consultar-item-usuarios-titulo');
  const tabelaUsuarios = qs('#consultar-item-usuarios-table');
  if (resultado.usuariosEnvolvidos.length) {
    tituloUsuarios.classList.remove('hidden');
    tabelaUsuarios.classList.remove('hidden');
    qs('tbody', tabelaUsuarios).innerHTML = resultado.usuariosEnvolvidos
      .map((u) => `<tr><td>${escapeHtml(u.usuarioNome)}</td><td>${u.totalRecebido}</td></tr>`)
      .join('');
  } else {
    tituloUsuarios.classList.add('hidden');
    tabelaUsuarios.classList.add('hidden');
  }

  renderTabelaTransacoes(resultado.transacoes);
}

function renderTabelaTransacoes(transacoes) {
  const tabela = qs('#consultar-transacoes-table');
  const vazio = qs('#consultar-transacoes-vazio');
  if (!transacoes.length) {
    tabela.classList.add('hidden');
    vazio.classList.remove('hidden');
    return;
  }
  vazio.classList.add('hidden');
  tabela.classList.remove('hidden');

  qs('tbody', tabela).innerHTML = transacoes
    .map((t) => {
      const sinal = t.tipo === 'entrada' ? '+' : '−';
      const classe = t.tipo === 'entrada' ? 'tag-entrada' : 'tag-saida';
      const fotoHtml = thumbMidiaHtml(t.foto, t.id);
      return `
        <tr>
          <td>${formatarDia(t.dataDia)}</td>
          <td>${formatarDataHora(t.dataHoraISO)}</td>
          <td>${escapeHtml(t.itemNome)}</td>
          <td>${t.usuarioNome ? escapeHtml(t.usuarioNome) : '—'}</td>
          <td class="${classe}">${sinal} ${t.quantidade}</td>
          <td>${t.quantidadeResultante}</td>
          <td>${entregaTextoHtml(t)}</td>
          <td>${statusBadgeHtml(t)}</td>
          <td>${t.perfil === 'admin' ? 'Admin' : 'Default'}</td>
          <td>${origemBadgeHtml(t)}</td>
          <td>${fotoHtml}</td>
        </tr>`;
    })
    .join('');

  qsa('[data-foto]', tabela).forEach((img) => {
    img.addEventListener('click', () => abrirLightbox(img.src));
  });
}

// ---------------------------------------------------------------------------
// Precificação (valor unitário por item — só o admin define, só nesta aba)
// ---------------------------------------------------------------------------

async function renderPrecificacao() {
  const tabela = qs('#precificacao-table');
  const vazio = qs('#precificacao-vazio');
  if (!tabela) return; // aba pode não existir ainda na primeira chamada muito cedo

  const resultado = await window.api.precificacao.listar();
  const isAdmin = state.perfil === 'admin';

  qs('#precificacao-total-estoque').textContent = formatarMoeda(resultado.totalEstoque);
  qs('#precificacao-total-saida').textContent = formatarMoeda(resultado.totalSaida);
  qs('#precificacao-total-pendente').textContent = formatarMoeda(resultado.totalPendente);

  vazio.classList.toggle('hidden', resultado.itens.length !== 0);
  tabela.classList.toggle('hidden', resultado.itens.length === 0);

  qs('tbody', tabela).innerHTML = resultado.itens
    .map((l) => {
      const valorUnitarioHtml = isAdmin
        ? `<input type="number" class="input-preco" min="0" step="0.01" value="${l.precoUnitario}" data-item-id="${l.itemId}" />`
        : formatarMoeda(l.precoUnitario);
      // Valor saído/pendente por item: mesma restrição dos cards de total logo acima —
      // só o Admin vê (ver <span class="admin-only"> na aba e os <th> correspondentes).
      const colsAdmin = isAdmin
        ? `<td>${formatarMoeda(l.valorSaida)}</td><td>${formatarMoeda(l.valorPendente)}</td>`
        : '';
      return `
        <tr>
          <td>${escapeHtml(l.itemNome)}</td>
          <td>${l.quantidade}</td>
          <td>${valorUnitarioHtml}</td>
          <td>${formatarMoeda(l.valorEstoque)}</td>
          ${colsAdmin}
        </tr>`;
    })
    .join('');
}

function configurarPrecificacao() {
  const tabela = qs('#precificacao-table');
  if (!tabela) return;
  tabela.addEventListener('change', async (e) => {
    if (!e.target.classList.contains('input-preco')) return;
    if (state.perfil !== 'admin') return;
    const itemId = e.target.dataset.itemId;
    const preco = parseFloat(e.target.value);
    const res = await window.api.items.definirPreco(itemId, Number.isFinite(preco) ? preco : 0);
    if (!res.ok) {
      toast(res.erro, 'erro');
      await renderPrecificacao();
      return;
    }
    await renderPrecificacao();
    await renderPendencias(); // o valor de uma saída pendente usa o preço ATUAL do item
    toast('Valor unitário atualizado.');
  });
}

// ---------------------------------------------------------------------------
// Pendências (visão consolidada por usuário — pagamento abate o total, sem item)
// ---------------------------------------------------------------------------
//
// Lista os usuários com saldo pendente (soma de saídas pendentes + lançamentos
// avulsos pendentes, menos os pagamentos já registrados — ver
// `logic.listarUsuariosPendentes`/`detalharPendenciasUsuario`). Clicar num
// usuário abre o detalhamento logo abaixo, nesta mesma aba; o formulário de
// pagamento (exclusivo do Admin) fica junto, no mesmo painel.
//
// Segunda coluna, "Já pago" (ver `logic.listarUsuariosQuitados`): quem já teve pendência e
// hoje está com saldo zerado. O Admin tem, na coluna "Pendentes", um atalho "✓ Marcar como
// pago" que quita o saldo inteiro numa tacada só (`pendencias:quitarUsuario`) — o usuário só
// sai de lá e entra em "Já pago" na próxima renderização, depois de zerado de verdade.

async function renderPendencias() {
  const tabela = qs('#pendencias-table');
  const vazio = qs('#pendencias-vazio');
  if (!tabela) return; // aba pode não existir ainda na primeira chamada muito cedo
  const isAdmin = state.perfil === 'admin';

  const [lista, quitados, totaisGeral] = await Promise.all([
    window.api.pendencias.listarUsuarios(),
    window.api.pendencias.listarQuitados(),
    window.api.pendencias.totalizar(),
  ]);

  qs('#pendencias-geral-total-pendencias').textContent = formatarMoeda(totaisGeral.totalPendencias);
  qs('#pendencias-geral-total-pagamentos').textContent = formatarMoeda(totaisGeral.totalPagamentos);
  qs('#pendencias-geral-saldo').textContent = formatarMoeda(totaisGeral.totalPendente);

  vazio.classList.toggle('hidden', lista.length !== 0);
  tabela.classList.toggle('hidden', lista.length === 0);

  qs('tbody', tabela).innerHTML = lista
    .map(
      (u) => `
      <tr data-pendencia-usuario="${u.usuarioId}">
        <td>${escapeHtml(u.usuarioNome)}</td>
        <td>${escapeHtml(u.usuarioTelefone || '—')}</td>
        <td>${formatarMoeda(u.totalPendente)}</td>
        <td>
          <span class="acoes-pendencia-wrap">
            ${
              isAdmin
                ? `<button class="btn btn-primary btn-pequeno" data-pendencia-quitar="${u.usuarioId}">✓ Marcar como pago</button>`
                : ''
            }
            <button class="btn btn-texto btn-pequeno" data-pendencia-ver="${u.usuarioId}">Ver detalhes</button>
          </span>
        </td>
      </tr>`
    )
    .join('');

  qsa('[data-pendencia-usuario]', tabela).forEach((tr) => {
    tr.addEventListener('click', () => abrirDetalhePendencia(tr.dataset.pendenciaUsuario));
  });
  qsa('[data-pendencia-quitar]', tabela).forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation(); // não deixa o clique "vazar" pro <tr> e abrir/duplicar o detalhamento
      abrirConfirmarQuitacao(btn.dataset.pendenciaQuitar, lista);
    });
  });

  const tabelaQuitados = qs('#pendencias-quitados-table');
  const vazioQuitados = qs('#pendencias-quitados-vazio');
  vazioQuitados.classList.toggle('hidden', quitados.length !== 0);
  tabelaQuitados.classList.toggle('hidden', quitados.length === 0);
  qs('tbody', tabelaQuitados).innerHTML = quitados
    .map(
      (u) => `
      <tr data-pendencia-usuario="${u.usuarioId}">
        <td>${escapeHtml(u.usuarioNome)}</td>
        <td>${escapeHtml(u.usuarioTelefone || '—')}</td>
        <td>${formatarMoeda(u.totalPago)}</td>
      </tr>`
    )
    .join('');
  qsa('[data-pendencia-usuario]', tabelaQuitados).forEach((tr) => {
    tr.addEventListener('click', () => abrirDetalhePendencia(tr.dataset.pendenciaUsuario));
  });

  if (state.pendenciaUsuarioAtual && !state.usuarios.some((u) => u.id === state.pendenciaUsuarioAtual)) {
    // O usuário que estava aberto no detalhamento não existe mais (foi excluído) — fecha o
    // painel em vez de deixar dado velho. Só ter saído da lista de pendentes (por ter sido
    // quitado agora) NÃO fecha — o detalhamento continua valendo, só que ele mudou de coluna.
    fecharDetalhePendencia();
  } else if (state.pendenciaUsuarioAtual) {
    await abrirDetalhePendencia(state.pendenciaUsuarioAtual);
  }
}

function marcarLinhaPendenciaAtiva() {
  qsa('#pendencias-table tbody tr, #pendencias-quitados-table tbody tr').forEach((tr) => {
    tr.classList.toggle('pendencia-linha-ativa', tr.dataset.pendenciaUsuario === state.pendenciaUsuarioAtual);
  });
}

/** Confirma antes de quitar (ação do Admin, mexe com dinheiro) — mostra o valor exato que vai virar pagamento. */
function abrirConfirmarQuitacao(usuarioId, listaPendentes) {
  const usuario = listaPendentes.find((u) => u.usuarioId === usuarioId);
  if (!usuario) return;
  abrirConfirm(
    'Marcar como pago',
    `Registrar um pagamento de ${formatarMoeda(usuario.totalPendente)} para ${usuario.usuarioNome}, ` +
      'quitando toda a pendência dele agora? Essa ação não pode ser desfeita.',
    async () => {
      const res = await window.api.pendencias.quitarUsuario(usuarioId, 'Quitação total via aba Pendências');
      if (!res.ok) {
        toast(res.erro, 'erro');
        return;
      }
      await atualizarTudoAposMudarPendencia();
      toast(`Pendência de ${usuario.usuarioNome} quitada.`);
    }
  );
}

async function abrirDetalhePendencia(usuarioId) {
  state.pendenciaUsuarioAtual = usuarioId;
  marcarLinhaPendenciaAtiva();
  const isAdmin = state.perfil === 'admin';

  const detalhe = await window.api.pendencias.detalharUsuario(usuarioId);
  qs('#pendencias-detalhe').classList.remove('hidden');
  qs('#pendencias-detalhe-usuario').textContent = detalhe.usuarioNome || '—';
  qs('#pendencias-detalhe-total-pendencias').textContent = formatarMoeda(detalhe.totalPendencias);
  qs('#pendencias-detalhe-total-pagamentos').textContent = formatarMoeda(detalhe.totalPagamentos);
  qs('#pendencias-detalhe-saldo').textContent = formatarMoeda(detalhe.totalPendente);

  // Default pode registrar um pagamento, exceto para um usuário que o Admin bloqueou
  // (ver `usuarios:definirBloqueio`) — o Admin continua livre sobre qualquer usuário.
  const pagamentoBloqueado = !isAdmin && !!detalhe.bloqueadoParaDefault;
  qs('#pendencia-pagamento-form-wrap').classList.toggle('hidden', pagamentoBloqueado);
  qs('#pendencia-pagamento-bloqueado-aviso').classList.toggle('hidden', !pagamentoBloqueado);

  // "O que está pendente": um lançamento avulso pode ser editado (valor/descrição, direto na
  // linha) ou excluído pelo Admin; uma saída de item só pode ser excluída daqui (o registro some
  // do Histórico) — mudar a quantidade dela é coisa do Histórico/Desfazer, não desta tela.
  const tabelaItens = qs('#pendencias-detalhe-itens-table');
  const vazioItens = qs('#pendencias-detalhe-itens-vazio');
  if (detalhe.pendencias.length) {
    vazioItens.classList.add('hidden');
    tabelaItens.classList.remove('hidden');
    qs('tbody', tabelaItens).innerHTML = detalhe.pendencias
      .map((p) => {
        const isLancamento = p.tipo === 'lancamento';
        const editavel = isLancamento;
        const descricaoCol = editavel
          ? `<input type="text" class="input-observacao" maxlength="500" value="${escapeHtml(p.descricao)}" />`
          : `${escapeHtml(p.descricao)}${p.quantidade ? ` (qtd. ${p.quantidade})` : ''}`;
        const valorCol = editavel
          ? `<input type="number" class="input-preco" step="0.01" value="${p.valor}" />`
          : formatarMoeda(p.valor);
        const acoesTd = isAdmin
          ? `<td class="col-acoes-pendencia"><span class="acoes-pendencia-wrap">${
              isLancamento
                ? `<button class="btn btn-perigo btn-pequeno" data-excluir-lancamento="${p.id}">Excluir</button>`
                : `<button class="btn btn-perigo btn-pequeno" data-excluir-transacao="${p.id}">Excluir do histórico</button>`
            }</span></td>`
          : '';
        return `
          <tr${isLancamento ? ` data-lancamento-id="${p.id}"` : ''}>
            <td>${formatarDataHoraCompleta(p.dataHoraISO)}</td>
            <td>${descricaoCol}</td>
            <td>${valorCol}</td>
            ${acoesTd}
          </tr>`;
      })
      .join('');
  } else {
    vazioItens.classList.remove('hidden');
    tabelaItens.classList.add('hidden');
  }

  // "Pagamentos já registrados": valor e comentário editáveis direto na linha, e um "Excluir" —
  // os dois exclusivos do Admin, igual ao resto das ações financeiras do app.
  const tabelaPagamentos = qs('#pendencias-detalhe-pagamentos-table');
  const vazioPagamentos = qs('#pendencias-detalhe-pagamentos-vazio');
  if (detalhe.pagamentos.length) {
    vazioPagamentos.classList.add('hidden');
    tabelaPagamentos.classList.remove('hidden');
    qs('tbody', tabelaPagamentos).innerHTML = detalhe.pagamentos
      .map((p) => {
        const valorCol = `<input type="number" class="input-preco" min="0.01" step="0.01" value="${p.valor}" />`;
        const obsCol = `<input type="text" class="input-observacao" maxlength="500" value="${escapeHtml(p.observacao || '')}" />`;
        const acoesTd = isAdmin
          ? `<td class="col-acoes-pendencia"><span class="acoes-pendencia-wrap">
              <button class="btn btn-perigo btn-pequeno" data-excluir-pagamento="${p.id}">Excluir</button>
            </span></td>`
          : '';
        return `
          <tr data-pagamento-id="${p.id}">
            <td>${formatarDataHoraCompleta(p.dataHoraISO)}</td>
            <td>${valorCol}</td>
            <td>${obsCol}</td>
            ${acoesTd}
          </tr>`;
      })
      .join('');
  } else {
    vazioPagamentos.classList.remove('hidden');
    tabelaPagamentos.classList.add('hidden');
  }
}

function fecharDetalhePendencia() {
  state.pendenciaUsuarioAtual = null;
  qs('#pendencias-detalhe').classList.add('hidden');
  marcarLinhaPendenciaAtiva();
}

/** Abre a aba Pendências já com o detalhamento de um usuário específico (atalho da aba Usuários). */
async function abrirPendenciaDoUsuarioNaAba(usuarioId) {
  qsa('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === 'pendencias'));
  qsa('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === 'tab-pendencias'));
  await renderPendencias();
  await abrirDetalhePendencia(usuarioId);
}

/** Depois de editar/excluir um lançamento ou pagamento, tudo que depende desses dados é atualizado junto. */
async function atualizarTudoAposMudarPendencia() {
  await renderPendencias();
  await renderHistoricoDoDia();
}

function configurarPendencias() {
  const tabela = qs('#pendencias-table');
  if (!tabela) return;

  qs('#pendencias-detalhe-fechar').addEventListener('click', fecharDetalhePendencia);

  const btnExportarPdf = qs('#pendencias-detalhe-exportar-pdf');
  btnExportarPdf.addEventListener('click', async () => {
    if (!state.pendenciaUsuarioAtual) return;
    const textoOriginal = btnExportarPdf.textContent;
    btnExportarPdf.disabled = true;
    btnExportarPdf.textContent = 'Gerando…';
    try {
      const res = await window.api.relatorio.gerarPdfPendenciaUsuario(state.pendenciaUsuarioAtual);
      if (res.cancelado) return; // cancelou o "Salvar como" — não é erro
      if (!res.ok) {
        toast(res.erro, 'erro');
        return;
      }
      toast(`PDF gerado — saldo pendente atual: ${formatarMoeda(res.totalPendente)}.`);
    } finally {
      btnExportarPdf.disabled = false;
      btnExportarPdf.textContent = textoOriginal;
    }
  });

  qs('#pendencia-pagamento-btn').addEventListener('click', async () => {
    const erroEl = qs('#pendencia-pagamento-erro');
    erroEl.classList.add('hidden');
    if (!state.pendenciaUsuarioAtual) return;

    const valor = parseFloat(qs('#pendencia-pagamento-valor').value);
    if (!Number.isFinite(valor) || valor <= 0) {
      mostrarErroInline(erroEl, 'Informe um valor válido, maior que zero.');
      return;
    }
    const comentario = qs('#pendencia-pagamento-comentario').value.trim();
    if (!comentario) {
      mostrarErroInline(erroEl, 'O comentário é obrigatório.');
      return;
    }

    const res = await window.api.pagamentos.adicionar(state.pendenciaUsuarioAtual, valor, comentario);
    if (!res.ok) {
      mostrarErroInline(erroEl, res.erro);
      return;
    }

    qs('#pendencia-pagamento-valor').value = '';
    qs('#pendencia-pagamento-comentario').value = '';
    await atualizarTudoAposMudarPendencia();
    toast('Pagamento registrado.');
  });

  // "O que está pendente": editar (só lançamentos, ao vivo na linha, aberto aos dois perfis para
  // qualquer usuário) e excluir (lançamento ou saída de item) — excluir continua exclusivo do Admin.
  const tabelaItens = qs('#pendencias-detalhe-itens-table');
  tabelaItens.addEventListener('change', async (e) => {
    const tr = e.target.closest('tr[data-lancamento-id]');
    if (!tr) return;
    const lancamentoId = tr.dataset.lancamentoId;
    const valorInput = qs('.input-preco', tr);
    const obsInput = qs('.input-observacao', tr);
    if (!valorInput || !obsInput) return;

    const valor = parseFloat(valorInput.value);
    if (!Number.isFinite(valor) || valor === 0) {
      toast('Informe um valor diferente de zero (negativo funciona como crédito/desconto).', 'erro');
      await abrirDetalhePendencia(state.pendenciaUsuarioAtual); // desfaz a edição inválida na tela
      return;
    }
    const res = await window.api.lancamentos.editar(lancamentoId, valor, obsInput.value.trim());
    if (!res.ok) {
      toast(res.erro, 'erro');
      await abrirDetalhePendencia(state.pendenciaUsuarioAtual);
      return;
    }
    await atualizarTudoAposMudarPendencia();
    toast('Lançamento atualizado.');
  });
  tabelaItens.addEventListener('click', (e) => {
    const btnLancamento = e.target.closest('[data-excluir-lancamento]');
    if (btnLancamento) {
      const id = btnLancamento.dataset.excluirLancamento;
      abrirConfirm(
        'Excluir lançamento',
        'Excluir esse lançamento avulso definitivamente? Essa ação não pode ser desfeita.',
        async () => {
          const res = await window.api.lancamentos.remover(id);
          if (!res.ok) {
            toast(res.erro, 'erro');
            return;
          }
          await atualizarTudoAposMudarPendencia();
          toast('Lançamento excluído.');
        }
      );
      return;
    }
    const btnTransacao = e.target.closest('[data-excluir-transacao]');
    if (btnTransacao) {
      const id = btnTransacao.dataset.excluirTransacao;
      abrirConfirm(
        'Excluir do histórico',
        'Excluir esse registro do Histórico? A quantidade dele volta pro item correspondente, exceto se o ' +
          'item já não existir mais no catálogo.',
        async () => {
          const res = await window.api.historico.excluirSelecionados([id]);
          if (!res.ok) {
            toast(res.erro, 'erro');
            return;
          }
          await carregarItens();
          renderCatalogo();
          await atualizarTudoAposMudarPendencia();
          await renderPrecificacao();
          toast('Registro excluído do histórico — quantidade devolvida ao item.');
        }
      );
    }
  });

  // "Pagamentos já registrados": editar (valor/comentário, ao vivo na linha, aberto aos dois
  // perfis) e excluir — excluir continua exclusivo do Admin. Valor de pagamento continua só
  // positivo (é dinheiro recebido de fato, diferente do lançamento avulso).
  const tabelaPagamentos = qs('#pendencias-detalhe-pagamentos-table');
  tabelaPagamentos.addEventListener('change', async (e) => {
    const tr = e.target.closest('tr[data-pagamento-id]');
    if (!tr) return;
    const pagamentoId = tr.dataset.pagamentoId;
    const valorInput = qs('.input-preco', tr);
    const obsInput = qs('.input-observacao', tr);
    if (!valorInput || !obsInput) return;

    const valor = parseFloat(valorInput.value);
    if (!Number.isFinite(valor) || valor <= 0) {
      toast('Informe um valor válido, maior que zero.', 'erro');
      await abrirDetalhePendencia(state.pendenciaUsuarioAtual);
      return;
    }
    const observacao = obsInput.value.trim();
    if (!observacao) {
      toast('O comentário do pagamento não pode ficar vazio.', 'erro');
      await abrirDetalhePendencia(state.pendenciaUsuarioAtual);
      return;
    }
    const res = await window.api.pagamentos.editar(pagamentoId, valor, observacao);
    if (!res.ok) {
      toast(res.erro, 'erro');
      await abrirDetalhePendencia(state.pendenciaUsuarioAtual);
      return;
    }
    await atualizarTudoAposMudarPendencia();
    toast('Pagamento atualizado.');
  });
  tabelaPagamentos.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-excluir-pagamento]');
    if (!btn) return;
    const id = btn.dataset.excluirPagamento;
    abrirConfirm(
      'Excluir pagamento',
      'Excluir esse pagamento definitivamente? O saldo pendente do usuário volta a considerar esse valor como não pago. Essa ação não pode ser desfeita.',
      async () => {
        const res = await window.api.pagamentos.remover(id);
        if (!res.ok) {
          toast(res.erro, 'erro');
          return;
        }
        await atualizarTudoAposMudarPendencia();
        toast('Pagamento excluído.');
      }
    );
  });

  const btnExcluirLancamentos = qs('#btn-historico-excluir-lancamentos');
  if (btnExcluirLancamentos) {
    btnExcluirLancamentos.addEventListener('click', () => {
      abrirConfirm(
        'Excluir todos os lançamentos e pagamentos',
        'Isso vai apagar TODOS os lançamentos avulsos e pagamentos registrados, de todos os usuários e de ' +
          'todos os dias. As movimentações de item (entradas/saídas do catálogo) não são afetadas. Essa ação ' +
          'não pode ser desfeita.',
        async () => {
          const res = await window.api.historico.excluirTodosLancamentosEPagamentos();
          if (!res.ok) {
            toast(res.erro, 'erro');
            return;
          }
          await atualizarTudoAposMudarPendencia();
          toast('Lançamentos e pagamentos excluídos.');
        }
      );
    });
  }
}

// ---------------------------------------------------------------------------
// Contas de login (gerenciador do Default — exclusivo do Admin)
// ---------------------------------------------------------------------------
//
// Substitui a antiga entrada livre e sem senha do Default: o Admin cadastra uma conta
// (usuário + senha temporária) pra cada pessoa, pode excluir e pode resetar a senha (também
// temporária) — ver window.api.contasLogin.* / logic.js. A troca da senha temporária pela senha
// definitiva da pessoa acontece na tela de login (ver configurarModalLogin acima), não aqui.

let contaLoginParaResetarId = null;

function formatarDataCurta(iso) {
  return new Date(iso).toLocaleDateString('pt-BR');
}

async function renderContasLogin() {
  const tabela = qs('#contas-login-table');
  if (!tabela) return;
  const res = await window.api.contasLogin.listar();
  const contas = res.ok ? res.contas : [];

  const vazio = qs('#contas-login-vazio');
  vazio.classList.toggle('hidden', contas.length !== 0);
  tabela.classList.toggle('hidden', contas.length === 0);

  qs('tbody', tabela).innerHTML = contas
    .map(
      (c) => `
      <tr data-conta-login-id="${escapeHtml(c.id)}">
        <td><span data-conta-nome>${escapeHtml(c.usuario)}</span>${c.ehVoce ? ' <span class="texto-suave">(você)</span>' : ''}</td>
        <td>${
          c.admin
            ? '<span class="badge-status badge-status-admin">Admin</span>'
            : '<span class="badge-status badge-status-default">Default</span>'
        }</td>
        <td>${formatarDataCurta(c.criadoEm)}</td>
        <td>${
          c.precisaTrocarSenha
            ? '<span class="badge-status badge-status-pendente">Aguardando 1º acesso</span>'
            : '<span class="badge-status badge-status-concluido">Ativa</span>'
        }</td>
        <td>
          <span class="acoes-pendencia-wrap">
            ${
              c.admin
                ? c.ehVoce
                  ? ''
                  : `<button class="btn btn-texto btn-pequeno" data-conta-login-admin="${escapeHtml(c.id)}" data-admin-novo="0">Tirar Admin</button>`
                : `<button class="btn btn-texto btn-pequeno" data-conta-login-admin="${escapeHtml(c.id)}" data-admin-novo="1">Tornar Admin</button>`
            }
            <button class="btn btn-texto btn-pequeno" data-conta-login-resetar="${escapeHtml(c.id)}" data-conta-login-usuario="${escapeHtml(
        c.usuario
      )}">Resetar senha</button>
            ${c.ehVoce ? '' : `<button class="btn btn-perigo btn-pequeno" data-conta-login-excluir="${escapeHtml(c.id)}">Excluir</button>`}
          </span>
        </td>
      </tr>`
    )
    .join('');

  qsa('[data-conta-login-resetar]', tabela).forEach((btn) => {
    btn.addEventListener('click', () =>
      abrirModalResetarSenhaConta(btn.dataset.contaLoginResetar, btn.dataset.contaLoginUsuario)
    );
  });
  qsa('[data-conta-login-admin]', tabela).forEach((btn) => {
    btn.addEventListener('click', () => {
      const contaId = btn.dataset.contaLoginAdmin;
      const tornar = btn.dataset.adminNovo === '1';
      const usuario = qs('[data-conta-nome]', btn.closest('tr'))?.textContent || '';
      abrirConfirm(
        tornar ? 'Tornar Admin' : 'Tirar acesso de Admin',
        tornar
          ? `Dar acesso de Admin para "${usuario}"? Essa conta vai ter EXATAMENTE os mesmos poderes que você: ` +
            'editar/excluir itens, pessoas e histórico, ver e quitar pendências, importar/exportar backup e ' +
            'criar, excluir ou promover outras contas (inclusive tirar o Admin de outras). Só faça isso com ' +
            'alguém de total confiança. Se ela estiver logada agora, vai precisar entrar de novo.'
          : `Tirar o acesso de Admin de "${usuario}"? A conta continua existindo e volta a ser Default. ` +
            'Se ela estiver no modo Admin agora, a sessão dela é encerrada na hora.',
        async () => {
          const resAdmin = await window.api.contasLogin.definirAdmin(contaId, tornar);
          if (!resAdmin.ok) {
            toast(resAdmin.erro, 'erro');
            return;
          }
          await renderContasLogin();
          toast(tornar ? `"${usuario}" agora é Admin.` : `"${usuario}" voltou a ser Default.`);
        }
      );
    });
  });
  qsa('[data-conta-login-excluir]', tabela).forEach((btn) => {
    btn.addEventListener('click', () => {
      const contaId = btn.dataset.contaLoginExcluir;
      const tr = btn.closest('tr');
      const usuario = qs('[data-conta-nome]', tr)?.textContent || '';
      abrirConfirm(
        'Excluir conta de login',
        `Excluir a conta de login "${usuario}"? Essa pessoa não vai mais conseguir entrar no app até ` +
          'que uma nova conta seja criada pra ela. Essa ação não pode ser desfeita.',
        async () => {
          const resExcluir = await window.api.contasLogin.excluir(contaId);
          if (!resExcluir.ok) {
            toast(resExcluir.erro, 'erro');
            return;
          }
          await renderContasLogin();
          toast('Conta de login excluída.');
        }
      );
    });
  });
}

function abrirModalResetarSenhaConta(contaId, usuario) {
  contaLoginParaResetarId = contaId;
  qs('#resetar-senha-conta-usuario').textContent = usuario;
  qs('#resetar-senha-conta-nova').value = '';
  qs('#resetar-senha-conta-erro').classList.add('hidden');
  qs('#modal-resetar-senha-conta').classList.remove('hidden');
  qs('#resetar-senha-conta-nova').focus();
}

function fecharModalResetarSenhaConta() {
  qs('#modal-resetar-senha-conta').classList.add('hidden');
  contaLoginParaResetarId = null;
}

function configurarContasLogin() {
  const btnCriar = qs('#btn-conta-login-criar');
  if (!btnCriar) return;

  btnCriar.addEventListener('click', async () => {
    const erroEl = qs('#conta-login-criar-erro');
    erroEl.classList.add('hidden');
    const usuario = qs('#conta-login-usuario').value.trim();
    const senha = qs('#conta-login-senha').value;
    const chkAdmin = qs('#conta-login-admin');
    const comoAdmin = !!(chkAdmin && chkAdmin.checked);

    const criar = async () => {
      const res = await window.api.contasLogin.criar(usuario, senha, comoAdmin);
      if (!res.ok) {
        mostrarErroInline(erroEl, res.erro);
        return;
      }
      qs('#conta-login-usuario').value = '';
      qs('#conta-login-senha').value = '';
      if (chkAdmin) chkAdmin.checked = false;
      await renderContasLogin();
      toast(
        `Conta ${comoAdmin ? 'de Admin ' : ''}criada para "${res.conta.usuario}" — a senha é temporária, ` +
          'ela vai trocar no primeiro acesso.'
      );
    };
    if (!comoAdmin) return criar();
    abrirConfirm(
      'Criar conta de Admin',
      `A conta "${usuario}" vai ter EXATAMENTE os mesmos poderes que você (inclusive criar, excluir e ` +
        'promover outras contas e importar backup). Só faça isso com alguém de total confiança. Continuar?',
      criar
    );
  });
  [qs('#conta-login-usuario'), qs('#conta-login-senha')].forEach((input) => {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') btnCriar.click();
    });
  });

  qs('#resetar-senha-conta-cancelar').addEventListener('click', fecharModalResetarSenhaConta);
  qs('#resetar-senha-conta-confirmar').addEventListener('click', async () => {
    const erroEl = qs('#resetar-senha-conta-erro');
    erroEl.classList.add('hidden');
    if (!contaLoginParaResetarId) return;
    const novaSenha = qs('#resetar-senha-conta-nova').value;
    const res = await window.api.contasLogin.resetarSenha(contaLoginParaResetarId, novaSenha);
    if (!res.ok) {
      mostrarErroInline(erroEl, res.erro);
      return;
    }
    fecharModalResetarSenhaConta();
    await renderContasLogin();
    toast('Senha resetada — a pessoa vai precisar trocar por uma nova no próximo acesso.');
  });
}

// ---------------------------------------------------------------------------
// Backup (exportar/importar catálogo, usuários e histórico)
// ---------------------------------------------------------------------------

function configurarBackup() {
  qs('#btn-backup-exportar').addEventListener('click', async () => {
    const senha = qs('#backup-exportar-senha').value;
    if (!senha || senha.length < 6) {
      toast('Informe uma senha de proteção do backup (mínimo 6 caracteres — letras, números e símbolos são permitidos).', 'erro');
      return;
    }
    // try/catch aqui garante que QUALQUER problema (inclusive uma falha de comunicação com o
    // processo principal) sempre vira um toast visível — nunca um clique que aparenta não fazer
    // nada (ver o try/catch equivalente em main.js, no handler `backup:exportar`).
    try {
      const res = await window.api.backup.exportar(senha);
      if (res.cancelado) {
        toast('Exportação cancelada — nenhum arquivo foi salvo.');
        return;
      }
      if (!res.ok) {
        toast(res.erro, 'erro');
        return;
      }
      qs('#backup-exportar-senha').value = '';
      toast(
        `Backup salvo: ${res.totalItens} item(ns), ${res.totalUsuarios} usuário(s), ${res.totalMovimentacoes} ` +
          `movimentação(ões), ${res.totalContasLogin} conta(s) de login.`
      );
    } catch (erro) {
      toast('Não foi possível exportar o backup: ' + (erro && erro.message ? erro.message : erro), 'erro');
    }
  });

  qsa('input[name="modo-importar"]').forEach((radio) => {
    radio.addEventListener('change', atualizarAvisoImportar);
  });
  atualizarAvisoImportar();

  qs('#btn-backup-importar').addEventListener('click', () => {
    const senha = qs('#backup-importar-senha').value;
    if (!senha) {
      toast('Informe a senha usada ao exportar o backup.', 'erro');
      return;
    }
    const modo = qs('input[name="modo-importar"]:checked').value;
    const titulo = modo === 'mesclar' ? 'Mesclar backup' : 'Substituir tudo pelo backup';
    const mensagem =
      modo === 'mesclar'
        ? 'Isso vai ADICIONAR os usuários e o histórico do arquivo aos que já existem aqui. Itens já ' +
          'cadastrados não têm a quantidade aumentada (só mantida ou reduzida); itens novos entram com a ' +
          'quantidade do arquivo. Deseja continuar?'
        : 'Isso vai SUBSTITUIR todo o catálogo, usuários e histórico atuais pelos dados do arquivo escolhido. ' +
          'O login de Admin desta máquina também deixa de valer (o arquivo de backup nunca traz um Admin) — ' +
          'só as contas de login trazidas pelo arquivo vão conseguir entrar depois. Essa ação não pode ser ' +
          'desfeita. Deseja continuar?';

    abrirConfirm(titulo, mensagem, async () => {
      // Mesma ideia do try/catch em "Exportar" acima: qualquer erro aqui sempre vira um toast
      // visível, nunca um clique que aparenta não fazer nada.
      try {
        const res = await window.api.backup.importar(senha, modo);
        if (res.cancelado) {
          toast('Importação cancelada — nenhum dado foi alterado.');
          return;
        }
        if (!res.ok) {
          toast(res.erro, 'erro');
          return;
        }
        qs('#backup-importar-senha').value = '';

        if (modo === 'mesclar' && res.resumo) {
          const houveColisaoAdmin = res.resumo.contasLoginIgnoradasColisaoAdmin > 0;
          toast(
            `Mesclado: ${res.resumo.itensNovos} item(ns) novo(s), ${res.resumo.itensAtualizados} item(ns) com ` +
              `quantidade ajustada, ${res.resumo.usuariosNovos} usuário(s) novo(s), ${res.resumo.transacoesImportadas} ` +
              `movimentação(ões) nova(s), ${res.resumo.contasLoginNovas} conta(s) de login nova(s)` +
              (res.resumo.transacoesRepetidas ? ` (${res.resumo.transacoesRepetidas} movimentação(ões) já existiam)` : '') +
              '.' +
              (houveColisaoAdmin
                ? ` Atenção: ${res.resumo.contasLoginIgnoradasColisaoAdmin} conta(s) de login do arquivo ` +
                  'foram ignoradas por ter o mesmo usuário do Admin desta máquina — ninguém consegue logar ' +
                  'com elas assim. Troque o usuário do Admin ou renomeie essas contas na origem e importe de novo.'
                : ''),
            houveColisaoAdmin ? 'erro' : undefined
          );
        } else {
          toast(
            'Backup importado com sucesso (substituiu os dados atuais). O login de Admin desta máquina deixou ' +
              'de valer — a partir de agora, só entram as contas de login que vieram no arquivo.'
          );
        }

        // Qualquer importação (total ou mesclada) pode trazer contas de login diferentes das que
        // valiam até agora — o processo principal já derrubou a sessão atual (ver backup:importar
        // em main.js), então a interface some pro mesmo lugar: a tela de login (ou, no caso de uma
        // importação TOTAL, a tela de criação de um novo Admin — ver voltarParaTelaDeLogin), já
        // enxergando as contas que vieram no arquivo.
        limparResultadoConsultar();
        await voltarParaTelaDeLogin();
      } catch (erro) {
        toast('Não foi possível importar o backup: ' + (erro && erro.message ? erro.message : erro), 'erro');
      }
    });
  });
}

function atualizarAvisoImportar() {
  const modo = qs('input[name="modo-importar"]:checked')?.value;
  const aviso = qs('#backup-importar-aviso');
  if (modo === 'mesclar') {
    aviso.classList.remove('erro-forte');
    aviso.innerHTML =
      'Ao <strong>mesclar</strong>, usuários e histórico do arquivo são adicionados aos que já existem; a ' +
      'quantidade de um item já cadastrado nunca aumenta — é sempre subtraída (pode até ficar negativa).';
  } else {
    aviso.classList.add('erro-forte');
    aviso.innerHTML =
      'Atenção: <strong>substituir tudo</strong> apaga o catálogo, usuários e histórico atuais e não pode ' +
      'ser desfeito. O login de Admin desta máquina também deixa de valer — depois da importação, só as ' +
      'contas de login trazidas pelo arquivo conseguem entrar.';
  }
}

// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', init);
