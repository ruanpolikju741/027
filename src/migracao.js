'use strict';

/**
 * Atualização de dados salvos por versões anteriores do app para o formato atual — pura (sem
 * Electron nem disco), usada tanto pelo desktop (src/store.js) quanto pela versão web
 * (web/repositorio.js) ao carregar os dados.
 */

/**
 * Migra dados salvos por versões anteriores do app para o formato atual,
 * preenchendo campos novos com valores neutros (nunca apaga nada existente).
 */
function migrar(data) {
  if (!data || typeof data !== 'object') return data;
  if (Array.isArray(data.usuarios)) {
    data.usuarios = data.usuarios.map((u) => ({ telefone: '', bloqueadoParaDefault: false, ...u }));
  }
  if (Array.isArray(data.items)) {
    data.items = data.items.map((i) => ({ precoUnitario: 0, ...i }));
  }
  if (Array.isArray(data.transacoes)) {
    // Mapa dos itens ainda existentes no catálogo, pra "adivinhar" (melhor esforço) o
    // preço unitário que valia numa movimentação antiga que ainda não tinha o campo
    // `precoUnitarioNaHora` (adicionado depois) — usa o preço ATUAL do item como retrato
    // aproximado. Sem isso, uma pendência antiga desse item ficaria valendo R$ 0,00 assim
    // que o item fosse removido do catálogo (ver `valorTransacaoPendente`).
    const mapaItensAtuais = new Map((data.items || []).map((i) => [i.id, i]));
    data.transacoes = data.transacoes.map((t) => {
      let precoUnitarioNaHora = t.precoUnitarioNaHora;
      if (precoUnitarioNaHora === undefined) {
        const itemAtual = mapaItensAtuais.get(t.itemId);
        const precoAtual = itemAtual ? Number(itemAtual.precoUnitario) : NaN;
        precoUnitarioNaHora = Number.isFinite(precoAtual) && precoAtual > 0 ? precoAtual : null;
      }
      return {
        usuarioTelefone: null,
        tipoEntrega: null,
        pendente: false,
        marcadoRecebidoDefault: false,
        ...t,
        precoUnitarioNaHora,
      };
    });
  }
  if (!Array.isArray(data.lancamentos)) {
    data.lancamentos = [];
  } else {
    data.lancamentos = data.lancamentos.map((l) => ({ marcadoRecebidoDefault: false, ...l }));
  }
  if (!Array.isArray(data.pagamentos)) {
    data.pagamentos = [];
  }
  if (!Array.isArray(data.contasLogin)) {
    // Instalação já existente, de antes do gerenciador de login: ainda não tem nenhuma conta de
    // login do Default cadastrada — a partir daqui só o Admin (com o login que ele já tinha)
    // consegue entrar, até cadastrar contas novas na aba "Contas de login" (ver
    // `logic.criarContaLogin`). É a consequência esperada dessa migração, não um bug: a entrada
    // livre e sem senha do Default deixou de existir.
    data.contasLogin = [];
  }
  // `admin` nunca é preenchido aqui: uma instalação já existente sempre tem o
  // seu (mesmo que seja o login padrão de versões antigas); só uma instalação
  // nova de verdade (sem arquivo de dados ainda) passa pelo fluxo de
  // "primeiro acesso" em carregarDados(), que cria `admin: null` de propósito.
  if (typeof data.primeiroAcessoConcluido !== 'boolean') {
    // Instalação de antes dessa marca existir: se ela já tem (ou já teve) um Admin configurado,
    // é porque com certeza já passou pelo primeiro acesso — marca como concluído pra tela de
    // "criar login de Admin" nunca mais reaparecer nela (nem depois de uma importação total, que
    // zera `admin` de propósito — ver `logic.aplicarPacoteImportacao`). Só fica `false` mesmo numa
    // instalação sem NENHUM dado ainda, que nunca chega a passar por aqui (ver `criarDadosIniciais`
    // em `carregarDados`, abaixo).
    data.primeiroAcessoConcluido = !!data.admin;
  }
  return data;
}

module.exports = { migrar };
