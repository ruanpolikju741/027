'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/** Ponte segura entre a interface (renderer) e o processo principal.
 * O renderer nunca acessa Node/Electron diretamente — só estas funções. */
contextBridge.exposeInMainWorld('api', {
  auth: {
    getPerfil: () => ipcRenderer.invoke('auth:getPerfil'),
    quemSou: () => ipcRenderer.invoke('auth:quemSou'),
    precisaConfigurarLogin: () => ipcRenderer.invoke('auth:precisaConfigurarLogin'),
    configurarLoginInicial: (usuario, senha) =>
      ipcRenderer.invoke('auth:configurarLoginInicial', { usuario, senha }),
    login: (usuario, senha) => ipcRenderer.invoke('auth:login', { usuario, senha }),
    trocarSenhaPrimeiroAcesso: (contaId, senhaAtual, novaSenha) =>
      ipcRenderer.invoke('auth:trocarSenhaPrimeiroAcesso', { contaId, senhaAtual, novaSenha }),
    loginAdmin: (usuario, senha) => ipcRenderer.invoke('auth:loginAdmin', { usuario, senha }),
    logoutAdmin: () => ipcRenderer.invoke('auth:logoutAdmin'),
    logout: () => ipcRenderer.invoke('auth:logout'),
    redefinirLoginAdmin: (senhaAtual, novoUsuario, novaSenha) =>
      ipcRenderer.invoke('auth:redefinirLoginAdmin', { senhaAtual, novoUsuario, novaSenha }),
  },
  contasLogin: {
    listar: () => ipcRenderer.invoke('contasLogin:listar'),
    criar: (usuario, senha, admin) => ipcRenderer.invoke('contasLogin:criar', { usuario, senha, admin }),
    definirAdmin: (contaId, admin) => ipcRenderer.invoke('contasLogin:definirAdmin', { contaId, admin }),
    excluir: (contaId) => ipcRenderer.invoke('contasLogin:excluir', contaId),
    resetarSenha: (contaId, novaSenha) => ipcRenderer.invoke('contasLogin:resetarSenha', { contaId, novaSenha }),
  },
  items: {
    list: () => ipcRenderer.invoke('items:list'),
    add: (params) => ipcRenderer.invoke('items:add', params),
    edit: (itemId, params) => ipcRenderer.invoke('items:edit', { itemId, ...params }),
    remove: (itemId) => ipcRenderer.invoke('items:remove', itemId),
    adjust: (params) => ipcRenderer.invoke('items:adjust', params),
    definirPreco: (itemId, preco) => ipcRenderer.invoke('items:definirPreco', { itemId, preco }),
  },
  usuarios: {
    list: () => ipcRenderer.invoke('usuarios:list'),
    add: (nome, telefone) => ipcRenderer.invoke('usuarios:add', { nome, telefone }),
    remove: (usuarioId) => ipcRenderer.invoke('usuarios:remove', usuarioId),
    editar: (usuarioId, params) => ipcRenderer.invoke('usuarios:editar', { usuarioId, ...params }),
    favoritar: (usuarioId, favorito) => ipcRenderer.invoke('usuarios:favoritar', usuarioId, favorito),
    definirBloqueio: (usuarioId, bloqueado) =>
      ipcRenderer.invoke('usuarios:definirBloqueio', { usuarioId, bloqueado }),
    excluirTodos: () => ipcRenderer.invoke('usuarios:excluirTodos'),
  },
  historico: {
    listDias: () => ipcRenderer.invoke('historico:listDias'),
    listPorDia: (dia) => ipcRenderer.invoke('historico:listPorDia', dia),
    listLancamentosEPagamentosPorDia: (dia) =>
      ipcRenderer.invoke('historico:listLancamentosEPagamentosPorDia', dia),
    listarPeriodo: (dataInicio, dataFim) => ipcRenderer.invoke('historico:listarPeriodo', { dataInicio, dataFim }),
    listarLancamentosEPagamentosPeriodo: (dataInicio, dataFim) =>
      ipcRenderer.invoke('historico:listarLancamentosEPagamentosPeriodo', { dataInicio, dataFim }),
    excluirTudo: () => ipcRenderer.invoke('historico:excluirTudo'),
    excluirTodosLancamentosEPagamentos: () => ipcRenderer.invoke('historico:excluirTodosLancamentosEPagamentos'),
    excluirSelecionados: (idsTransacoes) => ipcRenderer.invoke('historico:excluirSelecionados', idsTransacoes),
    desfazerInfo: () => ipcRenderer.invoke('historico:desfazerInfo'),
    desfazerUltima: () => ipcRenderer.invoke('historico:desfazerUltima'),
    definirPendente: (transacaoId, pendente) =>
      ipcRenderer.invoke('historico:definirPendente', { transacaoId, pendente }),
    marcarRecebidoDefault: (transacaoId, marcado) =>
      ipcRenderer.invoke('historico:marcarRecebidoDefault', { transacaoId, marcado }),
  },
  relatorio: {
    gerarPdfPedidos: (dataInicio, dataFim) =>
      ipcRenderer.invoke('relatorio:gerarPdfPedidos', { dataInicio, dataFim }),
    gerarPdfQuantidades: () => ipcRenderer.invoke('relatorio:gerarPdfQuantidades'),
    gerarPdfPendenciaUsuario: (usuarioId) =>
      ipcRenderer.invoke('relatorio:gerarPdfPendenciaUsuario', { usuarioId }),
    gerarPdfConsulta: (modo, usuarioId, itemId, dataInicio, dataFim) =>
      ipcRenderer.invoke('relatorio:gerarPdfConsulta', { modo, usuarioId, itemId, dataInicio, dataFim }),
  },
  precificacao: {
    listar: () => ipcRenderer.invoke('precificacao:listar'),
  },
  lancamentos: {
    adicionar: (usuarioId, valor, observacao) =>
      ipcRenderer.invoke('lancamentos:adicionar', { usuarioId, valor, observacao }),
    listarPorUsuario: (usuarioId) => ipcRenderer.invoke('lancamentos:listarPorUsuario', usuarioId),
    definirPendente: (lancamentoId, pendente) =>
      ipcRenderer.invoke('lancamentos:definirPendente', { lancamentoId, pendente }),
    marcarRecebidoDefault: (lancamentoId, marcado) =>
      ipcRenderer.invoke('lancamentos:marcarRecebidoDefault', { lancamentoId, marcado }),
    editar: (lancamentoId, valor, observacao) =>
      ipcRenderer.invoke('lancamentos:editar', { lancamentoId, valor, observacao }),
    remover: (lancamentoId) => ipcRenderer.invoke('lancamentos:remover', lancamentoId),
  },
  pagamentos: {
    adicionar: (usuarioId, valor, observacao) =>
      ipcRenderer.invoke('pagamentos:adicionar', { usuarioId, valor, observacao }),
    listarPorUsuario: (usuarioId) => ipcRenderer.invoke('pagamentos:listarPorUsuario', usuarioId),
    editar: (pagamentoId, valor, observacao) =>
      ipcRenderer.invoke('pagamentos:editar', { pagamentoId, valor, observacao }),
    remover: (pagamentoId) => ipcRenderer.invoke('pagamentos:remover', pagamentoId),
  },
  pendencias: {
    listarUsuarios: () => ipcRenderer.invoke('pendencias:listarUsuarios'),
    detalharUsuario: (usuarioId) => ipcRenderer.invoke('pendencias:detalharUsuario', usuarioId),
    listarQuitados: () => ipcRenderer.invoke('pendencias:listarQuitados'),
    quitarUsuario: (usuarioId, comentario) =>
      ipcRenderer.invoke('pendencias:quitarUsuario', { usuarioId, comentario }),
    totalizar: () => ipcRenderer.invoke('pendencias:totalizar'),
  },
  consulta: {
    porUsuario: (usuarioId, dataInicio, dataFim) =>
      ipcRenderer.invoke('consulta:porUsuario', { usuarioId, dataInicio, dataFim }),
    porItem: (itemId, dataInicio, dataFim) =>
      ipcRenderer.invoke('consulta:porItem', { itemId, dataInicio, dataFim }),
  },
  backup: {
    exportar: (senha) => ipcRenderer.invoke('backup:exportar', { senha }),
    importar: (senha, modo) => ipcRenderer.invoke('backup:importar', { senha, modo }),
  },
});
