'use strict';

/**
 * "Preload" da versão WEB: cria o mesmo `window.api` que o preload.js do app desktop entrega pra
 * interface (renderer/app.js), só que cada chamada vira um POST pro servidor (/api/rpc) em vez de
 * IPC do Electron. Assim a interface é exatamente a mesma nos dois.
 *
 * O que muda de verdade na web fica todo aqui:
 *  - Relatórios em PDF: o servidor devolve a página do relatório; ela abre numa aba nova e a
 *    impressão do navegador aparece ("Salvar como PDF" — funciona no PC e no celular).
 *  - Backup: exportar baixa o arquivo .estoquebkp; importar abre o seletor de arquivo do aparelho.
 *  - Servidor "acordando": no plano gratuito ele dorme depois de 15 min parado e leva até ~1 min
 *    pra voltar — aparece um aviso na tela enquanto isso.
 *  - Sessão expirada (muito tempo parado, senha trocada…): volta sozinho pra tela de login.
 */
(function () {
  const TAMANHO_MAX_VIDEO = 10 * 1024 * 1024;
  const parametros = new URLSearchParams(window.location.search);
  // Link de configuração do Admin (?configurar=TOKEN) — só o dono do servidor tem esse token.
  const tokenConfiguracao = (parametros.get('configurar') || '').replace(/ /g, '+') || undefined;

  // ---------------------------------------------------------------------------
  // Aviso de "conectando" (servidor acordando / internet lenta)
  // ---------------------------------------------------------------------------
  let avisoEl = null;
  let pendentes = 0;
  let timerAviso = null;

  function mostrarAviso(texto) {
    if (!avisoEl) {
      avisoEl = document.createElement('div');
      avisoEl.className = 'aviso-conexao';
      avisoEl.setAttribute('role', 'status');
      document.body.appendChild(avisoEl);
    }
    avisoEl.textContent = texto;
    avisoEl.classList.add('visivel');
  }
  function esconderAviso() {
    if (avisoEl) avisoEl.classList.remove('visivel');
  }
  function inicioRequisicao() {
    pendentes++;
    if (!timerAviso) {
      timerAviso = setTimeout(() => {
        mostrarAviso('Conectando ao servidor… (se ele estava parado, pode levar até 1 minuto)');
      }, 2500);
    }
  }
  function fimRequisicao() {
    pendentes = Math.max(0, pendentes - 1);
    if (pendentes === 0) {
      clearTimeout(timerAviso);
      timerAviso = null;
      esconderAviso();
    }
  }

  let recarregando = false;
  function voltarParaLogin(mensagem) {
    if (!recarregando) {
      recarregando = true;
      mostrarAviso(mensagem || 'Sua sessão expirou — voltando para a tela de login…');
      setTimeout(() => window.location.reload(), 1500);
    }
    return new Promise(() => {}); // a página vai recarregar; não deixa a interface seguir com erro
  }

  const espera = (ms) => new Promise((r) => setTimeout(r, ms));

  function rpc(canal, ...args) {
    return chamarServidor('/api/rpc', canal, args);
  }

  async function chamarServidor(endereco, canal, args) {
    const corpo = JSON.stringify({ canal, args });
    inicioRequisicao();
    try {
      for (let tentativa = 0; ; tentativa++) {
        let resp;
        try {
          resp = await fetch(endereco, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'estoque-web' },
            body: corpo,
          });
        } catch (erroRede) {
          // Sem resposta (internet caiu, servidor reiniciando) — tenta mais algumas vezes.
          if (tentativa < 4) {
            mostrarAviso('Sem resposta do servidor — tentando de novo…');
            await espera(1500 * (tentativa + 1));
            continue;
          }
          mostrarAviso('Sem conexão com o servidor. Verifique a internet e recarregue a página.');
          throw erroRede;
        }
        if (resp.status === 503) {
          if (tentativa < 12) {
            mostrarAviso('O servidor está iniciando… aguarde.');
            await espera(5000);
            continue;
          }
          // Banco fora do ar (ex.: Supabase pausado): não segue com uma resposta que a tela não espera.
          mostrarAviso('O servidor não conseguiu acessar o banco de dados. Tente de novo em alguns minutos.');
          pendentes++; // mantém o aviso na tela
          return new Promise(() => {});
        }
        let json;
        try {
          json = await resp.json();
        } catch (e) {
          return { ok: false, erro: `Resposta inesperada do servidor (HTTP ${resp.status}).` };
        }
        const r = json && 'r' in json ? json.r : { ok: false, erro: (json && json.erro) || `Erro HTTP ${resp.status}` };
        if (r && r.sessaoExpirada) return voltarParaLogin();
        return r;
      }
    } finally {
      fimRequisicao();
    }
  }

  // ---------------------------------------------------------------------------
  // Relatórios: abre uma aba com o relatório e chama a impressão ("Salvar como PDF")
  // ---------------------------------------------------------------------------
  async function gerarRelatorio(canal, ...args) {
    // A aba precisa ser aberta AGORA, ainda dentro do clique, senão o navegador bloqueia.
    const janela = window.open('', '_blank');
    if (janela) {
      janela.document.write('<!doctype html><title>Gerando relatório…</title><p style="font-family:sans-serif;padding:24px">Gerando relatório…</p>');
    }
    const res = await rpc(canal, ...args);
    if (!res || !res.ok) {
      if (janela) janela.close();
      return res;
    }
    const { html, nomeArquivo, ...resto } = res;
    if (!janela) {
      return {
        ok: false,
        erro: 'O navegador bloqueou a aba do relatório. Permita pop-ups para este site e tente de novo.',
      };
    }
    janela.document.open();
    janela.document.write(html);
    janela.document.close();
    janela.document.title = String(nomeArquivo || 'relatorio').replace(/\.pdf$/i, '');

    // Barra com "Imprimir / Salvar PDF" (some na impressão) — útil no celular, se a pessoa fechar
    // a janela de impressão sem querer.
    const estilo = janela.document.createElement('style');
    estilo.textContent =
      '.barra-relatorio{position:sticky;top:0;display:flex;gap:8px;justify-content:flex-end;padding:8px;' +
      'background:#fff;border-bottom:1px solid #e3dced;margin:-4px 0 10px}' +
      '.barra-relatorio button{font:600 14px Arial,sans-serif;padding:8px 14px;border-radius:8px;border:1px solid #a76bff;' +
      'background:#a76bff;color:#fff}.barra-relatorio button.sec{background:#fff;color:#6a3fc7}' +
      '@media print{.barra-relatorio{display:none}}';
    janela.document.head.appendChild(estilo);
    const barra = janela.document.createElement('div');
    barra.className = 'barra-relatorio';
    const btnImprimir = janela.document.createElement('button');
    btnImprimir.textContent = 'Imprimir / Salvar PDF';
    btnImprimir.addEventListener('click', () => janela.print());
    const btnFechar = janela.document.createElement('button');
    btnFechar.className = 'sec';
    btnFechar.textContent = 'Fechar';
    btnFechar.addEventListener('click', () => janela.close());
    barra.append(btnFechar, btnImprimir);
    janela.document.body.prepend(barra);
    janela.focus();
    setTimeout(() => {
      try {
        janela.print();
      } catch (e) {
        /* a pessoa ainda pode usar o botão */
      }
    }, 400);
    return resto;
  }

  // ---------------------------------------------------------------------------
  // Backup: baixar e escolher arquivo
  // ---------------------------------------------------------------------------
  function baixarArquivo(conteudo, nomeArquivo) {
    const blob = new Blob([conteudo], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = nomeArquivo;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  function escolherArquivo(aceitar) {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = aceitar;
      input.style.display = 'none';
      document.body.appendChild(input);
      const terminar = (arquivo) => {
        input.remove();
        resolve(arquivo);
      };
      input.addEventListener('change', () => terminar(input.files && input.files[0] ? input.files[0] : null));
      input.addEventListener('cancel', () => terminar(null));
      input.click();
    });
  }

  async function importarBackup(senha, modo) {
    // "Mesclar" é só do Admin (o servidor também confere) — avisa antes de abrir o seletor.
    const rotuloPerfil = document.getElementById('perfil-label');
    if (modo === 'mesclar' && !(rotuloPerfil && rotuloPerfil.classList.contains('admin'))) {
      return {
        ok: false,
        erro: 'Somente o admin pode importar mesclando com os dados atuais. O perfil Default só pode importar substituindo tudo.',
      };
    }
    if (!senha) return { ok: false, erro: 'Informe a senha usada ao exportar o backup.' };
    const arquivo = await escolherArquivo('.estoquebkp,.json');
    if (!arquivo) return { ok: false, cancelado: true };
    let conteudo;
    try {
      conteudo = await arquivo.text();
    } catch (e) {
      return { ok: false, erro: 'Não foi possível ler o arquivo selecionado.' };
    }
    // `?grande=1`: o servidor libera um envio maior (o backup pode ter muitas fotos).
    return chamarServidor('/api/rpc?grande=1', 'backup:importar', [{ senha, modo, conteudo }]);
  }

  async function exportarBackup(senha) {
    const res = await rpc('backup:exportar', { senha });
    if (!res || !res.ok) return res;
    const { conteudo, nomeArquivo, ...resto } = res;
    baixarArquivo(conteudo, nomeArquivo);
    return resto;
  }

  // ---------------------------------------------------------------------------
  // Fotos/vídeos: limite de tamanho antes de gastar a internet do celular enviando
  // ---------------------------------------------------------------------------
  function conferirVideo(params) {
    const foto = params && params.foto;
    if (typeof foto === 'string' && foto.startsWith('data:video/')) {
      const bytes = ((foto.length - foto.indexOf(',') - 1) * 3) / 4;
      if (bytes > TAMANHO_MAX_VIDEO) {
        return { ok: false, erro: 'Vídeo grande demais para a versão web (máx. 10 MB) — escolha um vídeo menor/mais curto.' };
      }
    }
    return null;
  }
  const comLimiteVideo = (canal) => (params) => conferirVideo(params) || rpc(canal, params);

  // ---------------------------------------------------------------------------
  // window.api — mesma forma do preload.js do desktop
  // ---------------------------------------------------------------------------
  window.api = {
    auth: {
      getPerfil: () => rpc('auth:getPerfil'),
      quemSou: () => rpc('auth:quemSou'),
      precisaConfigurarLogin: () => rpc('auth:precisaConfigurarLogin', { tokenConfiguracao }),
      configurarLoginInicial: async (usuario, senha) => {
        const res = await rpc('auth:configurarLoginInicial', { usuario, senha, tokenConfiguracao });
        if (res && res.ok && tokenConfiguracao) {
          // Tira o token da barra de endereço (e do histórico) assim que ele foi usado.
          window.history.replaceState(null, '', window.location.pathname);
        }
        return res;
      },
      login: (usuario, senha) => rpc('auth:login', { usuario, senha }),
      trocarSenhaPrimeiroAcesso: (contaId, senhaAtual, novaSenha) =>
        rpc('auth:trocarSenhaPrimeiroAcesso', { contaId, senhaAtual, novaSenha }),
      loginAdmin: (usuario, senha) => rpc('auth:loginAdmin', { usuario, senha }),
      logoutAdmin: () => rpc('auth:logoutAdmin'),
      logout: () => rpc('auth:logout'),
      redefinirLoginAdmin: (senhaAtual, novoUsuario, novaSenha) =>
        rpc('auth:redefinirLoginAdmin', { senhaAtual, novoUsuario, novaSenha }),
    },
    contasLogin: {
      listar: () => rpc('contasLogin:listar'),
      criar: (usuario, senha, admin) => rpc('contasLogin:criar', { usuario, senha, admin }),
      definirAdmin: (contaId, admin) => rpc('contasLogin:definirAdmin', { contaId, admin }),
      excluir: (contaId) => rpc('contasLogin:excluir', contaId),
      resetarSenha: (contaId, novaSenha) => rpc('contasLogin:resetarSenha', { contaId, novaSenha }),
    },
    items: {
      list: () => rpc('items:list'),
      add: comLimiteVideo('items:add'),
      edit: (itemId, params) => conferirVideo(params) || rpc('items:edit', { itemId, ...params }),
      remove: (itemId) => rpc('items:remove', itemId),
      adjust: comLimiteVideo('items:adjust'),
      definirPreco: (itemId, preco) => rpc('items:definirPreco', { itemId, preco }),
    },
    usuarios: {
      list: () => rpc('usuarios:list'),
      add: (nome, telefone) => rpc('usuarios:add', { nome, telefone }),
      remove: (usuarioId) => rpc('usuarios:remove', usuarioId),
      editar: (usuarioId, params) => rpc('usuarios:editar', { usuarioId, ...params }),
      favoritar: (usuarioId, favorito) => rpc('usuarios:favoritar', usuarioId, favorito),
      definirBloqueio: (usuarioId, bloqueado) => rpc('usuarios:definirBloqueio', { usuarioId, bloqueado }),
      excluirTodos: () => rpc('usuarios:excluirTodos'),
    },
    historico: {
      listDias: () => rpc('historico:listDias'),
      listPorDia: (dia) => rpc('historico:listPorDia', dia),
      listLancamentosEPagamentosPorDia: (dia) => rpc('historico:listLancamentosEPagamentosPorDia', dia),
      listarPeriodo: (dataInicio, dataFim) => rpc('historico:listarPeriodo', { dataInicio, dataFim }),
      listarLancamentosEPagamentosPeriodo: (dataInicio, dataFim) =>
        rpc('historico:listarLancamentosEPagamentosPeriodo', { dataInicio, dataFim }),
      excluirTudo: () => rpc('historico:excluirTudo'),
      excluirTodosLancamentosEPagamentos: () => rpc('historico:excluirTodosLancamentosEPagamentos'),
      excluirSelecionados: (idsTransacoes) => rpc('historico:excluirSelecionados', idsTransacoes),
      desfazerInfo: () => rpc('historico:desfazerInfo'),
      desfazerUltima: () => rpc('historico:desfazerUltima'),
      definirPendente: (transacaoId, pendente) => rpc('historico:definirPendente', { transacaoId, pendente }),
      marcarRecebidoDefault: (transacaoId, marcado) =>
        rpc('historico:marcarRecebidoDefault', { transacaoId, marcado }),
    },
    relatorio: {
      gerarPdfPedidos: (dataInicio, dataFim) => gerarRelatorio('relatorio:gerarPdfPedidos', { dataInicio, dataFim }),
      gerarPdfQuantidades: () => gerarRelatorio('relatorio:gerarPdfQuantidades'),
      gerarPdfPendenciaUsuario: (usuarioId) => gerarRelatorio('relatorio:gerarPdfPendenciaUsuario', { usuarioId }),
      gerarPdfConsulta: (modo, usuarioId, itemId, dataInicio, dataFim) =>
        gerarRelatorio('relatorio:gerarPdfConsulta', { modo, usuarioId, itemId, dataInicio, dataFim }),
    },
    precificacao: {
      listar: () => rpc('precificacao:listar'),
    },
    lancamentos: {
      adicionar: (usuarioId, valor, observacao) => rpc('lancamentos:adicionar', { usuarioId, valor, observacao }),
      listarPorUsuario: (usuarioId) => rpc('lancamentos:listarPorUsuario', usuarioId),
      definirPendente: (lancamentoId, pendente) => rpc('lancamentos:definirPendente', { lancamentoId, pendente }),
      marcarRecebidoDefault: (lancamentoId, marcado) =>
        rpc('lancamentos:marcarRecebidoDefault', { lancamentoId, marcado }),
      editar: (lancamentoId, valor, observacao) => rpc('lancamentos:editar', { lancamentoId, valor, observacao }),
      remover: (lancamentoId) => rpc('lancamentos:remover', lancamentoId),
    },
    pagamentos: {
      adicionar: (usuarioId, valor, observacao) => rpc('pagamentos:adicionar', { usuarioId, valor, observacao }),
      listarPorUsuario: (usuarioId) => rpc('pagamentos:listarPorUsuario', usuarioId),
      editar: (pagamentoId, valor, observacao) => rpc('pagamentos:editar', { pagamentoId, valor, observacao }),
      remover: (pagamentoId) => rpc('pagamentos:remover', pagamentoId),
    },
    pendencias: {
      listarUsuarios: () => rpc('pendencias:listarUsuarios'),
      detalharUsuario: (usuarioId) => rpc('pendencias:detalharUsuario', usuarioId),
      listarQuitados: () => rpc('pendencias:listarQuitados'),
      quitarUsuario: (usuarioId, comentario) => rpc('pendencias:quitarUsuario', { usuarioId, comentario }),
      totalizar: () => rpc('pendencias:totalizar'),
    },
    consulta: {
      porUsuario: (usuarioId, dataInicio, dataFim) => rpc('consulta:porUsuario', { usuarioId, dataInicio, dataFim }),
      porItem: (itemId, dataInicio, dataFim) => rpc('consulta:porItem', { itemId, dataInicio, dataFim }),
    },
    backup: {
      exportar: exportarBackup,
      importar: importarBackup,
    },
  };

  document.documentElement.classList.add('versao-web');
})();
