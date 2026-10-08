'use strict';

/**
 * Tabela de "canais" do app (login, catálogo, usuários, histórico, pendências, relatórios,
 * backup…) — a MESMA para o app desktop (Electron, via IPC — ver main.js) e para a versão web
 * (via HTTP — ver web/server.js). Cada canal recebe a sessão de quem está chamando e os mesmos
 * argumentos que a interface manda (ver preload.js / web/public/api-web.js), aplica as regras de
 * permissão por perfil e chama as regras de negócio puras de src/logic.js.
 *
 * O que muda entre desktop e web fica todo em `plataforma` (ver `criarHandlers`): onde os dados
 * são guardados, como um relatório vira PDF, como o arquivo de backup é salvo/lido, e quem pode
 * recriar o Admin. Assim uma regra nova entra uma vez só e vale nos dois.
 */

const logic = require('./logic');
const cryptoUtils = require('./crypto-utils');
const rel = require('./relatorios-html');

const FORMATO_ARQUIVO_BACKUP = 'controle-estoque-backup-arquivo';

/**
 * Canais que funcionam mesmo sem ninguém autenticado — literalmente os que a tela de login (ou a
 * de primeiro acesso) precisa antes de existir qualquer sessão. Todos os outros são recusados
 * enquanto `sessao.perfil` for `null` (ver `executar`).
 */
const CANAIS_SEM_SESSAO = new Set([
  'auth:getPerfil',
  'auth:quemSou',
  'auth:precisaConfigurarLogin',
  'auth:configurarLoginInicial',
  'auth:login',
  'auth:trocarSenhaPrimeiroAcesso',
]);

/**
 * Estado de uma sessão de login. No desktop existe uma só (o app inteiro); na web, uma por
 * navegador conectado.
 *  - `perfil`: null (ninguém logado) | 'default' | 'admin'
 *  - `contaLoginId`: conta de login do Default que é a identidade-base da sessão (null quando
 *    alguém entrou direto como Admin) — é pra onde "Sair do modo Admin" volta.
 *  - `pendenteTrocaSenhaContaId`: conta que acabou de autenticar com a senha temporária mas ainda
 *    não trocou — só nesse estado `auth:trocarSenhaPrimeiroAcesso` aceita a troca.
 *  - `pilhaDesfazer`: movimentações do Default nesta sessão que ainda podem ser desfeitas.
 *  - `adminContaId`: quando o modo Admin veio de uma CONTA com acesso de Admin (e não do Admin
 *    principal), qual conta foi — é o "nome" do Admin na tela, e se essa conta perder o acesso de
 *    Admin (ou for excluída) a sessão deixa de valer.
 */
function novaSessao() {
  return { perfil: null, contaLoginId: null, adminContaId: null, pendenteTrocaSenhaContaId: null, pilhaDesfazer: [] };
}

function limparSessao(sessao) {
  sessao.perfil = null;
  sessao.contaLoginId = null;
  sessao.adminContaId = null;
  sessao.pendenteTrocaSenhaContaId = null;
  sessao.pilhaDesfazer.length = 0;
}

function ehAdmin(sessao) {
  return sessao.perfil === 'admin';
}

/**
 * @param {object} plataforma
 * @param {() => object|Promise<object>} plataforma.carregar  devolve os dados atuais
 * @param {(data: object) => void|Promise<void>} plataforma.persistir  grava os dados novos
 * @param {(html: string, opcoes: {titulo: string, nomeArquivo: string}) => Promise<object>} plataforma.salvarPdf
 *   transforma o HTML do relatório em PDF — `{ ok: true, ... }`, `{ ok: false, cancelado: true }`
 *   ou `{ ok: false, erro }`
 * @param {(conteudo: string, opcoes: {nomeArquivo: string}) => Promise<object>} plataforma.salvarBackup
 * @param {(args: object) => Promise<object>} plataforma.lerBackup  `{ ok: true, conteudo }` ou erro/cancelado
 * @param {(data: object, args: object) => (boolean|string)} plataforma.podeConfigurarAdmin
 *   se o login do Admin pode ser criado agora — `true`, `false`, ou um texto explicando por que não
 * @param {(data: object, args: object) => boolean} [plataforma.mostrarTelaConfigurarAdmin]
 *   se a tela de "criar login de Admin" deve aparecer (padrão: igual a `podeConfigurarAdmin`)
 * @param {(pacote: object) => Promise<object>} [plataforma.prepararPacoteExportacao]
 *   ajuste final do pacote de backup antes de criptografar (a web embute as fotos de volta)
 */
function criarHandlers(plataforma) {
  const carregar = async () => plataforma.carregar();
  const persistir = async (data) => plataforma.persistir(data);
  const h = Object.create(null);

  /** Atalho pros canais que só aplicam uma regra de logic.js e gravam se deu certo. */
  async function aplicar(fnLogica, ...args) {
    const res = fnLogica(await carregar(), ...args);
    if (res.ok) await persistir(res.data);
    return res;
  }

  // ---------------------------------------------------------------------------
  // Autenticação / perfil
  // ---------------------------------------------------------------------------

  h['auth:getPerfil'] = async (sessao) => sessao.perfil;

  /**
   * Quem está logado nesta sessão, só pra exibir na tela (ex.: depois de recarregar a página na
   * web): `usuario` = conta do Default por baixo; `usuarioAdmin` = conta com acesso de Admin que
   * está no modo Admin agora (null pro Admin principal).
   */
  h['auth:quemSou'] = async (sessao) => {
    if (!sessao.perfil) return { perfil: null, usuario: null, usuarioAdmin: null };
    const contas = (await carregar()).contasLogin || [];
    const nome = (id) => (id ? (contas.find((c) => c.id === id) || {}).usuario || null : null);
    return {
      perfil: sessao.perfil,
      usuario: nome(sessao.contaLoginId),
      usuarioAdmin: sessao.perfil === 'admin' ? nome(sessao.adminContaId) : null,
    };
  };

  /**
   * Se a tela de "criar login de Admin" deve aparecer — no desktop, só na primeira execução DE
   * VERDADE (uma importação total zera o Admin mas NÃO reabre essa tela, senão qualquer pessoa
   * viraria Admin só de importar um arquivo); na web, também quando o dono do servidor abre o
   * link de configuração com o token secreto (ver web/server.js).
   */
  h['auth:precisaConfigurarLogin'] = async (sessao, opcoes = {}) => {
    const mostrar = plataforma.mostrarTelaConfigurarAdmin || plataforma.podeConfigurarAdmin;
    return mostrar(await carregar(), opcoes || {}) === true;
  };

  /** Cria o login do Admin (só quando a plataforma permite) e já entra com ele. */
  h['auth:configurarLoginInicial'] = async (sessao, { usuario, senha, tokenConfiguracao } = {}) => {
    const data = await carregar();
    const permitido = plataforma.podeConfigurarAdmin(data, { tokenConfiguracao });
    if (permitido !== true) {
      return {
        ok: false,
        erro: typeof permitido === 'string' ? permitido : 'O login do Admin já foi configurado nesta instalação.',
        perfil: sessao.perfil,
      };
    }
    const res = logic.configurarLoginInicial(data, { usuario, senha }, { permitirRecriar: true });
    if (res.ok) {
      await persistir(res.data);
      limparSessao(sessao);
      sessao.perfil = 'admin';
    }
    return { ok: res.ok, erro: res.erro, perfil: sessao.perfil };
  };

  /**
   * A tela de login única: Admin OU conta de login do Default. Conta com senha temporária ainda
   * não libera acesso — fica pendente até `auth:trocarSenhaPrimeiroAcesso`.
   */
  h['auth:login'] = async (sessao, { usuario, senha } = {}) => {
    const res = logic.verificarLogin(await carregar(), usuario, senha);
    if (!res.ok) return { ok: false, erro: res.erro };
    limparSessao(sessao);

    if (res.tipo === 'admin') {
      sessao.perfil = 'admin';
      return { ok: true, perfil: 'admin' };
    }
    if (res.precisaTrocarSenha) {
      sessao.pendenteTrocaSenhaContaId = res.contaId;
      return { ok: true, perfil: null, precisaTrocarSenha: true, contaId: res.contaId, usuario: res.usuario };
    }
    sessao.contaLoginId = res.contaId;
    if (res.admin) {
      // Conta com acesso de Admin: entra direto como Admin, com o próprio nome.
      sessao.perfil = 'admin';
      sessao.adminContaId = res.contaId;
      return { ok: true, perfil: 'admin', usuario: res.usuario, usuarioAdmin: res.usuario };
    }
    sessao.perfil = 'default';
    return { ok: true, perfil: 'default', usuario: res.usuario };
  };

  /** Completa o login de uma conta com senha temporária — só a conta que ACABOU de autenticar. */
  h['auth:trocarSenhaPrimeiroAcesso'] = async (sessao, { contaId, senhaAtual, novaSenha } = {}) => {
    if (!sessao.pendenteTrocaSenhaContaId || sessao.pendenteTrocaSenhaContaId !== contaId) {
      return { ok: false, erro: 'Sessão de troca de senha inválida — feche e faça login novamente.' };
    }
    const res = logic.trocarSenhaContaLogin(await carregar(), contaId, { senhaAtual, novaSenha });
    if (!res.ok) return res;
    await persistir(res.data);
    const conta = (res.data.contasLogin || []).find((c) => c.id === contaId);
    const ehContaAdmin = !!(conta && conta.admin);
    sessao.perfil = ehContaAdmin ? 'admin' : 'default';
    sessao.contaLoginId = contaId;
    sessao.adminContaId = ehContaAdmin ? contaId : null;
    sessao.pendenteTrocaSenhaContaId = null;
    return { ok: true, perfil: sessao.perfil, usuarioAdmin: ehContaAdmin ? conta.usuario : null };
  };

  /**
   * Escalada temporária pra Admin dentro de uma sessão do Default ("Entrar como Admin"): aceita o
   * login do Admin principal OU de qualquer conta com acesso de Admin.
   */
  h['auth:loginAdmin'] = async (sessao, { usuario, senha } = {}) => {
    const data = await carregar();
    if (logic.verificarLoginAdmin(data, usuario, senha)) {
      sessao.perfil = 'admin';
      sessao.adminContaId = null;
      return { ok: true, perfil: sessao.perfil, usuarioAdmin: null };
    }
    const res = logic.verificarLogin(data, usuario, senha);
    if (res.ok && res.tipo === 'default' && res.admin) {
      if (res.precisaTrocarSenha) {
        return { ok: false, erro: 'Essa conta ainda está com a senha temporária — entre com ela pela tela de login primeiro.' };
      }
      sessao.perfil = 'admin';
      sessao.adminContaId = res.contaId;
      return { ok: true, perfil: sessao.perfil, usuarioAdmin: res.usuario };
    }
    return { ok: false, erro: 'Usuário ou senha inválidos.' };
  };

  /** "Sair do modo Admin": volta pra conta do Default por baixo, ou desloga se não houver. */
  h['auth:logoutAdmin'] = async (sessao) => {
    sessao.perfil = sessao.contaLoginId ? 'default' : null;
    sessao.adminContaId = null;
    return { ok: true, perfil: sessao.perfil };
  };

  /** "Sair": desloga de vez e esvazia a pilha de desfazer desta sessão. */
  h['auth:logout'] = async (sessao) => {
    limparSessao(sessao);
    return { ok: true, perfil: null };
  };

  h['auth:redefinirLoginAdmin'] = async (sessao, { senhaAtual, novoUsuario, novaSenha } = {}) => {
    if (!ehAdmin(sessao)) return { ok: false, erro: 'Somente o admin pode trocar o próprio login.' };
    if (sessao.adminContaId) {
      return {
        ok: false,
        erro: 'Esse botão troca o login do Admin principal. Pra trocar a sua senha, peça a outro Admin ' +
          'pra usar "Resetar senha" na sua conta (aba Contas de login).',
      };
    }
    return aplicar(logic.redefinirLoginAdmin, { senhaAtual, novoUsuario, novaSenha });
  };

  // ---------------------------------------------------------------------------
  // Gerenciador de login (contas do Default — exclusivo do Admin)
  // ---------------------------------------------------------------------------

  h['contasLogin:listar'] = async (sessao) => {
    if (!ehAdmin(sessao)) return { ok: false, erro: 'Somente o admin pode ver as contas de login.' };
    const contas = logic.listarContasLogin(await carregar()).map((c) => ({
      ...c,
      ehVoce: c.id === sessao.contaLoginId || c.id === sessao.adminContaId,
    }));
    return { ok: true, contas };
  };

  h['contasLogin:criar'] = async (sessao, { usuario, senha, admin } = {}) => {
    if (!ehAdmin(sessao)) return { ok: false, erro: 'Somente o admin pode criar contas de login.' };
    return aplicar(logic.criarContaLogin, { usuario, senha, admin: admin === true });
  };

  /** Dá ou tira o acesso de Admin de uma conta (exclusivo do Admin; ninguém tira o próprio acesso). */
  h['contasLogin:definirAdmin'] = async (sessao, { contaId, admin } = {}) => {
    if (!ehAdmin(sessao)) return { ok: false, erro: 'Somente o admin pode dar ou tirar o acesso de Admin.' };
    if (admin !== true && (contaId === sessao.adminContaId || contaId === sessao.contaLoginId)) {
      return { ok: false, erro: 'Você não pode tirar o seu próprio acesso de Admin — peça a outro Admin.' };
    }
    return aplicar(logic.definirAdminContaLogin, contaId, admin === true);
  };

  h['contasLogin:excluir'] = async (sessao, contaId) => {
    if (!ehAdmin(sessao)) return { ok: false, erro: 'Somente o admin pode excluir uma conta de login.' };
    if (contaId === sessao.adminContaId || contaId === sessao.contaLoginId) {
      return { ok: false, erro: 'Você não pode excluir a conta com que está logado agora.' };
    }
    return aplicar(logic.excluirContaLogin, contaId);
  };

  h['contasLogin:resetarSenha'] = async (sessao, { contaId, novaSenha } = {}) => {
    if (!ehAdmin(sessao)) return { ok: false, erro: 'Somente o admin pode redefinir a senha de uma conta.' };
    return aplicar(logic.resetarSenhaContaLogin, contaId, novaSenha);
  };

  // ---------------------------------------------------------------------------
  // Itens do catálogo
  // ---------------------------------------------------------------------------

  h['items:list'] = async () => logic.listarItens(await carregar());

  h['items:add'] = async (sessao, params) => {
    if (!ehAdmin(sessao)) return { ok: false, erro: 'Somente o admin pode adicionar itens ao catálogo.' };
    return aplicar(logic.adicionarItem, params || {});
  };

  h['items:edit'] = async (sessao, { itemId, ...params } = {}) => {
    if (!ehAdmin(sessao)) return { ok: false, erro: 'Somente o admin pode editar itens do catálogo.' };
    return aplicar(logic.editarItem, itemId, params);
  };

  h['items:remove'] = async (sessao, itemId) => {
    if (!ehAdmin(sessao)) return { ok: false, erro: 'Somente o admin pode remover itens do catálogo.' };
    return aplicar(logic.removerItem, itemId);
  };

  h['items:definirPreco'] = async (sessao, { itemId, preco } = {}) => {
    if (!ehAdmin(sessao)) {
      return { ok: false, erro: 'Somente o admin pode definir o valor de um item (aba Precificação).' };
    }
    return aplicar(logic.definirPrecoItem, itemId, preco);
  };

  h['items:adjust'] = async (sessao, params) => {
    const res = await aplicar(logic.ajustarQuantidade, { ...(params || {}), perfil: sessao.perfil });
    // Só o Default usa a pilha de "desfazer" (ele não pode fazer entrada, então toda movimentação
    // dele nesta sessão é uma saída candidata a ser desfeita).
    if (res.ok && sessao.perfil !== 'admin' && res.transacao && res.transacao.tipo === 'saida') {
      sessao.pilhaDesfazer.push(res.transacao.id);
    }
    return res;
  };

  // ---------------------------------------------------------------------------
  // Usuários (pessoas para quem a quantidade é destinada)
  // ---------------------------------------------------------------------------

  h['usuarios:list'] = async () => logic.listarUsuarios(await carregar());
  h['usuarios:add'] = async (sessao, params) => aplicar(logic.adicionarUsuario, params || {});
  h['usuarios:remove'] = async (sessao, usuarioId) => aplicar(logic.removerUsuario, usuarioId);
  h['usuarios:editar'] = async (sessao, { usuarioId, ...params } = {}) => aplicar(logic.editarUsuario, usuarioId, params);

  h['usuarios:definirBloqueio'] = async (sessao, { usuarioId, bloqueado } = {}) => {
    if (!ehAdmin(sessao)) return { ok: false, erro: 'Somente o admin pode bloquear/desbloquear um usuário.' };
    return aplicar(logic.definirBloqueioUsuario, usuarioId, bloqueado);
  };

  h['usuarios:favoritar'] = async (sessao, usuarioId, favorito) => aplicar(logic.favoritarUsuario, usuarioId, favorito);

  h['usuarios:excluirTodos'] = async (sessao) => {
    if (!ehAdmin(sessao)) return { ok: false, erro: 'Somente o admin pode excluir todos os usuários de uma vez.' };
    return aplicar(logic.excluirTodosUsuarios);
  };

  // ---------------------------------------------------------------------------
  // Lançamentos avulsos e pagamentos
  // ---------------------------------------------------------------------------

  h['lancamentos:adicionar'] = async (sessao, params) =>
    aplicar(logic.adicionarLancamento, { ...(params || {}), perfil: sessao.perfil });

  h['lancamentos:listarPorUsuario'] = async (sessao, usuarioId) =>
    logic.listarLancamentosPorUsuario(await carregar(), usuarioId);

  h['lancamentos:definirPendente'] = async (sessao, { lancamentoId, pendente } = {}) => {
    if (!ehAdmin(sessao)) return { ok: false, erro: 'Somente o admin pode alterar o status de um lançamento avulso.' };
    return aplicar(logic.definirPendenteLancamento, lancamentoId, pendente);
  };

  h['lancamentos:marcarRecebidoDefault'] = async (sessao, { lancamentoId, marcado } = {}) => {
    if (ehAdmin(sessao)) {
      return { ok: false, erro: 'O Admin confirma a pendência de verdade pelo botão de status, não por aqui.' };
    }
    return aplicar(logic.marcarRecebidoDefaultLancamento, lancamentoId, marcado);
  };

  h['lancamentos:editar'] = async (sessao, { lancamentoId, valor, observacao } = {}) =>
    aplicar(logic.editarLancamento, lancamentoId, { valor, observacao });

  h['lancamentos:remover'] = async (sessao, lancamentoId) => {
    if (!ehAdmin(sessao)) return { ok: false, erro: 'Somente o admin pode excluir um lançamento avulso.' };
    return aplicar(logic.removerLancamento, lancamentoId);
  };

  h['pagamentos:adicionar'] = async (sessao, params) =>
    aplicar(logic.adicionarPagamento, { ...(params || {}), perfil: sessao.perfil });

  h['pagamentos:listarPorUsuario'] = async (sessao, usuarioId) =>
    logic.listarPagamentosPorUsuario(await carregar(), usuarioId);

  h['pagamentos:editar'] = async (sessao, { pagamentoId, valor, observacao } = {}) =>
    aplicar(logic.editarPagamento, pagamentoId, { valor, observacao });

  h['pagamentos:remover'] = async (sessao, pagamentoId) => {
    if (!ehAdmin(sessao)) return { ok: false, erro: 'Somente o admin pode excluir um pagamento.' };
    return aplicar(logic.removerPagamento, pagamentoId);
  };

  // ---------------------------------------------------------------------------
  // Pendências (leitura para os dois perfis)
  // ---------------------------------------------------------------------------

  h['pendencias:listarUsuarios'] = async () => logic.listarUsuariosPendentes(await carregar());
  h['pendencias:detalharUsuario'] = async (sessao, usuarioId) => logic.detalharPendenciasUsuario(await carregar(), usuarioId);
  h['pendencias:listarQuitados'] = async () => logic.listarUsuariosQuitados(await carregar());
  h['pendencias:totalizar'] = async () => logic.totalizarPendencias(await carregar());

  h['pendencias:quitarUsuario'] = async (sessao, { usuarioId, comentario } = {}) => {
    if (!ehAdmin(sessao)) return { ok: false, erro: 'Somente o admin pode marcar uma pendência como paga.' };
    return aplicar(logic.quitarPendenciaUsuario, usuarioId, comentario);
  };

  // ---------------------------------------------------------------------------
  // Histórico
  // ---------------------------------------------------------------------------

  h['historico:listDias'] = async () => logic.listarDiasComMovimentacao(await carregar());
  h['historico:listPorDia'] = async (sessao, dia) => logic.listarTransacoesPorDia(await carregar(), dia);
  h['historico:listLancamentosEPagamentosPorDia'] = async (sessao, dia) =>
    logic.listarLancamentosEPagamentosPorDia(await carregar(), dia);
  h['historico:listarPeriodo'] = async (sessao, { dataInicio, dataFim } = {}) =>
    logic.listarHistoricoPorPeriodo(await carregar(), dataInicio || null, dataFim || null);
  h['historico:listarLancamentosEPagamentosPeriodo'] = async (sessao, { dataInicio, dataFim } = {}) =>
    logic.listarLancamentosEPagamentosPorPeriodo(await carregar(), dataInicio || null, dataFim || null);

  h['historico:excluirTodosLancamentosEPagamentos'] = async (sessao) => {
    if (!ehAdmin(sessao)) return { ok: false, erro: 'Somente o admin pode excluir os lançamentos e pagamentos.' };
    return aplicar(logic.excluirTodosLancamentosEPagamentos);
  };

  h['historico:excluirTudo'] = async (sessao) => {
    if (!ehAdmin(sessao)) return { ok: false, erro: 'Somente o admin pode excluir o histórico.' };
    return aplicar(logic.excluirTodoHistorico);
  };

  h['historico:excluirSelecionados'] = async (sessao, idsTransacoes) => {
    if (!ehAdmin(sessao)) return { ok: false, erro: 'Somente o admin pode excluir movimentações do histórico.' };
    return aplicar(logic.excluirTransacoes, Array.isArray(idsTransacoes) ? idsTransacoes : []);
  };

  /** Se há uma movimentação do Default pra desfazer nesta sessão (e qual é). */
  h['historico:desfazerInfo'] = async (sessao) => {
    const dados = await carregar();
    // Descarta do topo da pilha qualquer id que já não existe mais (ex.: o Admin excluiu).
    while (sessao.pilhaDesfazer.length > 0) {
      const id = sessao.pilhaDesfazer[sessao.pilhaDesfazer.length - 1];
      const transacao = dados.transacoes.find((t) => t.id === id);
      if (transacao) return { disponivel: true, transacao };
      sessao.pilhaDesfazer.pop();
    }
    return { disponivel: false, transacao: null };
  };

  h['historico:desfazerUltima'] = async (sessao) => {
    while (sessao.pilhaDesfazer.length > 0) {
      const id = sessao.pilhaDesfazer.pop();
      const res = logic.desfazerTransacao(await carregar(), id);
      if (res.ok) {
        await persistir(res.data);
        return res;
      }
    }
    return { ok: false, erro: 'Não há nenhuma movimentação para desfazer nesta sessão.' };
  };

  h['historico:definirPendente'] = async (sessao, { transacaoId, pendente } = {}) => {
    if (!ehAdmin(sessao)) {
      return { ok: false, erro: 'Somente o admin pode alterar o status de pendência de uma movimentação.' };
    }
    return aplicar(logic.definirPendenteTransacao, transacaoId, pendente);
  };

  h['historico:marcarRecebidoDefault'] = async (sessao, { transacaoId, marcado } = {}) => {
    if (ehAdmin(sessao)) {
      return { ok: false, erro: 'O Admin confirma a pendência de verdade pelo botão de status, não por aqui.' };
    }
    return aplicar(logic.marcarRecebidoDefaultTransacao, transacaoId, marcado);
  };

  // ---------------------------------------------------------------------------
  // Relatórios (o HTML é o mesmo nos dois; o "virar PDF" é da plataforma)
  // ---------------------------------------------------------------------------

  h['relatorio:gerarPdfPedidos'] = async (sessao, { dataInicio, dataFim } = {}) => {
    const relatorio = logic.listarPedidosParaRelatorio(await carregar(), dataInicio || null, dataFim || null);
    const nomeArquivo =
      dataInicio && dataFim && dataInicio === dataFim
        ? `pedidos-${dataInicio}.pdf`
        : `pedidos-${dataInicio || 'inicio'}-a-${dataFim || 'fim'}.pdf`;
    const res = await plataforma.salvarPdf(rel.montarHtmlRelatorioPedidos(relatorio), {
      titulo: 'Salvar relatório de pedidos (PDF)',
      nomeArquivo,
    });
    if (!res.ok) return res;
    return { ...res, totalPedidos: relatorio.pedidos.length, totalValor: relatorio.totalValor };
  };

  h['relatorio:gerarPdfQuantidades'] = async () => {
    const relatorio = logic.listarQuantidadesAtuaisParaRelatorio(await carregar());
    const res = await plataforma.salvarPdf(rel.montarHtmlRelatorioQuantidades(relatorio), {
      titulo: 'Salvar relatório de quantidades (PDF)',
      nomeArquivo: `quantidades-catalogo-${logic.hojeISO()}.pdf`,
    });
    if (!res.ok) return res;
    return { ...res, totalItens: relatorio.totalItens, totalQuantidade: relatorio.totalQuantidade };
  };

  h['relatorio:gerarPdfPendenciaUsuario'] = async (sessao, { usuarioId } = {}) => {
    const detalhe = logic.detalharPendenciasUsuario(await carregar(), usuarioId);
    if (!detalhe.usuarioNome) return { ok: false, erro: 'Usuário não encontrado.' };
    const res = await plataforma.salvarPdf(rel.montarHtmlRelatorioPendenciaUsuario(detalhe), {
      titulo: 'Salvar pendência do usuário (PDF)',
      nomeArquivo: `pendencia-${rel.slugParaArquivo(detalhe.usuarioNome)}-${logic.hojeISO()}.pdf`,
    });
    if (!res.ok) return res;
    return { ...res, totalPendente: detalhe.totalPendente };
  };

  h['relatorio:gerarPdfConsulta'] = async (sessao, { modo, usuarioId, itemId, dataInicio, dataFim } = {}) => {
    const data = await carregar();
    const periodoTexto = rel.formatarPeriodoTexto(dataInicio || null, dataFim || null);

    if (modo === 'item') {
      if (!itemId) return { ok: false, erro: 'Escolha um item para consultar.' };
      const resultado = logic.consultarPorItem(data, itemId, dataInicio || null, dataFim || null);
      const res = await plataforma.salvarPdf(rel.montarHtmlRelatorioConsultaItem(resultado, periodoTexto), {
        titulo: 'Salvar consulta em PDF',
        nomeArquivo: `consulta-${rel.slugParaArquivo(resultado.itemNome)}-${logic.hojeISO()}.pdf`,
      });
      if (!res.ok) return res;
      return { ...res, totalMovimentacoes: resultado.transacoes.length };
    }

    if (!usuarioId) return { ok: false, erro: 'Escolha um usuário para consultar.' };
    const usuarioCadastro = data.usuarios.find((u) => u.id === usuarioId);
    if (!usuarioCadastro) return { ok: false, erro: 'Usuário não encontrado.' };
    const resultado = logic.consultarPorUsuario(data, usuarioId, dataInicio || null, dataFim || null);
    const usuario = { nome: logic.rotuloUsuario(usuarioCadastro), telefone: usuarioCadastro.telefone };
    const res = await plataforma.salvarPdf(rel.montarHtmlRelatorioConsultaUsuario(resultado, usuario, periodoTexto), {
      titulo: 'Salvar consulta em PDF',
      nomeArquivo: `consulta-${rel.slugParaArquivo(usuario.nome)}-${logic.hojeISO()}.pdf`,
    });
    if (!res.ok) return res;
    return { ...res, totalMovimentacoes: resultado.transacoes.length };
  };

  // ---------------------------------------------------------------------------
  // Precificação e consulta
  // ---------------------------------------------------------------------------

  h['precificacao:listar'] = async () => logic.listarPrecificacao(await carregar());
  h['consulta:porUsuario'] = async (sessao, { usuarioId, dataInicio, dataFim } = {}) =>
    logic.consultarPorUsuario(await carregar(), usuarioId, dataInicio || null, dataFim || null);
  h['consulta:porItem'] = async (sessao, { itemId, dataInicio, dataFim } = {}) =>
    logic.consultarPorItem(await carregar(), itemId, dataInicio || null, dataFim || null);

  // ---------------------------------------------------------------------------
  // Backup — o arquivo é o mesmo no desktop e na web (dá pra levar de um pro outro).
  // O login do ADMIN nunca entra no backup; as contas de login do Default entram.
  // ---------------------------------------------------------------------------

  h['backup:exportar'] = async (sessao, { senha } = {}) => {
    if (!senha || String(senha).length < 6) {
      return {
        ok: false,
        erro: 'Informe uma senha de proteção do backup (mínimo 6 caracteres — letras, números e símbolos são permitidos).',
      };
    }
    try {
      let pacote = logic.montarPacoteExportacao(await carregar());
      if (plataforma.prepararPacoteExportacao) pacote = await plataforma.prepararPacoteExportacao(pacote);
      const salt = cryptoUtils.gerarSalt();
      const chave = cryptoUtils.derivarChaveDeSenha(senha, salt);
      const payload = cryptoUtils.criptografarJSON(pacote, chave);
      const conteudo = JSON.stringify({ formato: FORMATO_ARQUIVO_BACKUP, versao: 1, salt, payload });

      const res = await plataforma.salvarBackup(conteudo, { nomeArquivo: `backup-estoque-${logic.hojeISO()}.estoquebkp` });
      if (!res.ok) return res;
      return {
        ...res,
        totalItens: pacote.items.length,
        totalUsuarios: pacote.usuarios.length,
        totalMovimentacoes: pacote.transacoes.length,
        totalContasLogin: (pacote.contasLogin || []).length,
      };
    } catch (erro) {
      return { ok: false, erro: 'Não foi possível exportar o backup: ' + erro.message };
    }
  };

  h['backup:importar'] = async (sessao, { senha, modo, conteudo } = {}) => {
    // "Mesclar" é exclusivo do Admin; o Default só pode substituir tudo ou exportar.
    if (modo === 'mesclar' && !ehAdmin(sessao)) {
      return {
        ok: false,
        erro: 'Somente o admin pode importar mesclando com os dados atuais. O perfil Default só pode ' +
          'importar substituindo tudo, ou exportar.',
      };
    }
    if (!senha) return { ok: false, erro: 'Informe a senha usada ao exportar o backup.' };

    try {
      const lido = await plataforma.lerBackup({ conteudo });
      if (!lido.ok) return lido;

      let arquivo;
      try {
        arquivo = JSON.parse(lido.conteudo);
      } catch (erro) {
        return { ok: false, erro: 'Não foi possível ler o arquivo selecionado (formato inválido).' };
      }
      if (!arquivo || arquivo.formato !== FORMATO_ARQUIVO_BACKUP || !arquivo.salt || !arquivo.payload) {
        return { ok: false, erro: 'Esse arquivo não parece ser um backup válido do Controle de Estoque.' };
      }

      let pacote;
      try {
        const chave = cryptoUtils.derivarChaveDeSenha(senha, arquivo.salt);
        pacote = cryptoUtils.descriptografarJSON(arquivo.payload, chave);
      } catch (erro) {
        return { ok: false, erro: 'Senha incorreta ou arquivo corrompido.' };
      }

      // Acesso de Admin só viaja no backup quando quem importa já é Admin — senão um Default
      // poderia montar um arquivo com uma conta "Admin" e se dar acesso total.
      if (!ehAdmin(sessao) && Array.isArray(pacote.contasLogin)) {
        pacote = { ...pacote, contasLogin: pacote.contasLogin.map((c) => (c && typeof c === 'object' ? { ...c, admin: false } : c)) };
      }
      const res =
        modo === 'mesclar'
          ? logic.aplicarPacoteImportacaoMesclado(await carregar(), pacote)
          : logic.aplicarPacoteImportacao(await carregar(), pacote);
      if (res.ok) {
        await persistir(res.data);
        // As contas de login podem ter mudado — a sessão atual deixa de valer (volta pro login).
        limparSessao(sessao);
      }
      return { ...res, perfil: sessao.perfil };
    } catch (erro) {
      return { ok: false, erro: 'Não foi possível importar o backup: ' + erro.message };
    }
  };

  return h;
}

/**
 * Executa um canal pra uma sessão: recusa canais desconhecidos, recusa tudo fora da lista
 * `CANAIS_SEM_SESSAO` enquanto ninguém estiver logado, e tira da resposta o campo `data` (o banco
 * inteiro, que as regras de logic.js devolvem junto) — a interface nunca precisa dele, e ele traz
 * hashes de senha que não devem sair do servidor.
 */
async function executar(handlers, canal, sessao, args) {
  if (typeof canal !== 'string' || !Object.prototype.hasOwnProperty.call(handlers, canal)) {
    return { ok: false, erro: 'Ação desconhecida.' };
  }
  if (!CANAIS_SEM_SESSAO.has(canal) && !sessao.perfil) {
    return { ok: false, erro: 'Sessão não autenticada — faça login novamente.' };
  }
  // `null` vira `undefined`, pra valerem os valores padrão (`{ usuario, senha } = {}`) dos canais.
  const argumentos = (Array.isArray(args) ? args : []).map((a) => (a === null ? undefined : a));
  const res = await handlers[canal](sessao, ...argumentos);
  if (res && typeof res === 'object' && !Array.isArray(res) && Object.prototype.hasOwnProperty.call(res, 'data')) {
    const { data, ...resto } = res; // eslint-disable-line no-unused-vars
    return resto;
  }
  return res;
}

module.exports = {
  FORMATO_ARQUIVO_BACKUP,
  CANAIS_SEM_SESSAO,
  novaSessao,
  limparSessao,
  criarHandlers,
  executar,
};
