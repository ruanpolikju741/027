'use strict';

/**
 * Geração do HTML dos relatórios (pedidos, quantidades, pendência de um usuário e consulta) —
 * funções puras, sem Electron nem rede: recebem os dados já calculados por src/logic.js e
 * devolvem uma página HTML completa. O app desktop transforma esse HTML em PDF com o
 * `printToPDF` do Electron; a versão web abre o mesmo HTML numa aba e chama a impressão do
 * navegador ("Salvar como PDF"), no PC ou no celular.
 */

/** Escapa texto pra uso seguro dentro do HTML do relatório (nome de item/usuário vêm do cadastro). */
function escapeHtml(texto) {
  return String(texto == null ? '' : texto).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function formatarMoedaRelatorio(valor) {
  return (Number(valor) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function formatarDiaRelatorio(diaISO) {
  const [ano, mes, dia] = String(diaISO).split('-');
  return `${dia}/${mes}/${ano}`;
}

function formatarDataHoraRelatorio(iso) {
  return new Date(iso).toLocaleString('pt-BR');
}

/** Formata um período (dataInicio/dataFim, ambos opcionais) como texto legível — usado no
 * subtítulo de todo relatório em PDF do app que aceita um período (pedidos, consulta). */
function formatarPeriodoTexto(dataInicio, dataFim) {
  if (dataInicio && dataFim && dataInicio === dataFim) {
    return formatarDiaRelatorio(dataInicio);
  } else if (dataInicio && dataFim) {
    return `${formatarDiaRelatorio(dataInicio)} até ${formatarDiaRelatorio(dataFim)}`;
  } else if (dataInicio) {
    return `a partir de ${formatarDiaRelatorio(dataInicio)}`;
  } else if (dataFim) {
    return `até ${formatarDiaRelatorio(dataFim)}`;
  }
  return 'todo o período';
}

/** CSS compartilhado por todos os relatórios em PDF do app (pedidos, quantidades, pendência de
 * usuário e consulta) — pra manter a mesma aparência em todos, sem repetir o bloco inteiro em
 * cada `montarHtmlRelatorioX`. `extra` é CSS adicional específico de um relatório (opcional). */
function estiloRelatorioPdf(extra) {
  return `
  @page { size: A4; margin: 16mm 14mm; }
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; color: #2b2438; margin: 0; font-size: 12px; }
  h1 { font-size: 18px; margin: 0 0 2px; color: #6a3fc7; }
  h2 { font-size: 13px; margin: 18px 0 4px; color: #6a3fc7; }
  .subtitulo { font-size: 12px; color: #6b6478; margin: 0 0 14px; }
  table { width: 100%; border-collapse: collapse; margin-top: 6px; }
  .tabela-por-item { max-width: 70%; }
  thead { display: table-header-group; }
  tr { page-break-inside: avoid; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #e3dced; font-size: 11px; }
  th { background: #efe7fb; color: #6a3fc7; font-weight: 700; }
  td.num, th.num { text-align: right; }
  tfoot td { font-weight: 700; border-top: 2px solid #6a3fc7; border-bottom: none; padding-top: 8px; }
  .vazio { padding: 20px 0; color: #8b849c; }
  .status-pendente { color: #b8860b; font-weight: 700; }
  .status-concluido { color: #21a57c; font-weight: 700; }
  .totais-cards { display: flex; gap: 14px; margin: 10px 0 4px; }
  .total-card { border: 1px solid #e3dced; border-radius: 8px; padding: 8px 12px; min-width: 140px; }
  .total-card .label { display: block; font-size: 10px; color: #6b6478; text-transform: uppercase; letter-spacing: .02em; }
  .total-card .valor { display: block; font-size: 15px; font-weight: 700; color: #2b2438; margin-top: 2px; }
  .total-card.destaque .valor { color: #6a3fc7; }
  ${extra || ''}`;
}

/** Monta o HTML completo do relatório de pedidos a partir do resultado de `logic.listarPedidosParaRelatorio`. */
function montarHtmlRelatorioPedidos(relatorio) {
  const periodoTexto = formatarPeriodoTexto(relatorio.dataInicio, relatorio.dataFim);

  const linhasHtml = relatorio.pedidos
    .map(
      (p) => `
      <tr>
        <td>${formatarDataHoraRelatorio(p.dataHoraISO)}</td>
        <td>${escapeHtml(p.itemNome)}</td>
        <td>${p.usuarioNome ? escapeHtml(p.usuarioNome) : '—'}</td>
        <td class="num">${p.quantidade}</td>
        <td>${p.tipoEntrega === 'entrega' ? 'Entrega' : p.tipoEntrega === 'retirada' ? 'Retirada' : '—'}</td>
        <td>${p.pendente ? '<span class="status-pendente">Pendente</span>' : '<span class="status-concluido">Concluído</span>'}</td>
        <td class="num">${formatarMoedaRelatorio(p.precoUnitario)}</td>
        <td class="num">${formatarMoedaRelatorio(p.valorTotal)}</td>
      </tr>`
    )
    .join('');

  const corpoTabela = relatorio.pedidos.length
    ? `
      <h2>Detalhamento dos pedidos</h2>
      <table>
        <thead>
          <tr>
            <th>Hora</th><th>Item</th><th>Usuário</th><th class="num">Qtd.</th>
            <th>Entrega</th><th>Status</th><th class="num">Valor unit.</th><th class="num">Valor total</th>
          </tr>
        </thead>
        <tbody>${linhasHtml}</tbody>
        <tfoot>
          <tr>
            <td colspan="3">Total</td>
            <td class="num">${relatorio.totalQuantidade}</td>
            <td colspan="3"></td>
            <td class="num">${formatarMoedaRelatorio(relatorio.totalValor)}</td>
          </tr>
        </tfoot>
      </table>`
    : '<p class="vazio">Nenhum pedido (saída de item) encontrado nesse período.</p>';

  // Tabela-resumo com o total (quantidade + valor) de cada item que saiu no período —
  // vem antes do detalhamento linha a linha, como uma visão geral do relatório.
  const linhasPorItemHtml = relatorio.porItem
    .map(
      (p) => `
      <tr>
        <td>${escapeHtml(p.itemNome)}</td>
        <td class="num">${p.quantidade}</td>
        <td class="num">${formatarMoedaRelatorio(p.valorTotal)}</td>
      </tr>`
    )
    .join('');

  const tabelaPorItem = relatorio.porItem.length
    ? `
      <h2>Total por item</h2>
      <table class="tabela-por-item">
        <thead>
          <tr><th>Item</th><th class="num">Qtd. total</th><th class="num">Valor total</th></tr>
        </thead>
        <tbody>${linhasPorItemHtml}</tbody>
      </table>`
    : '';

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8" />
<style>${estiloRelatorioPdf()}</style>
</head>
<body>
  <h1>Controle de Estoque — Relatório de Pedidos</h1>
  <p class="subtitulo">Período: ${escapeHtml(periodoTexto)} &nbsp;•&nbsp; Gerado em ${formatarDataHoraRelatorio(new Date().toISOString())}</p>
  ${tabelaPorItem}
  ${corpoTabela}
</body>
</html>`;
}

/** Monta o HTML completo do relatório de quantidades a partir do resultado de `logic.listarQuantidadesAtuaisParaRelatorio`. */
function montarHtmlRelatorioQuantidades(relatorio) {
  const linhasHtml = relatorio.itens
    .map(
      (i) => `
      <tr>
        <td>${escapeHtml(i.nome)}</td>
        <td class="num">${i.quantidade}</td>
      </tr>`
    )
    .join('');

  const corpoTabela = relatorio.itens.length
    ? `
      <table>
        <thead>
          <tr><th>Item</th><th class="num">Quantidade</th></tr>
        </thead>
        <tbody>${linhasHtml}</tbody>
        <tfoot>
          <tr>
            <td>Total (${relatorio.totalItens} ${relatorio.totalItens === 1 ? 'item' : 'itens'})</td>
            <td class="num">${relatorio.totalQuantidade}</td>
          </tr>
        </tfoot>
      </table>`
    : '<p class="vazio">Nenhum item com quantidade cadastrada no catálogo.</p>';

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8" />
<style>${estiloRelatorioPdf('table { max-width: 70%; }')}</style>
</head>
<body>
  <h1>Controle de Estoque — Quantidades do Catálogo</h1>
  <p class="subtitulo">Só itens com quantidade &gt; 0 &nbsp;•&nbsp; Gerado em ${formatarDataHoraRelatorio(new Date().toISOString())}</p>
  ${corpoTabela}
</body>
</html>`;
}

/** Nome de arquivo seguro a partir de um texto qualquer (nome de usuário/item) — sem acento,
 * espaço nem caractere especial, pra virar `defaultPath` de um diálogo "Salvar como". */
function slugParaArquivo(texto) {
  return String(texto || 'sem-nome')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // remove acentos
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'sem-nome';
}

/** Monta o HTML completo do relatório de pendência de um usuário a partir do resultado de
 * `logic.detalharPendenciasUsuario`. */
function montarHtmlRelatorioPendenciaUsuario(detalhe) {
  const linhasPendenciasHtml = detalhe.pendencias
    .map(
      (p) => `
      <tr>
        <td>${formatarDataHoraRelatorio(p.dataHoraISO)}</td>
        <td>${escapeHtml(p.descricao)}${p.quantidade != null ? ` (qtd. ${p.quantidade})` : ''}</td>
        <td class="num">${formatarMoedaRelatorio(p.valor)}</td>
      </tr>`
    )
    .join('');

  const tabelaPendencias = detalhe.pendencias.length
    ? `
      <h2>O que está pendente</h2>
      <table>
        <thead><tr><th>Data</th><th>Descrição</th><th class="num">Valor</th></tr></thead>
        <tbody>${linhasPendenciasHtml}</tbody>
        <tfoot>
          <tr><td colspan="2">Total pendente</td><td class="num">${formatarMoedaRelatorio(detalhe.totalPendencias)}</td></tr>
        </tfoot>
      </table>`
    : '<h2>O que está pendente</h2><p class="vazio">Nada pendente para este usuário.</p>';

  const linhasPagamentosHtml = detalhe.pagamentos
    .map(
      (p) => `
      <tr>
        <td>${formatarDataHoraRelatorio(p.dataHoraISO)}</td>
        <td class="num">${formatarMoedaRelatorio(p.valor)}</td>
        <td>${escapeHtml(p.observacao || '—')}</td>
      </tr>`
    )
    .join('');

  const tabelaPagamentos = detalhe.pagamentos.length
    ? `
      <h2>Pagamentos já registrados</h2>
      <table>
        <thead><tr><th>Data</th><th class="num">Valor</th><th>Comentário</th></tr></thead>
        <tbody>${linhasPagamentosHtml}</tbody>
        <tfoot>
          <tr><td>Total pago</td><td class="num">${formatarMoedaRelatorio(detalhe.totalPagamentos)}</td><td></td></tr>
        </tfoot>
      </table>`
    : '<h2>Pagamentos já registrados</h2><p class="vazio">Nenhum pagamento registrado ainda.</p>';

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8" />
<style>${estiloRelatorioPdf()}</style>
</head>
<body>
  <h1>Controle de Estoque — Pendência de ${escapeHtml(detalhe.usuarioNome || 'usuário')}</h1>
  <p class="subtitulo">${detalhe.usuarioTelefone ? `Telefone: ${escapeHtml(detalhe.usuarioTelefone)} &nbsp;•&nbsp; ` : ''}Gerado em ${formatarDataHoraRelatorio(new Date().toISOString())}</p>
  <div class="totais-cards">
    <div class="total-card"><span class="label">Total pendências</span><span class="valor">${formatarMoedaRelatorio(detalhe.totalPendencias)}</span></div>
    <div class="total-card"><span class="label">Total já pago</span><span class="valor">${formatarMoedaRelatorio(detalhe.totalPagamentos)}</span></div>
    <div class="total-card destaque"><span class="label">Saldo pendente</span><span class="valor">${formatarMoedaRelatorio(detalhe.totalPendente)}</span></div>
  </div>
  ${tabelaPendencias}
  ${tabelaPagamentos}
</body>
</html>`;
}

/** Monta o HTML do relatório de consulta POR USUÁRIO a partir do resultado de
 * `logic.consultarPorUsuario` — recebe também o cadastro do usuário (nome/telefone), já que
 * o resultado da consulta em si não repete esses dados quando não há nenhuma movimentação. */
function montarHtmlRelatorioConsultaUsuario(resultado, usuario, periodoTexto) {
  const linhasSomaHtml = resultado.somaPorItem
    .map(
      (s) => `
      <tr>
        <td>${escapeHtml(s.itemNome)}</td>
        <td class="num">${s.totalEntrada}</td>
        <td class="num">${s.totalSaida}</td>
        <td class="num">${s.saldoLiquido}</td>
      </tr>`
    )
    .join('');
  const tabelaSoma = resultado.somaPorItem.length
    ? `
      <h2>Soma por item no período</h2>
      <table>
        <thead><tr><th>Item</th><th class="num">Total adicionado</th><th class="num">Total removido</th><th class="num">Saldo líquido</th></tr></thead>
        <tbody>${linhasSomaHtml}</tbody>
      </table>`
    : '<h2>Soma por item no período</h2><p class="vazio">Nenhuma movimentação no período.</p>';

  const lancamentos = resultado.lancamentos || [];
  const linhasLancamentosHtml = lancamentos
    .map(
      (l) => `
      <tr>
        <td>${formatarDataHoraRelatorio(l.dataHoraISO)}</td>
        <td class="num">${formatarMoedaRelatorio(l.valor)}</td>
        <td>${escapeHtml(l.observacao || '—')}</td>
        <td>${l.pendente ? '<span class="status-pendente">Pendente</span>' : '<span class="status-concluido">Concluído</span>'}</td>
      </tr>`
    )
    .join('');
  const tabelaLancamentos = lancamentos.length
    ? `
      <h2>Lançamentos avulsos no período</h2>
      <table>
        <thead><tr><th>Data</th><th class="num">Valor</th><th>Observação</th><th>Status</th></tr></thead>
        <tbody>${linhasLancamentosHtml}</tbody>
      </table>`
    : '';

  const tabelaMovimentacoes = montarTabelaMovimentacoesRelatorio(resultado.transacoes, { comUsuario: false });

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8" />
<style>${estiloRelatorioPdf()}</style>
</head>
<body>
  <h1>Controle de Estoque — Consulta: ${escapeHtml(usuario.nome)}</h1>
  <p class="subtitulo">${usuario.telefone ? `Telefone: ${escapeHtml(usuario.telefone)} &nbsp;•&nbsp; ` : ''}Período: ${escapeHtml(periodoTexto)} &nbsp;•&nbsp; Gerado em ${formatarDataHoraRelatorio(new Date().toISOString())}</p>
  ${tabelaSoma}
  ${tabelaLancamentos}
  ${tabelaMovimentacoes}
</body>
</html>`;
}

/** Monta o HTML do relatório de consulta POR ITEM a partir do resultado de `logic.consultarPorItem`. */
function montarHtmlRelatorioConsultaItem(resultado, periodoTexto) {
  const linhasUsuariosHtml = resultado.usuariosEnvolvidos
    .map(
      (u) => `
      <tr>
        <td>${escapeHtml(u.usuarioNome)}</td>
        <td class="num">${u.totalRecebido}</td>
      </tr>`
    )
    .join('');
  const tabelaUsuarios = resultado.usuariosEnvolvidos.length
    ? `
      <h2>Usuários envolvidos</h2>
      <table>
        <thead><tr><th>Usuário</th><th class="num">Total recebido</th></tr></thead>
        <tbody>${linhasUsuariosHtml}</tbody>
      </table>`
    : '';

  const tabelaMovimentacoes = montarTabelaMovimentacoesRelatorio(resultado.transacoes, { comUsuario: true });

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8" />
<style>${estiloRelatorioPdf()}</style>
</head>
<body>
  <h1>Controle de Estoque — Consulta: ${escapeHtml(resultado.itemNome)}</h1>
  <p class="subtitulo">Período: ${escapeHtml(periodoTexto)} &nbsp;•&nbsp; Gerado em ${formatarDataHoraRelatorio(new Date().toISOString())}</p>
  <div class="totais-cards">
    <div class="total-card"><span class="label">Total adicionado</span><span class="valor">${resultado.totalEntrada}</span></div>
    <div class="total-card"><span class="label">Total removido</span><span class="valor">${resultado.totalSaida}</span></div>
    <div class="total-card destaque"><span class="label">Quantidade atual</span><span class="valor">${resultado.quantidadeAtual != null ? resultado.quantidadeAtual : '— (item removido)'}</span></div>
  </div>
  ${tabelaUsuarios}
  ${tabelaMovimentacoes}
</body>
</html>`;
}

/** Tabela de movimentações (linha a linha) compartilhada pelos dois relatórios de consulta acima
 * — `comUsuario` mostra a coluna "Usuário" (consulta por item, onde ele varia linha a linha) e
 * esconde no outro caso (consulta por usuário, onde já é a mesma pessoa o tempo todo — o nome
 * dela já está no título do relatório). */
function montarTabelaMovimentacoesRelatorio(transacoes, { comUsuario }) {
  const colunaUsuario = comUsuario ? '<th>Usuário</th>' : '';
  const linhasHtml = transacoes
    .map((t) => {
      const sinal = t.tipo === 'entrada' ? '+' : '−';
      const celulaUsuario = comUsuario ? `<td>${t.usuarioNome ? escapeHtml(t.usuarioNome) : '—'}</td>` : '';
      return `
      <tr>
        <td>${formatarDiaRelatorio(t.dataDia)}</td>
        <td>${formatarDataHoraRelatorio(t.dataHoraISO)}</td>
        <td>${escapeHtml(t.itemNome)}</td>
        ${celulaUsuario}
        <td class="num">${sinal} ${t.quantidade}</td>
        <td class="num">${t.quantidadeResultante}</td>
        <td>${t.tipoEntrega === 'entrega' ? 'Entrega' : t.tipoEntrega === 'retirada' ? 'Retirada' : '—'}</td>
        <td>${!t.usuarioId ? '—' : t.pendente ? '<span class="status-pendente">Pendente</span>' : '<span class="status-concluido">Concluído</span>'}</td>
        <td>${t.perfil === 'admin' ? 'Admin' : 'Default'}</td>
        <td>${t.importado ? 'Importado' : 'Local'}</td>
      </tr>`;
    })
    .join('');

  if (!transacoes.length) {
    return '<h2>Movimentações no período</h2><p class="vazio">Nenhuma movimentação encontrada.</p>';
  }
  return `
      <h2>Movimentações no período</h2>
      <table>
        <thead>
          <tr>
            <th>Data</th><th>Hora</th><th>Item</th>${colunaUsuario}<th class="num">Movimentação</th><th class="num">Qtd. resultante</th>
            <th>Entrega</th><th>Status</th><th>Feito por</th><th>Origem</th>
          </tr>
        </thead>
        <tbody>${linhasHtml}</tbody>
      </table>`;
}

module.exports = {
  escapeHtml,
  formatarMoedaRelatorio,
  formatarDiaRelatorio,
  formatarDataHoraRelatorio,
  formatarPeriodoTexto,
  estiloRelatorioPdf,
  montarHtmlRelatorioPedidos,
  montarHtmlRelatorioQuantidades,
  slugParaArquivo,
  montarHtmlRelatorioPendenciaUsuario,
  montarHtmlRelatorioConsultaUsuario,
  montarHtmlRelatorioConsultaItem,
  montarTabelaMovimentacoesRelatorio,
};
