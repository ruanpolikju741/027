'use strict';

/**
 * Regras de negócio puras (sem Electron, sem I/O). Recebem o objeto `data`
 * completo e retornam `{ ok: true, data, ...extra }` ou `{ ok: false, erro }`.
 * Isso permite testar toda a lógica com `node` puro.
 */

const { gerarId, hashSenha, verificarSenha, gerarSalt } = require('./crypto-utils');

function hojeISO(data = new Date()) {
  const ano = data.getFullYear();
  const mes = String(data.getMonth() + 1).padStart(2, '0');
  const dia = String(data.getDate()).padStart(2, '0');
  return `${ano}-${mes}-${dia}`;
}

/**
 * Cria a estrutura inicial de dados (primeira execução do app). `admin`
 * começa nulo de propósito: não existe mais login padrão fixo — a primeira
 * pessoa a abrir o app cria seu próprio usuário/senha de Admin (ver
 * `configurarLoginInicial`), que fica guardado criptografado como qualquer
 * outro dado do app.
 */
function criarDadosIniciais() {
  return {
    versao: 1,
    admin: null,
    // Marca se esta instalação JÁ passou pela tela de "criar login de Admin" (primeiro acesso)
    // alguma vez na vida — diferente de `admin` (que uma importação TOTAL de backup zera de
    // propósito, ver `aplicarPacoteImportacao`), esta marca NUNCA volta a `false` depois de
    // `true`. É o que garante que essa tela só apareça mesmo numa instalação genuinamente nova:
    // depois de uma importação total, `admin` fica null mas essa marca continua `true`, então a
    // tela de primeiro acesso não reaparece — o app simplesmente mostra a tela de login normal, e
    // como não há mais Admin nenhum configurado, só as contas de login trazidas pelo arquivo
    // conseguem entrar (ver `precisaConfigurarLoginInicial`/`verificarLogin`).
    primeiroAcessoConcluido: false,
    contasLogin: [],
    items: [],
    usuarios: [],
    transacoes: [],
    lancamentos: [],
    pagamentos: [],
  };
}

/**
 * Diz se esta instalação ainda precisa passar pela tela de "criar login de Admin" (primeiro
 * acesso) — só quando ela NUNCA passou por essa tela antes (ver `primeiroAcessoConcluido` em
 * `criarDadosIniciais`). Propositalmente NÃO usa só `!data.admin`: depois de uma importação TOTAL
 * de backup, `data.admin` fica null (ver `aplicarPacoteImportacao`), mas essa tela não deve
 * reaparecer — a máquina já passou pelo primeiro acesso antes, então volta direto pra tela de
 * login normal (onde, sem Admin configurado, só as contas do arquivo conseguem entrar).
 */
function precisaConfigurarLoginInicial(data) {
  return !data.admin && !data.primeiroAcessoConcluido;
}

function clonar(data) {
  return JSON.parse(JSON.stringify(data));
}

// ---------- Autenticação ----------

function verificarLoginAdmin(data, usuario, senha) {
  if (!data.admin) return false;
  if (String(usuario).trim() !== data.admin.usuario) return false;
  return verificarSenha(senha, data.admin.salt, data.admin.hashSenha);
}

/**
 * Define o login/senha do Admin na PRIMEIRA execução do app (quando ainda
 * não existe nenhum admin configurado) — ver "primeiro acesso" no
 * main.js/renderer. Só funciona uma vez: assim que `data.admin` existe,
 * qualquer nova tentativa é rejeitada (não é uma forma de trocar a senha
 * depois, só de criar o login inicial). A senha segue a mesma política do
 * resto do app: mínimo 6 caracteres, letras/números/símbolos permitidos.
 *
 * Também recusa quando a instalação JÁ passou pelo primeiro acesso antes (`primeiroAcessoConcluido`)
 * e o Admin só está vazio porque uma importação total o zerou — senão bastaria chamar essa ação
 * direto (sem passar pela tela) pra qualquer pessoa virar Admin. A única exceção é
 * `permitirRecriar: true`, usada quando quem chama já confirmou que é o dono da instalação (na
 * versão web: o link de configuração com o token secreto do servidor — ver src/handlers.js).
 */
function configurarLoginInicial(data, { usuario, senha } = {}, { permitirRecriar = false } = {}) {
  if (data.admin) {
    return { ok: false, erro: 'O login do Admin já foi configurado nesta instalação.' };
  }
  if (data.primeiroAcessoConcluido && !permitirRecriar) {
    return { ok: false, erro: 'O login do Admin já foi configurado nesta instalação.' };
  }
  const usuarioLimpo = String(usuario || '').trim();
  if (!usuarioLimpo) {
    return { ok: false, erro: 'Informe um nome de usuário para o Admin.' };
  }
  if (!senha || String(senha).length < 6) {
    return { ok: false, erro: 'A senha precisa ter no mínimo 6 caracteres (letras, números e símbolos são permitidos).' };
  }
  // Checagem defensiva: numa instalação genuinamente nova (o único cenário em que esta função
  // roda — ver `precisaConfigurarLoginInicial`) normalmente ainda não existe nenhuma conta de
  // login do Default, mas por segurança mesmo assim não deixa escolher pro Admin um usuário que
  // já seja de uma delas — isso deixaria essa conta "atrás" do Admin pra sempre na hora de logar
  // (ver `verificarLogin`).
  if (usuarioDeLoginJaExiste(data, usuarioLimpo)) {
    return {
      ok: false,
      erro:
        'Já existe uma conta de login com esse nome de usuário (trazida por um backup importado). ' +
        'Escolha outro nome de usuário para o Admin.',
    };
  }
  const novo = clonar(data);
  const salt = gerarSalt();
  novo.admin = {
    usuario: usuarioLimpo,
    salt,
    hashSenha: hashSenha(String(senha), salt),
  };
  novo.primeiroAcessoConcluido = true;
  return { ok: true, data: novo };
}

/**
 * Permite ao Admin trocar seu próprio usuário/senha DEPOIS do primeiro
 * acesso — diferente de `configurarLoginInicial` (que só funciona uma vez,
 * quando ainda não existe nenhum admin). Exige a senha ATUAL como
 * confirmação de segurança antes de aceitar o novo usuário/senha, mesmo já
 * estando autenticado como Admin nesta sessão (checagem de perfil fica no
 * main.js). Segue a mesma política de senha do resto do app: mínimo 6
 * caracteres.
 */
function redefinirLoginAdmin(data, { senhaAtual, novoUsuario, novaSenha } = {}) {
  if (!data.admin) {
    return { ok: false, erro: 'Ainda não existe um login de Admin configurado nesta instalação.' };
  }
  if (!verificarSenha(String(senhaAtual || ''), data.admin.salt, data.admin.hashSenha)) {
    return { ok: false, erro: 'Senha atual incorreta.' };
  }
  const usuarioLimpo = String(novoUsuario || '').trim();
  if (!usuarioLimpo) {
    return { ok: false, erro: 'Informe um nome de usuário para o Admin.' };
  }
  if (!novaSenha || String(novaSenha).length < 6) {
    return { ok: false, erro: 'A nova senha precisa ter no mínimo 6 caracteres (letras, números e símbolos são permitidos).' };
  }
  const novo = clonar(data);
  const salt = gerarSalt();
  novo.admin = {
    usuario: usuarioLimpo,
    salt,
    hashSenha: hashSenha(String(novaSenha), salt),
  };
  return { ok: true, data: novo };
}

// ---------- Contas de login do Default (gerenciador de login do Admin) ----------
//
// Diferente do Admin (um login único, ver acima), o perfil Default agora entra com uma
// CONTA NOMEADA — cadastrada pelo Admin em `data.contasLogin` — em vez da antiga entrada
// livre sem senha nenhuma. Cada conta: usuário (único nesta instalação, inclusive frente ao
// usuário do Admin) + senha com hash (mesma técnica scrypt do Admin, ver crypto-utils) +
// `precisaTrocarSenha` (força a pessoa a trocar a senha temporária que o Admin definiu, no
// primeiro login com ela — ver `trocarSenhaContaLogin`). Ações de criar/excluir/redefinir são
// exclusivas do Admin (checagem de perfil no main.js); a autenticação em si (`verificarLogin`)
// não exige perfil, já que é ela quem AINDA VAI dizer qual é o perfil de quem está entrando.

/** Já existe alguém (Admin ou outra conta) com esse nome de usuário nesta instalação? Comparação
 * exata (após aparar espaços), igual ao Admin — `ignorarContaId` deixa uma conta se comparar
 * consigo mesma ao trocar só a senha dela (não o usuário, mas por segurança já cobre os dois). */
function usuarioDeLoginJaExiste(data, usuario, ignorarContaId) {
  const usuarioLimpo = String(usuario || '').trim();
  if (data.admin && data.admin.usuario === usuarioLimpo) return true;
  return (data.contasLogin || []).some((c) => c.id !== ignorarContaId && c.usuario === usuarioLimpo);
}

/** Contas de login do Default, sem os dados sensíveis (nunca expõe hash/salt pro renderer) —
 * usada pela tela "Contas de login", exclusiva do Admin. */
function listarContasLogin(data) {
  return (data.contasLogin || [])
    .map((c) => ({ id: c.id, usuario: c.usuario, precisaTrocarSenha: !!c.precisaTrocarSenha, criadoEm: c.criadoEm }))
    .sort((a, b) => a.usuario.localeCompare(b.usuario, 'pt-BR'));
}

/**
 * Cria uma conta de login pro Default (ação exclusiva do Admin). A senha definida aqui é
 * tratada como TEMPORÁRIA de propósito: `precisaTrocarSenha` nasce `true`, então a pessoa é
 * obrigada a escolher a própria senha assim que logar pela primeira vez (ver
 * `trocarSenhaContaLogin`/`verificarLogin`).
 */
function criarContaLogin(data, { usuario, senha } = {}) {
  const usuarioLimpo = String(usuario || '').trim();
  if (!usuarioLimpo) {
    return { ok: false, erro: 'Informe um nome de usuário.' };
  }
  if (!senha || String(senha).length < 6) {
    return { ok: false, erro: 'A senha precisa ter no mínimo 6 caracteres (letras, números e símbolos são permitidos).' };
  }
  if (usuarioDeLoginJaExiste(data, usuarioLimpo)) {
    return { ok: false, erro: 'Já existe um login (Admin ou conta) com esse nome de usuário.' };
  }
  const novo = clonar(data);
  if (!Array.isArray(novo.contasLogin)) novo.contasLogin = [];
  const salt = gerarSalt();
  const conta = {
    id: gerarId('login'),
    usuario: usuarioLimpo,
    salt,
    hashSenha: hashSenha(String(senha), salt),
    precisaTrocarSenha: true,
    criadoEm: new Date().toISOString(),
  };
  novo.contasLogin.push(conta);
  return { ok: true, data: novo, conta: { id: conta.id, usuario: conta.usuario, precisaTrocarSenha: true, criadoEm: conta.criadoEm } };
}

/** Exclui uma conta de login do Default (ação exclusiva do Admin). Não pode ser desfeito — a
 * pessoa dona dessa conta não consegue mais entrar no app até o Admin criar uma nova pra ela. */
function excluirContaLogin(data, contaId) {
  const existe = (data.contasLogin || []).some((c) => c.id === contaId);
  if (!existe) return { ok: false, erro: 'Essa conta de login não existe (ou já foi excluída).' };
  const novo = clonar(data);
  novo.contasLogin = novo.contasLogin.filter((c) => c.id !== contaId);
  return { ok: true, data: novo };
}

/**
 * Redefine a senha de uma conta de login (ação exclusiva do Admin — ex.: a pessoa esqueceu a
 * senha). A nova senha volta a ser TEMPORÁRIA: `precisaTrocarSenha` volta pra `true`, então a
 * pessoa é obrigada a trocá-la de novo assim que logar (mesma regra da criação).
 */
function resetarSenhaContaLogin(data, contaId, novaSenha) {
  const novo = clonar(data);
  const conta = (novo.contasLogin || []).find((c) => c.id === contaId);
  if (!conta) return { ok: false, erro: 'Essa conta de login não existe (ou já foi excluída).' };
  if (!novaSenha || String(novaSenha).length < 6) {
    return { ok: false, erro: 'A senha precisa ter no mínimo 6 caracteres (letras, números e símbolos são permitidos).' };
  }
  const salt = gerarSalt();
  conta.salt = salt;
  conta.hashSenha = hashSenha(String(novaSenha), salt);
  conta.precisaTrocarSenha = true;
  return { ok: true, data: novo };
}

/**
 * Autentica um login (Admin OU uma conta de login do Default) — a tela de login única do app,
 * mostrada toda vez que ele abre (ver `main.js`/`renderer`). Tenta o Admin primeiro; se não bater,
 * tenta as contas de login. Quando a conta encontrada ainda está com `precisaTrocarSenha`, o
 * acesso NÃO é liberado direto: devolve `precisaTrocarSenha: true` (e o id da conta), pra o
 * renderer pedir a troca de senha antes de entrar de vez (ver `trocarSenhaContaLogin`).
 */
function verificarLogin(data, usuario, senha) {
  const usuarioLimpo = String(usuario || '').trim();
  if (verificarLoginAdmin(data, usuarioLimpo, senha)) {
    return { ok: true, tipo: 'admin' };
  }
  const conta = (data.contasLogin || []).find((c) => c.usuario === usuarioLimpo);
  if (conta && verificarSenha(String(senha || ''), conta.salt, conta.hashSenha)) {
    return { ok: true, tipo: 'default', contaId: conta.id, usuario: conta.usuario, precisaTrocarSenha: !!conta.precisaTrocarSenha };
  }
  return { ok: false, erro: 'Usuário ou senha inválidos.' };
}

/**
 * Troca a senha de uma conta de login — usada tanto na troca OBRIGATÓRIA (primeiro login depois
 * de criada, ou depois de um reset do Admin) quanto numa troca voluntária futura, se um dia
 * existir. Exige a senha ATUAL certa (mesma cautela do `redefinirLoginAdmin`), mesmo sendo a
 * senha temporária que acabou de autenticar — evita trocar a senha de uma conta sem realmente
 * confirmar que é quem acabou de logar. Sempre limpa `precisaTrocarSenha` no final.
 */
function trocarSenhaContaLogin(data, contaId, { senhaAtual, novaSenha } = {}) {
  const conta = (data.contasLogin || []).find((c) => c.id === contaId);
  if (!conta) return { ok: false, erro: 'Essa conta de login não existe (ou já foi excluída).' };
  if (!verificarSenha(String(senhaAtual || ''), conta.salt, conta.hashSenha)) {
    return { ok: false, erro: 'Senha atual incorreta.' };
  }
  if (!novaSenha || String(novaSenha).length < 6) {
    return { ok: false, erro: 'A nova senha precisa ter no mínimo 6 caracteres (letras, números e símbolos são permitidos).' };
  }
  const novo = clonar(data);
  const contaNova = novo.contasLogin.find((c) => c.id === contaId);
  const salt = gerarSalt();
  contaNova.salt = salt;
  contaNova.hashSenha = hashSenha(String(novaSenha), salt);
  contaNova.precisaTrocarSenha = false;
  return { ok: true, data: novo };
}

// ---------- Itens do catálogo ----------

function listarItens(data) {
  return clonar(data.items).sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
}

function adicionarItem(data, { nome, foto, quantidade }) {
  const nomeLimpo = String(nome || '').trim();
  if (!nomeLimpo) return { ok: false, erro: 'Informe o nome do item.' };
  const qtdInicial = Number.isFinite(Number(quantidade)) ? Math.max(0, Math.trunc(Number(quantidade))) : 0;

  const novo = clonar(data);
  const item = {
    id: gerarId('item'),
    nome: nomeLimpo,
    foto: foto || null,
    quantidade: qtdInicial,
    precoUnitario: 0, // definido depois, só pelo admin, na aba "Precificação" (ver definirPrecoItem)
    criadoEm: new Date().toISOString(),
    atualizadoEm: new Date().toISOString(),
  };
  novo.items.push(item);
  return { ok: true, data: novo, item };
}

function editarItem(data, itemId, { nome, foto }) {
  const novo = clonar(data);
  const item = novo.items.find((i) => i.id === itemId);
  if (!item) return { ok: false, erro: 'Item não encontrado.' };
  if (nome !== undefined) {
    const nomeLimpo = String(nome).trim();
    if (!nomeLimpo) return { ok: false, erro: 'Informe o nome do item.' };
    item.nome = nomeLimpo;
  }
  if (foto !== undefined) {
    item.foto = foto;
  }
  item.atualizadoEm = new Date().toISOString();
  return { ok: true, data: novo, item };
}

function removerItem(data, itemId) {
  const novo = clonar(data);
  const existeIdx = novo.items.findIndex((i) => i.id === itemId);
  if (existeIdx === -1) return { ok: false, erro: 'Item não encontrado.' };
  const item = novo.items[existeIdx];

  // Antes de tirar o item do catálogo de vez, "carimba" em TODAS as movimentações dele
  // (não só nas pendentes) o preço unitário que estava valendo até agora. É comum
  // registrar a saída primeiro e só definir o preço depois na Precificação — então o
  // preço "da hora da movimentação" gravado lá atrás (ver `ajustarQuantidade`) pode
  // estar desatualizado ou nem existir ainda. Sem esse carimbo na hora da remoção, uma
  // pendência em aberto desse item perderia o valor (viraria R$ 0,00) assim que ele
  // fosse removido, mesmo tendo um preço válido um segundo antes — é exatamente esse
  // valor "de agora" que passa a sustentar a pendência dali pra frente, já que o item
  // deixa de existir e não há mais um "preço atual" pra consultar (ver
  // `valorTransacaoPendente`).
  const precoNoMomentoDaRemocao =
    Number.isFinite(Number(item.precoUnitario)) && Number(item.precoUnitario) > 0
      ? Number(item.precoUnitario)
      : null;
  novo.transacoes = novo.transacoes.map((t) =>
    t.itemId === itemId ? { ...t, precoUnitarioNaHora: precoNoMomentoDaRemocao } : t
  );

  novo.items.splice(existeIdx, 1);
  return { ok: true, data: novo };
}

// ---------- Usuários (pessoas para quem a quantidade é destinada) ----------
//
// O telefone é sempre obrigatório e é a chave de identificação/duplicidade.
// O nome é opcional: quando ausente, o usuário é identificado pelos últimos
// dígitos do telefone (ex.: "Nº final 1234").

function apenasDigitos(valor) {
  return String(valor || '').replace(/\D/g, '');
}

function final4Telefone(telefone) {
  const digitos = apenasDigitos(telefone);
  if (!digitos) return '????';
  return digitos.slice(-4).padStart(4, '0');
}

/** Nome de exibição: usa o nome cadastrado, ou o final do telefone se não houver nome. */
function nomeOuIdentificador(usuario) {
  if (usuario.nome && String(usuario.nome).trim()) return String(usuario.nome).trim();
  return `Nº final ${final4Telefone(usuario.telefone)}`;
}

/** Rótulo curto para listas/seletores: "Nome (•1234)" ou "Nº final 1234". */
function rotuloUsuario(usuario) {
  if (usuario.nome && String(usuario.nome).trim()) {
    return `${String(usuario.nome).trim()} (•${final4Telefone(usuario.telefone)})`;
  }
  return `Nº final ${final4Telefone(usuario.telefone)}`;
}

/** Usuários favoritos sempre no topo (ver `favoritarUsuario`); dentro de cada grupo, ordem alfabética. */
function listarUsuarios(data) {
  return clonar(data.usuarios).sort((a, b) => {
    const favA = a.favorito ? 1 : 0;
    const favB = b.favorito ? 1 : 0;
    if (favA !== favB) return favB - favA;
    return nomeOuIdentificador(a).localeCompare(nomeOuIdentificador(b), 'pt-BR');
  });
}

function encontrarUsuarioPorTelefone(data, telefone) {
  const alvo = apenasDigitos(telefone);
  if (!alvo) return undefined;
  return data.usuarios.find((u) => apenasDigitos(u.telefone) === alvo);
}

function adicionarUsuario(data, { nome, telefone } = {}) {
  const telefoneLimpo = String(telefone || '').trim();
  const digitos = apenasDigitos(telefoneLimpo);
  if (digitos.length < 8) {
    return { ok: false, erro: 'Informe um telefone válido, com DDD (mínimo 8 dígitos).' };
  }
  if (encontrarUsuarioPorTelefone(data, telefoneLimpo)) {
    return { ok: false, erro: 'Já existe um usuário cadastrado com esse telefone.' };
  }
  const novo = clonar(data);
  const usuario = {
    id: gerarId('usr'),
    nome: nome ? String(nome).trim() : '',
    telefone: telefoneLimpo,
    favorito: false,
    bloqueadoParaDefault: false, // ver `definirBloqueioUsuario`/`adicionarLancamento`/`adicionarPagamento`
    criadoEm: new Date().toISOString(),
  };
  novo.usuarios.push(usuario);
  return { ok: true, data: novo, usuario };
}

/**
 * Edita nome e/ou telefone de um usuário já cadastrado — disponível para os
 * dois perfis (Default só edita "informações", nunca favorito/bloqueio/
 * remoção). Cada campo só é alterado se for enviado (undefined preserva o
 * valor atual). O telefone continua obrigatório e único, igual em
 * `adicionarUsuario`.
 */
function editarUsuario(data, usuarioId, { nome, telefone } = {}) {
  const novo = clonar(data);
  const usuario = novo.usuarios.find((u) => u.id === usuarioId);
  if (!usuario) return { ok: false, erro: 'Usuário não encontrado.' };

  if (telefone !== undefined) {
    const telefoneLimpo = String(telefone || '').trim();
    const digitos = apenasDigitos(telefoneLimpo);
    if (digitos.length < 8) {
      return { ok: false, erro: 'Informe um telefone válido, com DDD (mínimo 8 dígitos).' };
    }
    const outro = encontrarUsuarioPorTelefone(novo, telefoneLimpo);
    if (outro && outro.id !== usuarioId) {
      return { ok: false, erro: 'Já existe um usuário cadastrado com esse telefone.' };
    }
    usuario.telefone = telefoneLimpo;
  }
  if (nome !== undefined) {
    usuario.nome = nome ? String(nome).trim() : '';
  }
  return { ok: true, data: novo, usuario };
}

function removerUsuario(data, usuarioId) {
  const novo = clonar(data);
  const idx = novo.usuarios.findIndex((u) => u.id === usuarioId);
  if (idx === -1) return { ok: false, erro: 'Usuário não encontrado.' };
  novo.usuarios.splice(idx, 1);
  return { ok: true, data: novo };
}

/**
 * Marca/desmarca um usuário como bloqueado para o perfil Default: um
 * usuário bloqueado não pode ter lançamentos avulsos nem pagamentos
 * registrados por quem estiver no perfil Default — o Admin continua livre
 * para agir sobre qualquer usuário, sempre (ver `adicionarLancamento` e
 * `adicionarPagamento`). Ação exclusiva do Admin (checagem de perfil no
 * main.js).
 */
function definirBloqueioUsuario(data, usuarioId, bloqueado) {
  const novo = clonar(data);
  const usuario = novo.usuarios.find((u) => u.id === usuarioId);
  if (!usuario) return { ok: false, erro: 'Usuário não encontrado.' };
  usuario.bloqueadoParaDefault = !!bloqueado;
  return { ok: true, data: novo, usuario };
}

/**
 * Marca/desmarca um usuário como favorito. Usuários favoritos aparecem
 * sempre no topo de qualquer lista de usuários (ver `listarUsuarios`) — em
 * especial no seletor de usuário usado ao movimentar quantidade de um item
 * do catálogo, que é o principal motivo de favoritar alguém.
 */
function favoritarUsuario(data, usuarioId, favorito) {
  const novo = clonar(data);
  const usuario = novo.usuarios.find((u) => u.id === usuarioId);
  if (!usuario) return { ok: false, erro: 'Usuário não encontrado.' };
  usuario.favorito = !!favorito;
  return { ok: true, data: novo, usuario };
}

/**
 * Remove TODOS os usuários cadastrados de uma vez (ação exclusiva do Admin —
 * a checagem de perfil fica no main.js, igual às outras ações de admin).
 * Assim como a remoção individual, o histórico já registrado é mantido: as
 * transações continuam com o nome/telefone do usuário gravados na hora
 * (rótulo "congelado"), só o cadastro em si deixa de existir.
 */
function excluirTodosUsuarios(data) {
  const novo = clonar(data);
  const removidos = novo.usuarios.length;
  novo.usuarios = [];
  return { ok: true, data: novo, removidos };
}

// ---------- Ajuste de quantidade (movimentação) ----------

/**
 * params:
 *  - itemId (obrigatório)
 *  - tipo: 'entrada' | 'saida'
 *  - quantidade: inteiro positivo (a quantidade a somar/subtrair)
 *  - usuarioId: id de usuário existente (opcional)
 *  - usuarioTelefoneNovo: telefone de um novo usuário a cadastrar na hora (opcional;
 *      se já existir um usuário com esse telefone, reaproveita em vez de duplicar)
 *  - usuarioNomeNovo: nome (opcional) do novo usuário acima
 *  - tipoEntrega: 'entrega' | 'retirada' (obrigatório se houver usuário)
 *  - pendente: boolean (opcional; marca que o item ainda não foi pago — só faz
 *      sentido quando há usuário atrelado; ver `definirPendenteTransacao` para
 *      a troca posterior, exclusiva do admin)
 *  - foto: dataURL base64 (opcional; sem usuário só admin pode anexar)
 *  - perfil: 'default' | 'admin' (quem está realizando a ação)
 *  - exigirPreco: boolean (opcional; usado só pela tela de "criar registro em
 *      lote" do Admin — quando true e tipo === 'saida', exige que o item já
 *      tenha um valor unitário definido na aba Precificação; ver
 *      `definirPrecoItem`. Fora dessa tela, nunca é enviado, então o
 *      restante do app — inclusive o card do Catálogo — continua livre)
 *
 * Regras por perfil:
 *  - Admin: livre — entrada/saída com ou sem usuário, novo ou existente.
 *  - Default: só pode fazer SAÍDA (remover quantidade), sempre com um
 *    usuário atrelado; nunca pode fazer entrada (adicionar), nem como
 *    devolução. Se errar uma quantidade, a única correção possível é
 *    desfazer a última movimentação feita por ele NESTA sessão do app (ver
 *    `desfazerTransacao` — some depois que o app é reiniciado).
 */
function ajustarQuantidade(data, params) {
  const { itemId, tipo, usuarioId, usuarioNomeNovo, usuarioTelefoneNovo, tipoEntrega, pendente, foto, perfil, exigirPreco } =
    params;
  const quantidade = Math.trunc(Number(params.quantidade));

  if (!itemId) return { ok: false, erro: 'Item inválido.' };
  if (tipo !== 'entrada' && tipo !== 'saida') return { ok: false, erro: 'Tipo de movimentação inválido.' };
  if (!Number.isFinite(quantidade) || quantidade <= 0) {
    return { ok: false, erro: 'Informe uma quantidade válida (maior que zero).' };
  }

  let novo = clonar(data);
  let item = novo.items.find((i) => i.id === itemId);
  if (!item) return { ok: false, erro: 'Item não encontrado.' };

  // Resolve usuário (existente ou novo cadastro na hora)
  let usuarioFinal = null;
  if (usuarioTelefoneNovo && String(usuarioTelefoneNovo).trim()) {
    const existente = encontrarUsuarioPorTelefone(novo, usuarioTelefoneNovo);
    if (existente) {
      usuarioFinal = existente;
    } else {
      const res = adicionarUsuario(novo, { nome: usuarioNomeNovo, telefone: usuarioTelefoneNovo });
      if (!res.ok) return res;
      novo = res.data;
      // adicionarUsuario clona o `data` internamente e devolve um objeto novo em
      // `res.data` — por isso precisamos reobter a referência do item a partir
      // desse clone. Sem isso, a baixa de estoque feita mais abaixo era aplicada
      // num objeto "órfão" que não fazia mais parte de `novo`, e o primeiro
      // pedido de um usuário recém-criado nunca chegava a descontar o catálogo.
      item = novo.items.find((i) => i.id === itemId);
      usuarioFinal = res.usuario;
    }
  } else if (usuarioId) {
    usuarioFinal = novo.usuarios.find((u) => u.id === usuarioId) || null;
    if (!usuarioFinal) return { ok: false, erro: 'Usuário selecionado não encontrado.' };
  }

  // Regras exclusivas do perfil Default: só pode remover quantidade (nunca
  // adicionar, nem como devolução), e toda saída precisa de um usuário
  // atrelado (retirada por alguém). O Admin não tem essa restrição. Se o
  // Default errar uma quantidade, a correção é desfazer a movimentação (ver
  // `desfazerTransacao`), não fazer uma entrada manual.
  if (perfil !== 'admin') {
    if (tipo === 'entrada') {
      return {
        ok: false,
        erro:
          'O perfil Default não pode adicionar quantidade, só remover. Para corrigir um erro, desfaça a ' +
          'última movimentação feita nesta sessão (disponível até o app ser reiniciado).',
      };
    }
    if (tipo === 'saida' && !usuarioFinal) {
      return { ok: false, erro: 'Para remover quantidade, selecione (ou cadastre) um usuário.' };
    }
  }

  // Entrega ou retirada é obrigatório quando há usuário atribuído
  if (usuarioFinal && tipoEntrega !== 'entrega' && tipoEntrega !== 'retirada') {
    return { ok: false, erro: 'Selecione Entrega ou Retirada.' };
  }

  // Exigência de preço (só a tela de "criar registro em lote" do Admin manda
  // exigirPreco: true) — fora dela, o app inteiro continua livre de preço.
  if (exigirPreco && tipo === 'saida') {
    const precoUnitario = Number(item.precoUnitario);
    if (!Number.isFinite(precoUnitario) || precoUnitario <= 0) {
      return {
        ok: false,
        erro: `Defina um valor unitário para "${item.nome}" na aba Precificação antes de registrar essa saída.`,
      };
    }
  }

  const delta = tipo === 'entrada' ? quantidade : -quantidade;
  const quantidadeResultante = item.quantidade + delta;
  // O limite de "nunca menos que zero" vale só para saída no dia a dia — uma
  // entrada precisa poder recuperar um item que ficou negativo por causa de
  // uma mesclagem de backup (ver aplicarPacoteImportacaoMesclado), então não
  // é bloqueada mesmo que o resultado ainda fique negativo.
  if (tipo === 'saida' && quantidadeResultante < 0) {
    return { ok: false, erro: `Estoque insuficiente. Quantidade atual: ${item.quantidade}.` };
  }

  item.quantidade = quantidadeResultante;
  item.atualizadoEm = new Date().toISOString();

  const agora = new Date();
  // Guarda uma "foto" do preço unitário do item no momento da movimentação. Enquanto o
  // item continuar no catálogo, a Pendências usa o preço ATUAL dele (de propósito — ver
  // `valorTransacaoPendente`); mas se o item for removido do catálogo mais tarde, não
  // existe mais um "preço atual" pra consultar, e é esse valor aqui que evita que a
  // pendência/valor do histórico dessa movimentação vire R$ 0,00 só por causa da remoção.
  const precoUnitarioNaHora =
    Number.isFinite(Number(item.precoUnitario)) && Number(item.precoUnitario) > 0
      ? Number(item.precoUnitario)
      : null;
  const transacao = {
    id: gerarId('mov'),
    itemId: item.id,
    itemNome: item.nome,
    tipo,
    quantidade,
    quantidadeResultante,
    precoUnitarioNaHora,
    usuarioId: usuarioFinal ? usuarioFinal.id : null,
    usuarioNome: usuarioFinal ? rotuloUsuario(usuarioFinal) : null,
    usuarioTelefone: usuarioFinal ? usuarioFinal.telefone : null,
    tipoEntrega: usuarioFinal ? tipoEntrega : null,
    // Só faz sentido pendência quando há usuário envolvido. E quando é o perfil Default
    // criando o registro, ele nasce SEMPRE pendente — o Default não tem como marcar como já
    // pago na hora; só o Admin confirma depois (ver `definirPendenteTransacao`). O Admin
    // continua livre pra escolher, como sempre.
    pendente: usuarioFinal ? (perfil === 'admin' ? !!pendente : true) : false,
    marcadoRecebidoDefault: false, // controle informal do Default (ver `marcarRecebidoDefaultTransacao`) — não afeta a pendência de verdade
    foto: foto || null,
    perfil: perfil === 'admin' ? 'admin' : 'default',
    dataHoraISO: agora.toISOString(),
    dataDia: hojeISO(agora),
    importado: false, // movimentação feita direto no app, não veio de um backup importado
  };
  novo.transacoes.push(transacao);

  return { ok: true, data: novo, item, transacao };
}

/**
 * Desfaz uma movimentação de SAÍDA específica: apaga o registro do
 * histórico e devolve a quantidade retirada de volta ao item no catálogo.
 * Diferente de `excluirTransacoes`/`excluirTodoHistorico` (que só apagam o
 * registro/log, sem recalcular quantidade) — este é o mecanismo usado pelo
 * "desfazer última movimentação" do perfil Default (a única forma dele
 * corrigir um erro de quantidade, já que ele não pode fazer entrada). Quem
 * decide QUAL id pode ser desfeito e até quando (só a própria última
 * movimentação, só na sessão atual do app) é o processo principal
 * (main.js) — esta função só executa o desfazimento em si.
 */
function desfazerTransacao(data, transacaoId) {
  const novo = clonar(data);
  const idx = novo.transacoes.findIndex((t) => t.id === transacaoId);
  if (idx === -1) {
    return { ok: false, erro: 'Essa movimentação não existe mais (pode já ter sido desfeita ou excluída).' };
  }
  const transacao = novo.transacoes[idx];
  if (transacao.tipo !== 'saida') {
    return { ok: false, erro: 'Só é possível desfazer uma remoção (saída) de quantidade.' };
  }
  const item = novo.items.find((i) => i.id === transacao.itemId);
  if (!item) {
    return { ok: false, erro: 'O item dessa movimentação não existe mais no catálogo.' };
  }
  item.quantidade += transacao.quantidade;
  item.atualizadoEm = new Date().toISOString();
  novo.transacoes.splice(idx, 1);
  return { ok: true, data: novo, item, transacaoDesfeita: transacao };
}

/**
 * Marca/desmarca uma movimentação como "Pendente" (pagamento ainda não
 * feito) ou "Concluído". Ação exclusiva do Admin (a checagem de perfil fica
 * no main.js) e funciona nos dois sentidos: tanto para marcar um registro
 * concluído como pendente, quanto o contrário — diferente do "desfazer" do
 * Default, isso não mexe em quantidade nenhuma, só na etiqueta de status.
 */
function definirPendenteTransacao(data, transacaoId, pendente) {
  const novo = clonar(data);
  const transacao = novo.transacoes.find((t) => t.id === transacaoId);
  if (!transacao) return { ok: false, erro: 'Essa movimentação não existe mais no histórico.' };
  transacao.pendente = !!pendente;
  // É o Admin confirmando de verdade (essa função é exclusiva dele, checado no main.js) —
  // a partir daqui a marcação informal do Default não tem mais sentido, some junto.
  transacao.marcadoRecebidoDefault = false;
  return { ok: true, data: novo, transacao };
}

/**
 * Controle INFORMAL do perfil Default sobre uma movimentação pendente: ele pode "flegar" como
 * recebido/pago pra se organizar, mas isso NUNCA muda `pendente` de verdade — o registro
 * continua contando na pendência do usuário até o Admin confirmar de fato (ver
 * `definirPendenteTransacao`, que é quem realmente resolve e some com a pendência). Serve só
 * como um sinalizador pro Admin bater o olho e saber o que o Default já diz que foi recebido.
 */
function marcarRecebidoDefaultTransacao(data, transacaoId, marcado) {
  const novo = clonar(data);
  const transacao = novo.transacoes.find((t) => t.id === transacaoId);
  if (!transacao) return { ok: false, erro: 'Essa movimentação não existe mais no histórico.' };
  transacao.marcadoRecebidoDefault = !!marcado;
  return { ok: true, data: novo, transacao };
}

// ---------- Histórico ----------

/**
 * Dias com QUALQUER registro no Histórico: movimentações de item, lançamentos
 * avulsos ou pagamentos — assim um dia em que só houve um pagamento (sem
 * nenhuma movimentação de item) continua aparecendo no seletor de dia.
 */
function listarDiasComMovimentacao(data) {
  const dias = new Set(data.transacoes.map((t) => t.dataDia));
  (data.lancamentos || []).forEach((l) => dias.add(l.dataDia));
  (data.pagamentos || []).forEach((p) => dias.add(p.dataDia));
  return Array.from(dias).sort((a, b) => (a < b ? 1 : -1)); // mais recente primeiro
}

function listarTransacoesPorDia(data, dia) {
  return clonar(data.transacoes)
    .filter((t) => t.dataDia === dia)
    .sort((a, b) => (a.dataHoraISO < b.dataHoraISO ? 1 : -1));
}

/**
 * Todo o histórico de movimentações, mais recente primeiro — igual a
 * `listarTransacoesPorDia`, mas sem prender a um único dia: `dataInicio`/
 * `dataFim` são OPCIONAIS (ver `dentroDoPeriodo`) e, sem nenhum dos dois,
 * traz TUDO. É o que a aba Histórico usa por padrão (mostra o histórico
 * inteiro); informar um período ali é só um filtro opcional por cima disso.
 */
function listarHistoricoPorPeriodo(data, dataInicio, dataFim) {
  return clonar(data.transacoes)
    .filter((t) => dentroDoPeriodo(t.dataDia, dataInicio || null, dataFim || null))
    .sort((a, b) => (a.dataHoraISO < b.dataHoraISO ? 1 : -1));
}

/**
 * Remove TODO o histórico de movimentações de uma vez (ação exclusiva do
 * Admin — a checagem de perfil fica no main.js). Só apaga o registro/log:
 * não recalcula a quantidade atual dos itens, que continua sendo o que já
 * está gravado no catálogo (apagar o histórico não "desfaz" movimentações).
 */
/**
 * Desfaz na quantidade atual do item o efeito de uma transação que está sendo
 * removida do histórico: uma "saida" devolve a quantidade retirada, uma
 * "entrada" desconta de volta a quantidade que tinha sido somada. Se o item
 * já não existir mais no catálogo, não há o que reverter (mesma regra usada
 * em "pendência de item removido" — o histórico dele fica só como registro).
 */
function reverterEfeitoDeTransacaoNoItem(novo, transacao) {
  const item = novo.items.find((i) => i.id === transacao.itemId);
  if (!item) return;
  if (transacao.tipo === 'saida') {
    item.quantidade += transacao.quantidade;
  } else if (transacao.tipo === 'entrada') {
    item.quantidade -= transacao.quantidade;
  }
  item.atualizadoEm = new Date().toISOString();
}

/**
 * Apaga TODO o histórico de movimentações de uma vez (ação exclusiva do
 * Admin — a checagem de perfil fica no main.js). Diferente do "Desfazer"
 * do Default (que só desfaz a própria última movimentação da sessão),
 * excluir do histórico DEVOLVE a quantidade de cada movimentação removida
 * pro item correspondente — é a forma do Admin corrigir o catálogo ao
 * limpar registros indevidos, então a quantidade atual dos itens é
 * recalculada para refletir a remoção.
 */
function excluirTodoHistorico(data) {
  const novo = clonar(data);
  const removidos = novo.transacoes.length;
  for (const t of novo.transacoes) {
    reverterEfeitoDeTransacaoNoItem(novo, t);
  }
  novo.transacoes = [];
  return { ok: true, data: novo, removidos };
}

/**
 * Remove só as movimentações selecionadas (pelos ids), mantendo o restante
 * do histórico intacto (ação exclusiva do Admin). Mesma regra de
 * `excluirTodoHistorico`: a quantidade de cada uma é devolvida ao item
 * correspondente antes do registro sumir do histórico.
 */
function excluirTransacoes(data, idsTransacoes) {
  const idsValidos = new Set(Array.isArray(idsTransacoes) ? idsTransacoes.filter(Boolean) : []);
  if (idsValidos.size === 0) {
    return { ok: false, erro: 'Selecione ao menos uma movimentação para excluir.' };
  }
  const novo = clonar(data);
  const aRemover = novo.transacoes.filter((t) => idsValidos.has(t.id));
  if (aRemover.length === 0) {
    return { ok: false, erro: 'Nenhuma das movimentações selecionadas foi encontrada no histórico.' };
  }
  for (const t of aRemover) {
    reverterEfeitoDeTransacaoNoItem(novo, t);
  }
  novo.transacoes = novo.transacoes.filter((t) => !idsValidos.has(t.id));
  return { ok: true, data: novo, removidos: aRemover.length };
}

/** true se `diaISO` (YYYY-MM-DD) está dentro de [dataInicio, dataFim]; limites nulos = sem restrição. */
function dentroDoPeriodo(diaISO, dataInicio, dataFim) {
  if (dataInicio && diaISO < dataInicio) return false;
  if (dataFim && diaISO > dataFim) return false;
  return true;
}

// ---------- Histórico por item ----------

/** Todas as movimentações de um item específico (com data sempre incluída), opcionalmente por período. */
function listarHistoricoDoItem(data, itemId, dataInicio, dataFim) {
  return clonar(data.transacoes)
    .filter((t) => t.itemId === itemId)
    .filter((t) => dentroDoPeriodo(t.dataDia, dataInicio, dataFim))
    .sort((a, b) => (a.dataHoraISO < b.dataHoraISO ? 1 : -1));
}

/** Resumo de um item no período: totais de entrada/saída e usuários envolvidos. */
function consultarPorItem(data, itemId, dataInicio, dataFim) {
  const item = data.items.find((i) => i.id === itemId) || null;
  const transacoes = listarHistoricoDoItem(data, itemId, dataInicio, dataFim);

  let totalEntrada = 0;
  let totalSaida = 0;
  const usuariosMap = new Map();

  for (const t of transacoes) {
    if (t.tipo === 'entrada') totalEntrada += t.quantidade;
    else totalSaida += t.quantidade;

    if (t.usuarioId) {
      if (!usuariosMap.has(t.usuarioId)) {
        usuariosMap.set(t.usuarioId, { usuarioId: t.usuarioId, usuarioNome: t.usuarioNome, totalRecebido: 0 });
      }
      if (t.tipo === 'saida') usuariosMap.get(t.usuarioId).totalRecebido += t.quantidade;
    }
  }

  return {
    itemId,
    itemNome: item ? item.nome : (transacoes[0] ? transacoes[0].itemNome : ''),
    quantidadeAtual: item ? item.quantidade : null,
    totalEntrada,
    totalSaida,
    usuariosEnvolvidos: Array.from(usuariosMap.values()).sort((a, b) => b.totalRecebido - a.totalRecebido),
    transacoes,
  };
}

// ---------- Consulta por usuário ----------

/** Todas as movimentações de um usuário no período, com a soma por item do catálogo. */
function consultarPorUsuario(data, usuarioId, dataInicio, dataFim) {
  const transacoes = clonar(data.transacoes)
    .filter((t) => t.usuarioId === usuarioId)
    .filter((t) => dentroDoPeriodo(t.dataDia, dataInicio, dataFim))
    .sort((a, b) => (a.dataHoraISO < b.dataHoraISO ? 1 : -1));

  const somaPorItemMap = new Map();
  for (const t of transacoes) {
    if (!somaPorItemMap.has(t.itemId)) {
      somaPorItemMap.set(t.itemId, { itemId: t.itemId, itemNome: t.itemNome, totalEntrada: 0, totalSaida: 0 });
    }
    const agregado = somaPorItemMap.get(t.itemId);
    if (t.tipo === 'entrada') agregado.totalEntrada += t.quantidade;
    else agregado.totalSaida += t.quantidade;
  }
  const somaPorItem = Array.from(somaPorItemMap.values())
    .map((a) => ({ ...a, saldoLiquido: a.totalEntrada - a.totalSaida }))
    .sort((a, b) => a.itemNome.localeCompare(b.itemNome, 'pt-BR'));

  const lancamentos = clonar(data.lancamentos || [])
    .filter((l) => l.usuarioId === usuarioId)
    .filter((l) => dentroDoPeriodo(l.dataDia, dataInicio, dataFim))
    .sort((a, b) => (a.dataHoraISO < b.dataHoraISO ? 1 : -1));

  return { usuarioId, transacoes, somaPorItem, lancamentos };
}

// ---------- Lançamentos avulsos (valor + observação, sem item — exclusivo do Admin) ----------
//
// Além das movimentações de item (transacoes), o Admin pode registrar uma
// pendência de valor pura pra um usuário — sem vincular a nenhum item do
// catálogo, só um valor em reais e uma observação (ex.: uma cobrança avulsa,
// um ajuste). Igual às transações com usuário, nasce "pendente" por padrão;
// o Admin pode marcar como concluído depois (e voltar a pendente, se
// precisar), do mesmo jeito que faz com uma movimentação (ver
// `definirPendenteTransacao`).

/** Cria um lançamento avulso (ação exclusiva do Admin — checagem de perfil no main.js). */
/**
 * Cria um lançamento avulso. O valor pode ser negativo — funciona como um crédito/desconto
 * (abate a pendência do usuário, igual a um pagamento, mas registrado como lançamento) — ou
 * positivo, uma cobrança normal que soma à pendência.
 *
 * Regra por perfil, pra um usuário marcado como bloqueado pelo Admin
 * (`usuario.bloqueadoParaDefault` — ver `definirBloqueioUsuario`): o perfil Default só pode
 * lançar valores NEGATIVOS (créditos) pra ele, nunca uma cobrança nova; o Admin continua livre,
 * sempre, pra qualquer usuário, bloqueado ou não.
 */
function adicionarLancamento(data, { usuarioId, valor, observacao, perfil } = {}) {
  const usuario = data.usuarios.find((u) => u.id === usuarioId);
  if (!usuario) return { ok: false, erro: 'Usuário não encontrado.' };
  const valorNum = Number(valor);
  if (!Number.isFinite(valorNum) || valorNum === 0) {
    return { ok: false, erro: 'Informe um valor diferente de zero (negativo funciona como um crédito/desconto).' };
  }
  const bloqueadoParaEsteLancamento = perfil !== 'admin' && usuario.bloqueadoParaDefault;
  if (bloqueadoParaEsteLancamento && valorNum > 0) {
    return {
      ok: false,
      erro: 'O Admin bloqueou esse usuário: o perfil Default só pode lançar valores negativos (créditos) para ele.',
    };
  }
  const novo = clonar(data);
  const agora = new Date();
  const lancamento = {
    id: gerarId('lanc'),
    usuarioId: usuario.id,
    usuarioNome: rotuloUsuario(usuario),
    usuarioTelefone: usuario.telefone,
    valor: Math.round(valorNum * 100) / 100,
    observacao: observacao ? String(observacao).trim().slice(0, 500) : '',
    pendente: true, // nasce como pendência; só o Admin confirma/marca como concluído de verdade
    marcadoRecebidoDefault: false, // controle informal do Default (ver `marcarRecebidoDefaultLancamento`) — não afeta a pendência de verdade
    dataHoraISO: agora.toISOString(),
    dataDia: hojeISO(agora),
  };
  if (!Array.isArray(novo.lancamentos)) novo.lancamentos = [];
  novo.lancamentos.push(lancamento);
  return { ok: true, data: novo, lancamento };
}

/** Todos os lançamentos avulsos de um usuário (mais recente primeiro). */
function listarLancamentosPorUsuario(data, usuarioId) {
  return clonar(data.lancamentos || [])
    .filter((l) => l.usuarioId === usuarioId)
    .sort((a, b) => (a.dataHoraISO < b.dataHoraISO ? 1 : -1));
}

/**
 * Marca/desmarca um lançamento avulso como pendente — funciona nos dois
 * sentidos e é exclusivo do Admin, igual ao `definirPendenteTransacao`.
 */
function definirPendenteLancamento(data, lancamentoId, pendente) {
  const novo = clonar(data);
  const lancamento = (novo.lancamentos || []).find((l) => l.id === lancamentoId);
  if (!lancamento) return { ok: false, erro: 'Esse lançamento não existe mais.' };
  lancamento.pendente = !!pendente;
  // Confirmação de verdade, exclusiva do Admin (checado no main.js) — a marcação informal
  // do Default deixa de fazer sentido a partir daqui.
  lancamento.marcadoRecebidoDefault = false;
  return { ok: true, data: novo, lancamento };
}

/**
 * Mesmo controle informal de `marcarRecebidoDefaultTransacao`, só que para um lançamento
 * avulso: o Default pode flegar como recebido pra se organizar, mas quem resolve a pendência
 * de verdade continua sendo só o Admin, via `definirPendenteLancamento`.
 */
function marcarRecebidoDefaultLancamento(data, lancamentoId, marcado) {
  const novo = clonar(data);
  const lancamento = (novo.lancamentos || []).find((l) => l.id === lancamentoId);
  if (!lancamento) return { ok: false, erro: 'Esse lançamento não existe mais.' };
  lancamento.marcadoRecebidoDefault = !!marcado;
  return { ok: true, data: novo, lancamento };
}

/**
 * Edita valor e/ou observação de um lançamento avulso já criado — disponível para os dois
 * perfis, para qualquer usuário (inclusive um bloqueado: editar um registro já existente não
 * tem a mesma restrição de sinal que criar um novo, ver `adicionarLancamento`). Cada campo só é
 * alterado se for enviado (undefined preserva o valor atual). O valor pode ser negativo (crédito).
 */
function editarLancamento(data, lancamentoId, { valor, observacao } = {}) {
  const novo = clonar(data);
  const lancamento = (novo.lancamentos || []).find((l) => l.id === lancamentoId);
  if (!lancamento) return { ok: false, erro: 'Esse lançamento não existe mais.' };
  if (valor !== undefined) {
    const valorNum = Number(valor);
    if (!Number.isFinite(valorNum) || valorNum === 0) {
      return { ok: false, erro: 'Informe um valor diferente de zero (negativo funciona como um crédito/desconto).' };
    }
    lancamento.valor = Math.round(valorNum * 100) / 100;
  }
  if (observacao !== undefined) {
    lancamento.observacao = String(observacao || '').trim().slice(0, 500);
  }
  return { ok: true, data: novo, lancamento };
}

/** Remove definitivamente um lançamento avulso (ação exclusiva do Admin — checagem de perfil no main.js). */
function removerLancamento(data, lancamentoId) {
  const novo = clonar(data);
  const idx = (novo.lancamentos || []).findIndex((l) => l.id === lancamentoId);
  if (idx === -1) return { ok: false, erro: 'Esse lançamento não existe mais.' };
  novo.lancamentos.splice(idx, 1);
  return { ok: true, data: novo };
}

// ---------- Pagamentos (abatem a pendência de um usuário, sem vincular a item) ----------
//
// Diferente dos lançamentos avulsos (que representam uma nova pendência, e podem ser
// negativos — um crédito), um pagamento representa dinheiro RECEBIDO de verdade do
// usuário, então seu valor é sempre positivo. Serve só para abater o total pendente
// calculado na aba "Pendências" (ver `listarUsuariosPendentes` / `detalharPendenciasUsuario`)
// — ele NÃO altera o status Pendente/Concluído de nenhuma transação ou lançamento específico
// (isso continua sendo feito manualmente, item por item, como já funcionava). Todo pagamento
// exige um comentário. Os dois perfis podem criar um pagamento (exceto para um usuário
// bloqueado pelo Admin, que fica exclusivo do Admin — ver `definirBloqueioUsuario`) e editar um
// já existente; excluir continua exclusivo do Admin (checagem de perfil no main.js).

function adicionarPagamento(data, { usuarioId, valor, observacao, perfil } = {}) {
  const usuario = data.usuarios.find((u) => u.id === usuarioId);
  if (!usuario) return { ok: false, erro: 'Usuário não encontrado.' };
  if (perfil !== 'admin' && usuario.bloqueadoParaDefault) {
    return { ok: false, erro: 'O Admin bloqueou esse usuário: só o Admin pode registrar pagamentos para ele.' };
  }
  const valorNum = Number(valor);
  if (!Number.isFinite(valorNum) || valorNum <= 0) {
    return { ok: false, erro: 'Informe um valor válido (maior que zero).' };
  }
  const observacaoLimpa = String(observacao || '').trim();
  if (!observacaoLimpa) {
    return { ok: false, erro: 'Informe um comentário para o pagamento (ex.: forma de pagamento combinada).' };
  }
  const novo = clonar(data);
  const agora = new Date();
  const pagamento = {
    id: gerarId('pag'),
    usuarioId: usuario.id,
    usuarioNome: rotuloUsuario(usuario),
    usuarioTelefone: usuario.telefone,
    valor: Math.round(valorNum * 100) / 100,
    observacao: observacaoLimpa.slice(0, 500),
    dataHoraISO: agora.toISOString(),
    dataDia: hojeISO(agora),
  };
  if (!Array.isArray(novo.pagamentos)) novo.pagamentos = [];
  novo.pagamentos.push(pagamento);
  return { ok: true, data: novo, pagamento };
}

/** Todos os pagamentos de um usuário (mais recente primeiro). */
function listarPagamentosPorUsuario(data, usuarioId) {
  return clonar(data.pagamentos || [])
    .filter((p) => p.usuarioId === usuarioId)
    .sort((a, b) => (a.dataHoraISO < b.dataHoraISO ? 1 : -1));
}

/**
 * Edita valor e/ou comentário de um pagamento já registrado — disponível para os dois perfis,
 * para qualquer usuário (ver `adicionarPagamento`/`editarLancamento` pra o mesmo tipo de
 * abertura). O comentário continua obrigatório: não pode ser esvaziado numa edição. Diferente
 * do lançamento avulso, o valor de um pagamento continua tendo que ser positivo — é sempre um
 * recebimento de verdade, não um crédito/ajuste.
 */
function editarPagamento(data, pagamentoId, { valor, observacao } = {}) {
  const novo = clonar(data);
  const pagamento = (novo.pagamentos || []).find((p) => p.id === pagamentoId);
  if (!pagamento) return { ok: false, erro: 'Esse pagamento não existe mais.' };
  if (valor !== undefined) {
    const valorNum = Number(valor);
    if (!Number.isFinite(valorNum) || valorNum <= 0) {
      return { ok: false, erro: 'Informe um valor válido (maior que zero).' };
    }
    pagamento.valor = Math.round(valorNum * 100) / 100;
  }
  if (observacao !== undefined) {
    const observacaoLimpa = String(observacao || '').trim();
    if (!observacaoLimpa) {
      return { ok: false, erro: 'O comentário do pagamento não pode ficar vazio.' };
    }
    pagamento.observacao = observacaoLimpa.slice(0, 500);
  }
  return { ok: true, data: novo, pagamento };
}

/** Remove definitivamente um pagamento (ação exclusiva do Admin — checagem de perfil no main.js). */
function removerPagamento(data, pagamentoId) {
  const novo = clonar(data);
  const idx = (novo.pagamentos || []).findIndex((p) => p.id === pagamentoId);
  if (idx === -1) return { ok: false, erro: 'Esse pagamento não existe mais.' };
  novo.pagamentos.splice(idx, 1);
  return { ok: true, data: novo };
}

/**
 * Remove TODOS os lançamentos avulsos e pagamentos de uma vez (ação
 * exclusiva do Admin — checagem de perfil no main.js). Só apaga esses dois
 * registros: não mexe nas movimentações de item (`transacoes`), que têm seu
 * próprio "excluir todo o histórico" (ver `excluirTodoHistorico`).
 */
function excluirTodosLancamentosEPagamentos(data) {
  const novo = clonar(data);
  const removidosLancamentos = (novo.lancamentos || []).length;
  const removidosPagamentos = (novo.pagamentos || []).length;
  novo.lancamentos = [];
  novo.pagamentos = [];
  return { ok: true, data: novo, removidosLancamentos, removidosPagamentos };
}

/** Lançamentos avulsos e pagamentos de um dia específico, juntos (usado na aba Histórico). */
function listarLancamentosEPagamentosPorDia(data, dia) {
  const lancamentos = (data.lancamentos || [])
    .filter((l) => l.dataDia === dia)
    .map((l) => ({ ...l, tipoRegistro: 'lancamento' }));
  const pagamentos = (data.pagamentos || [])
    .filter((p) => p.dataDia === dia)
    .map((p) => ({ ...p, tipoRegistro: 'pagamento' }));
  return [...lancamentos, ...pagamentos].sort((a, b) => (a.dataHoraISO < b.dataHoraISO ? 1 : -1));
}

/**
 * Mesma ideia de `listarLancamentosEPagamentosPorDia`, mas sem prender a um único dia —
 * `dataInicio`/`dataFim` opcionais, sem nenhum dos dois traz tudo (ver `listarHistoricoPorPeriodo`).
 */
function listarLancamentosEPagamentosPorPeriodo(data, dataInicio, dataFim) {
  const lancamentos = (data.lancamentos || [])
    .filter((l) => dentroDoPeriodo(l.dataDia, dataInicio || null, dataFim || null))
    .map((l) => ({ ...l, tipoRegistro: 'lancamento' }));
  const pagamentos = (data.pagamentos || [])
    .filter((p) => dentroDoPeriodo(p.dataDia, dataInicio || null, dataFim || null))
    .map((p) => ({ ...p, tipoRegistro: 'pagamento' }));
  return [...lancamentos, ...pagamentos].sort((a, b) => (a.dataHoraISO < b.dataHoraISO ? 1 : -1));
}

// ---------- Pendências (visão consolidada por usuário: quanto falta receber) ----------
//
// Reúne, por usuário, tudo que ainda está pendente — saídas de item marcadas
// como pendente (ver `definirPendenteTransacao`) e lançamentos avulsos
// pendentes (ver `adicionarLancamento`) — menos os pagamentos já registrados
// (ver `adicionarPagamento`). Um pagamento só abate o TOTAL mostrado aqui;
// ele não marca nenhuma transação/lançamento individual como concluído.

/**
 * Preço unitário (R$) a considerar pra uma transação de saída. Enquanto o item ainda
 * existir no catálogo, usa o preço unitário ATUAL dele (de propósito — pode ter sido
 * corrigido na Precificação depois da movimentação, e uma pendência em aberto deve
 * refletir isso). Se o item já foi removido do catálogo, não há mais "preço atual" —
 * cai pro último preço conhecido antes da remoção (`precoUnitarioNaHora`, ver
 * `removerItem`), pra o valor não sumir (virar R$ 0,00) só porque o item foi excluído.
 * Usada tanto pela Pendências (`valorTransacaoPendente`) quanto pelo relatório de
 * pedidos em PDF (`listarPedidosParaRelatorio`).
 */
function precoUnitarioParaTransacao(data, transacao) {
  const item = data.items.find((i) => i.id === transacao.itemId);
  return item ? Number(item.precoUnitario) || 0 : Number(transacao.precoUnitarioNaHora) || 0;
}

/** Valor (R$) de uma saída pendente — ver `precoUnitarioParaTransacao`. */
function valorTransacaoPendente(data, transacao) {
  return arredondarValor(transacao.quantidade * precoUnitarioParaTransacao(data, transacao));
}

/**
 * Detalhamento completo da pendência de um usuário: cada transação/lançamento
 * ainda pendente, cada pagamento já feito, e os totais (pendências, pagamentos
 * e o saldo = pendências − pagamentos).
 */
function detalharPendenciasUsuario(data, usuarioId) {
  const usuario = data.usuarios.find((u) => u.id === usuarioId);

  const pendencias = [];
  for (const t of data.transacoes) {
    if (t.usuarioId !== usuarioId || t.tipo !== 'saida' || !t.pendente) continue;
    pendencias.push({
      tipo: 'transacao',
      id: t.id,
      descricao: t.itemNome,
      quantidade: t.quantidade,
      valor: valorTransacaoPendente(data, t),
      dataHoraISO: t.dataHoraISO,
      dataDia: t.dataDia,
    });
  }
  for (const l of data.lancamentos || []) {
    if (l.usuarioId !== usuarioId || !l.pendente) continue;
    pendencias.push({
      tipo: 'lancamento',
      id: l.id,
      descricao: l.observacao || 'Lançamento avulso',
      quantidade: null,
      valor: l.valor,
      dataHoraISO: l.dataHoraISO,
      dataDia: l.dataDia,
    });
  }
  pendencias.sort((a, b) => (a.dataHoraISO < b.dataHoraISO ? 1 : -1));

  const pagamentos = listarPagamentosPorUsuario(data, usuarioId);
  const totalPendencias = arredondarValor(pendencias.reduce((soma, p) => soma + p.valor, 0));
  const totalPagamentos = arredondarValor(pagamentos.reduce((soma, p) => soma + p.valor, 0));
  const totalPendente = arredondarValor(totalPendencias - totalPagamentos);

  return {
    usuarioId,
    usuarioNome: usuario ? rotuloUsuario(usuario) : null,
    usuarioTelefone: usuario ? usuario.telefone : null,
    bloqueadoParaDefault: usuario ? !!usuario.bloqueadoParaDefault : false,
    pendencias,
    pagamentos,
    totalPendencias,
    totalPagamentos,
    totalPendente,
  };
}

/** Só os usuários com pendência (saldo > 0), do maior para o menor saldo — usado na aba "Pendências". */
function listarUsuariosPendentes(data) {
  return data.usuarios
    .map((usuario) => {
      const detalhe = detalharPendenciasUsuario(data, usuario.id);
      return {
        usuarioId: usuario.id,
        usuarioNome: rotuloUsuario(usuario),
        usuarioTelefone: usuario.telefone,
        totalPendente: detalhe.totalPendente,
      };
    })
    .filter((l) => l.totalPendente > 0)
    .sort((a, b) => b.totalPendente - a.totalPendente);
}

/**
 * Usuários que já tiveram alguma pendência paga: saldo pendente atual zerado (ou negativo, o
 * que não deveria acontecer, mas por segurança também não entra) e pelo menos um pagamento já
 * registrado alguma vez — a "segunda coluna" da aba Pendências, ao lado dos que ainda devem.
 * Não é uma marcação guardada à parte — é calculado na hora a partir do mesmo saldo de
 * `detalharPendenciasUsuario`, então some da lista automaticamente se o usuário voltar a ter
 * pendência. Quem nunca teve pendência nenhuma (nunca precisou pagar nada) não aparece aqui.
 */
function listarUsuariosQuitados(data) {
  return data.usuarios
    .map((usuario) => detalharPendenciasUsuario(data, usuario.id))
    .filter((d) => d.totalPagamentos > 0 && d.totalPendente <= 0)
    .map((d) => ({
      usuarioId: d.usuarioId,
      usuarioNome: d.usuarioNome,
      usuarioTelefone: d.usuarioTelefone,
      totalPago: d.totalPagamentos,
    }))
    .sort((a, b) => b.totalPago - a.totalPago);
}

/**
 * Totais agregados de pendências, somando TODOS os usuários (pendentes e já quitados) — o card
 * de resumo geral no topo da aba "Pendências", visível tanto pro Admin quanto pro Default (os
 * totais individuais, por usuário, já eram visíveis aos dois em `detalharPendenciasUsuario`; este
 * é só a soma de todo mundo junto). `totalPendencias` é a soma de tudo que já precisou ser pago
 * (pago ou não); `totalPagamentos`, a soma de tudo que já foi pago; `totalPendente`, o saldo geral
 * ainda em aberto (a diferença entre os dois).
 */
function totalizarPendencias(data) {
  let totalPendencias = 0;
  let totalPagamentos = 0;
  for (const usuario of data.usuarios) {
    const detalhe = detalharPendenciasUsuario(data, usuario.id);
    totalPendencias += detalhe.totalPendencias;
    totalPagamentos += detalhe.totalPagamentos;
  }
  totalPendencias = arredondarValor(totalPendencias);
  totalPagamentos = arredondarValor(totalPagamentos);
  return {
    totalPendencias,
    totalPagamentos,
    totalPendente: arredondarValor(totalPendencias - totalPagamentos),
  };
}

/**
 * Quita de vez a pendência de um usuário: registra um pagamento no valor EXATO do saldo
 * pendente atual dele (ver `detalharPendenciasUsuario`), zerando o saldo numa tacada só —
 * o botão "Marcar como pago" da aba Pendências, pra não precisar digitar o valor manualmente
 * nem marcar pendência por pendência. Ação exclusiva do Admin (checagem de perfil feita no
 * main.js, mesma regra de sempre: só o Admin resolve uma pendência de verdade — ver
 * `definirPendenteTransacao`/`definirPendenteLancamento`); por isso ignora o bloqueio de
 * usuário (`bloqueadoParaDefault`), que só vale pro Default.
 */
function quitarPendenciaUsuario(data, usuarioId, comentario) {
  const usuario = data.usuarios.find((u) => u.id === usuarioId);
  if (!usuario) return { ok: false, erro: 'Usuário não encontrado.' };

  const detalhe = detalharPendenciasUsuario(data, usuarioId);
  if (detalhe.totalPendente <= 0) {
    return { ok: false, erro: 'Esse usuário não tem saldo pendente pra quitar.' };
  }

  return adicionarPagamento(data, {
    usuarioId,
    valor: detalhe.totalPendente,
    observacao: (comentario && String(comentario).trim()) || 'Quitação total via aba Pendências',
    perfil: 'admin',
  });
}

// ---------- Relatório de pedidos em PDF ----------
//
// "Pedidos" aqui são as saídas de item (retiradas) — cada uma com o item, o usuário (se
// houver) e o valor precificado (quantidade x preço unitário, pela mesma regra de
// `precoUnitarioParaTransacao` usada nas Pendências: preço atual do item, ou o preço
// congelado se o item já foi removido). Usado pelo botão "Gerar PDF" da aba Histórico —
// ver `montarHtmlRelatorioPedidos`/`ipcMain.handle('relatorio:gerarPdfPedidos', ...)` em
// main.js. Por padrão cobre só o dia selecionado no Histórico, mas dataInicio/dataFim
// aceitam qualquer período (o modal de geração deixa personalizar o intervalo).

/**
 * Pedidos (saídas de item) num período, com o valor precificado de cada um, o total
 * geral e o total por item (`porItem` — quantidade e valor somados de cada item que
 * saiu, do que mais saiu pro que menos saiu) — dados prontos pro relatório em PDF.
 * `dataInicio`/`dataFim` são strings 'YYYY-MM-DD' (ambas opcionais; omitidas = sem
 * limite naquela ponta, ver `dentroDoPeriodo`).
 */
function listarPedidosParaRelatorio(data, dataInicio, dataFim) {
  const pedidos = data.transacoes
    .filter((t) => t.tipo === 'saida')
    .filter((t) => dentroDoPeriodo(t.dataDia, dataInicio, dataFim))
    .map((t) => {
      const precoUnitario = precoUnitarioParaTransacao(data, t);
      return {
        id: t.id,
        dataHoraISO: t.dataHoraISO,
        dataDia: t.dataDia,
        itemNome: t.itemNome,
        quantidade: t.quantidade,
        usuarioNome: t.usuarioNome || null,
        tipoEntrega: t.tipoEntrega || null,
        pendente: !!t.pendente,
        precoUnitario,
        valorTotal: arredondarValor(t.quantidade * precoUnitario),
      };
    })
    // Cronológico (mais antigo primeiro) — diferente da tela de Histórico (mais recente
    // primeiro), mas é a ordem que se espera ler num relatório impresso, de cima pra baixo.
    .sort((a, b) => (a.dataHoraISO < b.dataHoraISO ? -1 : 1));

  const totalQuantidade = pedidos.reduce((soma, p) => soma + p.quantidade, 0);
  const totalValor = arredondarValor(pedidos.reduce((soma, p) => soma + p.valorTotal, 0));

  // Total de cada item que saiu no período (soma de quantidade e valor de todos os
  // pedidos daquele item) — a tabela-resumo do relatório em PDF, além do detalhe
  // linha a linha acima. Do item que mais saiu (maior quantidade) pro que menos saiu;
  // empate é desempatado por ordem alfabética, pra ficar sempre estável.
  const porItemMap = new Map();
  for (const p of pedidos) {
    const acumulado = porItemMap.get(p.itemNome) || { itemNome: p.itemNome, quantidade: 0, valorTotal: 0 };
    acumulado.quantidade += p.quantidade;
    acumulado.valorTotal = arredondarValor(acumulado.valorTotal + p.valorTotal);
    porItemMap.set(p.itemNome, acumulado);
  }
  const porItem = Array.from(porItemMap.values()).sort(
    (a, b) => b.quantidade - a.quantidade || a.itemNome.localeCompare(b.itemNome, 'pt-BR')
  );

  return { dataInicio: dataInicio || null, dataFim: dataFim || null, pedidos, porItem, totalQuantidade, totalValor };
}

// ---------- Relatório de quantidades do catálogo em PDF ----------
//
// Diferente do relatório de pedidos acima (que olha pro HISTÓRICO — o que já saiu num
// período), esse é uma FOTO do catálogo agora: quanto tem, hoje, de cada item — usado
// pelo botão "Exportar quantidades (PDF)" na aba Catálogo. Ver
// `montarHtmlRelatorioQuantidades`/`ipcMain.handle('relatorio:gerarPdfQuantidades', ...)`
// em main.js.

/**
 * Itens do catálogo com quantidade atual MAIOR QUE ZERO (itens zerados ficam de fora de
 * propósito — o pedido foi só "o que tem quantidade"), em ordem alfabética, com o total
 * geral de unidades — dados prontos pro relatório de quantidades em PDF.
 */
function listarQuantidadesAtuaisParaRelatorio(data) {
  const itens = data.items
    .filter((i) => Number(i.quantidade) > 0)
    .map((i) => ({ id: i.id, nome: i.nome, quantidade: i.quantidade }))
    .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));

  const totalQuantidade = itens.reduce((soma, i) => soma + i.quantidade, 0);

  return { itens, totalItens: itens.length, totalQuantidade };
}

// ---------- Precificação ----------
//
// Aba exclusiva para dar um valor unitário a cada item do catálogo e ver o
// valor total do que tem em estoque, do que já saiu (concluído) e do que
// está pendente de pagamento. O valor só é definido pelo Admin (checagem de
// perfil no main.js); a multiplicação (valor x quantidade = valor total) é
// sempre calculada na hora a partir do preço e das movimentações — nunca
// fica guardada "pronta" em disco, pra não desatualizar.

/** Arredonda para 2 casas decimais (evita ruído de ponto flutuante em somas de dinheiro). */
function arredondarValor(numero) {
  return Math.round((Number(numero) || 0) * 100) / 100;
}

/**
 * Lista cada item do catálogo com seu valor unitário e os três totais
 * pedidos: valor em estoque (quantidade atual x valor unitário), valor do
 * que já saiu com pagamento concluído, e valor do que saiu mas está
 * marcado como pendente (ver `definirPendenteTransacao`). Entradas nunca
 * contam nesses totais de saída — só o que de fato saiu do estoque.
 */
function listarPrecificacao(data) {
  const linhas = clonar(data.items)
    .map((item) => {
      const precoUnitario = Number.isFinite(Number(item.precoUnitario)) ? Number(item.precoUnitario) : 0;
      let qtdSaidaConcluida = 0;
      let qtdSaidaPendente = 0;
      for (const t of data.transacoes) {
        if (t.itemId !== item.id || t.tipo !== 'saida') continue;
        if (t.pendente) qtdSaidaPendente += t.quantidade;
        else qtdSaidaConcluida += t.quantidade;
      }
      return {
        itemId: item.id,
        itemNome: item.nome,
        quantidade: item.quantidade,
        precoUnitario,
        valorEstoque: arredondarValor(item.quantidade * precoUnitario),
        qtdSaidaConcluida,
        valorSaida: arredondarValor(qtdSaidaConcluida * precoUnitario),
        qtdSaidaPendente,
        valorPendente: arredondarValor(qtdSaidaPendente * precoUnitario),
      };
    })
    .sort((a, b) => a.itemNome.localeCompare(b.itemNome, 'pt-BR'));

  return {
    itens: linhas,
    totalEstoque: arredondarValor(linhas.reduce((soma, l) => soma + l.valorEstoque, 0)),
    totalSaida: arredondarValor(linhas.reduce((soma, l) => soma + l.valorSaida, 0)),
    totalPendente: arredondarValor(linhas.reduce((soma, l) => soma + l.valorPendente, 0)),
  };
}

/** Define o valor unitário de um item (ação exclusiva do Admin — checagem de perfil no main.js). */
function definirPrecoItem(data, itemId, preco) {
  const precoNum = Number(preco);
  if (!Number.isFinite(precoNum) || precoNum < 0) {
    return { ok: false, erro: 'Informe um valor válido (maior ou igual a zero).' };
  }
  const novo = clonar(data);
  const item = novo.items.find((i) => i.id === itemId);
  if (!item) return { ok: false, erro: 'Item não encontrado.' };
  item.precoUnitario = arredondarValor(precoNum);
  item.atualizadoEm = new Date().toISOString();
  return { ok: true, data: novo, item };
}

// ---------- Backup: exportar/importar catálogo, usuários e histórico ----------

const FORMATO_BACKUP = 'controle-estoque-backup';

/** Monta o pacote de dados a exportar (catálogo, usuários, histórico, lançamentos avulsos,
 * pagamentos, e as CONTAS DE LOGIN DO DEFAULT — nunca o login do Admin, esse continua de fora
 * do backup de propósito: cada instalação mantém o seu próprio, criado no primeiro acesso ou já
 * existente). Levar as contas de login do Default no backup é o que permite que, ao importar
 * esse arquivo (nesta máquina ou em outra), a tela de login volte a reconhecer as mesmas contas
 * — ver `main.js`/`ipcMain.handle('backup:importar', ...)`. */
function montarPacoteExportacao(data) {
  return {
    formato: FORMATO_BACKUP,
    versaoFormato: 1,
    exportadoEm: new Date().toISOString(),
    items: data.items,
    usuarios: data.usuarios,
    transacoes: data.transacoes,
    lancamentos: data.lancamentos || [],
    pagamentos: data.pagamentos || [],
    contasLogin: data.contasLogin || [],
  };
}

/** Valida a forma básica de um pacote de backup (usado pelos dois tipos de importação). */
function validarPacoteImportacao(pacote) {
  if (!pacote || typeof pacote !== 'object' || pacote.formato !== FORMATO_BACKUP) {
    return { ok: false, erro: 'Esse arquivo não é um backup válido do Controle de Estoque.' };
  }
  if (!Array.isArray(pacote.items) || !Array.isArray(pacote.usuarios) || !Array.isArray(pacote.transacoes)) {
    return { ok: false, erro: 'Arquivo de backup incompleto ou corrompido.' };
  }
  // `lancamentos`, `pagamentos` e `contasLogin` são opcionais na validação (backups gerados
  // antes dessas funcionalidades existirem não têm os campos) — tratados como
  // lista vazia na hora de aplicar (ver aplicarPacoteImportacao /
  // aplicarPacoteImportacaoMesclado).
  if (!conteudoPacoteValido(pacote)) {
    return { ok: false, erro: 'Esse arquivo de backup tem conteúdo inválido (foi alterado fora do app?) e não foi importado.' };
  }
  return { ok: true };
}

// Campos de texto livre (o que a pessoa digita) — a interface sempre os exibe "escapados".
const CAMPOS_TEXTO_LIVRE = new Set([
  'nome', 'itemNome', 'usuarioNome', 'usuarioTelefone', 'telefone', 'observacao', 'usuario', 'descricao', 'comentario',
]);
const CAMPOS_NUMERICOS = new Set(['quantidade', 'quantidadeResultante', 'precoUnitario', 'precoUnitarioNaHora', 'valor']);
const RE_TEXTO_SIMPLES = /^[A-Za-z0-9_.:+-]*$/;
const RE_FOTO_PACOTE = /^data:(image|video)\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]*$/i;

/**
 * Confere o "formato" de cada registro de um backup antes de importar: números são números,
 * ids/datas/tipos só têm caracteres simples, fotos são data URLs de imagem/vídeo. Um arquivo
 * gerado pelo próprio app sempre passa; um montado à mão pra plantar HTML/código nos campos que
 * a interface mostra sem "escapar" (ids, quantidades, valores) é recusado inteiro.
 */
function conteudoPacoteValido(pacote) {
  for (const nomeLista of ['items', 'usuarios', 'transacoes', 'lancamentos', 'pagamentos', 'contasLogin']) {
    const registros = pacote[nomeLista];
    if (registros == null) continue;
    if (!Array.isArray(registros)) return false;
    for (const reg of registros) {
      if (!reg || typeof reg !== 'object' || Array.isArray(reg)) return false;
      for (const [campo, valor] of Object.entries(reg)) {
        if (valor === null || typeof valor === 'boolean') continue;
        if (campo === 'foto') {
          if (typeof valor !== 'string' || !RE_FOTO_PACOTE.test(valor)) return false;
          continue;
        }
        if (typeof valor === 'number') {
          if (!Number.isFinite(valor)) return false;
          continue;
        }
        if (CAMPOS_NUMERICOS.has(campo) || typeof valor !== 'string') return false;
        if (CAMPOS_TEXTO_LIVRE.has(campo)) {
          if (valor.length > 100000) return false;
          continue;
        }
        if (valor.length > 200 || !RE_TEXTO_SIMPLES.test(valor)) return false;
      }
    }
  }
  return true;
}

/**
 * Valida e aplica um pacote importado, SUBSTITUINDO TUDO: catálogo, usuários, histórico,
 * lançamentos, pagamentos E contas de login do Default atuais.
 *
 * O login do Admin desta instalação é ZERADO (`novo.admin = null`) sempre que esse tipo de
 * importação (substituir tudo) é concluído com sucesso. Isso é de propósito, não um efeito
 * colateral: o Admin nunca viaja dentro do arquivo de backup (ver `montarPacoteExportacao`), então
 * se o Admin local sobrevivesse a uma importação que troca TUDO o resto, ele continuaria "na
 * frente" de qualquer conta de login que o arquivo trouxer — `verificarLogin` checa o Admin
 * PRIMEIRO, então um login criado antes do backup existir seguiria valendo, e uma conta do
 * Default com o mesmo usuário nunca conseguiria autenticar de verdade. A regra é: um login criado
 * antes de uma importação "substituir tudo" só serve pro que for feito ANTES dela; depois de
 * concluída, o que vale são só as contas trazidas pelo arquivo.
 *
 * IMPORTANTE — isso NÃO reabre a tela de "criar login de Admin" (`primeiroAcessoConcluido`
 * continua `true`, ver `criarDadosIniciais`/`precisaConfigurarLoginInicial`): a máquina volta
 * direto pra tela de login NORMAL, e como não há mais nenhum Admin configurado, ninguém consegue
 * entrar como Admin até que uma pessoa que já tenha acesso administrativo (por outro meio, fora
 * deste app) configure um de novo. Isso é deliberado — é o que impede que qualquer pessoa (mesmo
 * um perfil Default, que também pode fazer essa importação) vire Admin desta máquina só de
 * importar um arquivo qualquer e passar por um assistente de criação de conta.
 */
function aplicarPacoteImportacao(data, pacote) {
  const validacao = validarPacoteImportacao(pacote);
  if (!validacao.ok) return validacao;

  const novo = clonar(data);
  novo.admin = null;
  novo.items = pacote.items;
  novo.usuarios = pacote.usuarios;
  // Todo o histórico resultante veio do arquivo (substituiu o que havia antes),
  // então toda transação fica marcada como importada.
  novo.transacoes = pacote.transacoes.map((t) => ({ ...t, importado: true }));
  novo.lancamentos = Array.isArray(pacote.lancamentos) ? pacote.lancamentos : [];
  novo.pagamentos = Array.isArray(pacote.pagamentos) ? pacote.pagamentos : [];
  novo.contasLogin = Array.isArray(pacote.contasLogin) ? pacote.contasLogin : [];
  return {
    ok: true,
    data: novo,
    resumo: {
      totalItens: pacote.items.length,
      totalUsuarios: pacote.usuarios.length,
      totalMovimentacoes: pacote.transacoes.length,
      totalContasLogin: novo.contasLogin.length,
      adminReiniciado: true,
    },
  };
}

/** Chave de comparação de nome de item (mesclagem casa itens pelo nome, não pelo id interno). */
function chaveNomeItem(nome) {
  return String(nome || '').trim().toLowerCase();
}

/**
 * Valida e MESCLA um pacote importado com os dados atuais, em vez de substituir —
 * a ideia é "o que já existe se mantém/anula, só o que for novo/diferente é
 * registrado":
 *  - **Usuários** do arquivo que ainda não existem localmente (por telefone) são
 *    adicionados; os que já existem não são alterados.
 *  - **Itens** são casados pelo nome. Um item que só existe no arquivo é
 *    adicionado com a quantidade do arquivo. Um item que já existe localmente
 *    **não tem a quantidade tocada diretamente** — ela só muda por causa de
 *    movimentações (transações) que o arquivo traga e que ainda não existam
 *    aqui (ver abaixo). Ou seja: mesclar o mesmo backup (ou um backup com o
 *    mesmo histórico) não altera nada.
 *  - **Transações, lançamentos avulsos e pagamentos** são reconhecidos pelo
 *    `id` com que nasceram (gerado na hora do evento, praticamente impossível
 *    de colidir entre instalações — ver `gerarId`) — não por conteúdo. Um
 *    registro cujo id já existe localmente é o MESMO evento (já veio de uma
 *    mesclagem anterior, ou aconteceu nas duas instalações a partir de uma
 *    base em comum): é ignorado, sem duplicar. Um registro com um id novo pra
 *    esta instalação é de fato novo: é adicionado (mantendo esse mesmo id, pra
 *    seguir sendo reconhecível numa mesclagem futura), e — só no caso de uma
 *    transação — seu efeito (soma numa entrada, subtrai numa saída) é
 *    aplicado à quantidade do item local correspondente. Esse efeito não é
 *    aplicado quando o item em si acabou de ser criado por esta mesclagem: a
 *    quantidade dele já veio "pronta" do arquivo, então reaplicar duplicaria
 *    a conta.
 *  - No histórico resultante, cada transação REALMENTE NOVA fica marcada como
 *    "importada" (`importado: true`); as demais (locais de antes, ou de uma
 *    mesclagem anterior) ficam "local" (`importado: false`) — só a mesclagem
 *    MAIS RECENTE fica marcada.
 */
function aplicarPacoteImportacaoMesclado(data, pacote) {
  const validacao = validarPacoteImportacao(pacote);
  if (!validacao.ok) return validacao;

  const novo = clonar(data);
  // A mesclagem anterior (se houve) deixa de ser "a importação atual": seus
  // registros passam a contar como histórico local.
  novo.transacoes.forEach((t) => {
    t.importado = false;
  });

  let itensNovos = 0;
  let usuariosNovos = 0;
  let transacoesNovas = 0;
  let transacoesRepetidas = 0;
  let lancamentosNovos = 0;
  let lancamentosRepetidos = 0;
  let pagamentosNovos = 0;
  let pagamentosRepetidos = 0;
  let contasLoginNovas = 0;
  let contasLoginRepetidas = 0;
  let contasLoginIgnoradasColisaoAdmin = 0;

  const idsItensRecemCriados = new Set();
  const mapaItemIdImportadoParaLocal = new Map();
  for (const itemImportado of pacote.items) {
    const nomeChave = chaveNomeItem(itemImportado.nome);
    const itemLocal = novo.items.find((i) => chaveNomeItem(i.nome) === nomeChave);
    if (itemLocal) {
      mapaItemIdImportadoParaLocal.set(itemImportado.id, itemLocal.id);
    } else {
      const quantidadeImportada = Math.max(0, Math.trunc(Number(itemImportado.quantidade) || 0));
      const novoItem = {
        id: gerarId('item'),
        nome: String(itemImportado.nome || '').trim() || 'Item importado',
        foto: itemImportado.foto || null,
        quantidade: quantidadeImportada,
        precoUnitario: Number.isFinite(Number(itemImportado.precoUnitario)) ? Number(itemImportado.precoUnitario) : 0,
        criadoEm: new Date().toISOString(),
        atualizadoEm: new Date().toISOString(),
      };
      novo.items.push(novoItem);
      mapaItemIdImportadoParaLocal.set(itemImportado.id, novoItem.id);
      idsItensRecemCriados.add(novoItem.id);
      itensNovos++;
    }
  }

  const mapaUsuarioIdImportadoParaLocal = new Map();
  for (const usuarioImportado of pacote.usuarios) {
    const usuarioLocal = encontrarUsuarioPorTelefone(novo, usuarioImportado.telefone);
    if (usuarioLocal) {
      mapaUsuarioIdImportadoParaLocal.set(usuarioImportado.id, usuarioLocal.id);
    } else {
      const novoUsuario = {
        id: gerarId('usr'),
        nome: usuarioImportado.nome ? String(usuarioImportado.nome).trim() : '',
        telefone: String(usuarioImportado.telefone || '').trim(),
        favorito: false,
        criadoEm: usuarioImportado.criadoEm || new Date().toISOString(),
      };
      novo.usuarios.push(novoUsuario);
      mapaUsuarioIdImportadoParaLocal.set(usuarioImportado.id, novoUsuario.id);
      usuariosNovos++;
    }
  }

  const idsTransacoesLocais = new Set(novo.transacoes.map((t) => t.id));
  const itensComMovimentoNovo = new Set();
  for (const transacaoImportada of pacote.transacoes) {
    if (idsTransacoesLocais.has(transacaoImportada.id)) {
      transacoesRepetidas++; // mesmo evento já registrado aqui — ignora, não duplica
      continue;
    }
    idsTransacoesLocais.add(transacaoImportada.id);

    const itemIdLocal = mapaItemIdImportadoParaLocal.get(transacaoImportada.itemId) || transacaoImportada.itemId;
    const usuarioIdLocal = transacaoImportada.usuarioId
      ? mapaUsuarioIdImportadoParaLocal.get(transacaoImportada.usuarioId) || null
      : null;

    novo.transacoes.push({
      ...transacaoImportada,
      itemId: itemIdLocal,
      usuarioId: usuarioIdLocal,
      importado: true,
    });
    transacoesNovas++;

    if (!idsItensRecemCriados.has(itemIdLocal)) {
      const itemLocalRef = novo.items.find((i) => i.id === itemIdLocal);
      if (itemLocalRef) {
        const delta = transacaoImportada.tipo === 'entrada' ? transacaoImportada.quantidade : -transacaoImportada.quantidade;
        itemLocalRef.quantidade += delta;
        itemLocalRef.atualizadoEm = new Date().toISOString();
        itensComMovimentoNovo.add(itemIdLocal);
      }
    }
  }

  // Lançamentos avulsos: mesma lógica de reconhecer pelo id — um lançamento cujo
  // usuário não pôde ser resolvido (não deveria acontecer, já que todo usuário do
  // arquivo é processado acima) é ignorado, em vez de ficar "órfão" sem dono.
  if (!Array.isArray(novo.lancamentos)) novo.lancamentos = [];
  const idsLancamentosLocais = new Set(novo.lancamentos.map((l) => l.id));
  for (const lancamentoImportado of pacote.lancamentos || []) {
    if (idsLancamentosLocais.has(lancamentoImportado.id)) {
      lancamentosRepetidos++;
      continue;
    }
    const usuarioIdLocal = mapaUsuarioIdImportadoParaLocal.get(lancamentoImportado.usuarioId) || null;
    if (!usuarioIdLocal) continue;
    idsLancamentosLocais.add(lancamentoImportado.id);
    novo.lancamentos.push({ ...lancamentoImportado, usuarioId: usuarioIdLocal });
    lancamentosNovos++;
  }

  // Pagamentos: mesma lógica de reconhecer pelo id e a mesma regra de descarte de
  // um dono não resolvido.
  if (!Array.isArray(novo.pagamentos)) novo.pagamentos = [];
  const idsPagamentosLocais = new Set(novo.pagamentos.map((p) => p.id));
  for (const pagamentoImportado of pacote.pagamentos || []) {
    if (idsPagamentosLocais.has(pagamentoImportado.id)) {
      pagamentosRepetidos++;
      continue;
    }
    const usuarioIdLocal = mapaUsuarioIdImportadoParaLocal.get(pagamentoImportado.usuarioId) || null;
    if (!usuarioIdLocal) continue;
    idsPagamentosLocais.add(pagamentoImportado.id);
    novo.pagamentos.push({ ...pagamentoImportado, usuarioId: usuarioIdLocal });
    pagamentosNovos++;
  }

  // Contas de login do Default: reconhecidas pelo nome de usuário (não pelo id — o mesmo jeito
  // que os usuários comuns são reconhecidos pelo telefone). Uma conta que já existe localmente
  // fica como está — a senha local continua valendo, não é sobrescrita pela do arquivo. Uma conta
  // do arquivo cujo usuário colide com o do ADMIN local é ignorada por um motivo diferente (e
  // contada à parte, pra aparecer destacado no resumo): se ela entrasse, ficaria pra sempre
  // impossível de usar, porque `verificarLogin` sempre checa o Admin primeiro. Diferente da
  // importação TOTAL (que zera o Admin local de propósito — ver `aplicarPacoteImportacao` acima),
  // a mesclagem NUNCA toca no Admin desta máquina (é uma ação exclusiva dele, faria sentido
  // mudar seu próprio login sem querer no meio de uma mesclagem), então aqui não dá pra resolver a
  // colisão zerando o Admin: a conta colidente é simplesmente deixada de fora, com aviso. Só entra
  // de fato uma conta cujo usuário é realmente novo aqui e não colide com nada.
  if (!Array.isArray(novo.contasLogin)) novo.contasLogin = [];
  for (const contaImportada of pacote.contasLogin || []) {
    if (novo.admin && contaImportada.usuario === novo.admin.usuario) {
      contasLoginIgnoradasColisaoAdmin++;
      continue;
    }
    if (usuarioDeLoginJaExiste(novo, contaImportada.usuario)) {
      contasLoginRepetidas++;
      continue;
    }
    novo.contasLogin.push({ ...contaImportada });
    contasLoginNovas++;
  }

  return {
    ok: true,
    data: novo,
    resumo: {
      itensNovos,
      itensAtualizados: itensComMovimentoNovo.size,
      usuariosNovos,
      transacoesImportadas: transacoesNovas,
      transacoesRepetidas,
      lancamentosNovos,
      lancamentosRepetidos,
      pagamentosNovos,
      pagamentosRepetidos,
      contasLoginNovas,
      contasLoginRepetidas,
      contasLoginIgnoradasColisaoAdmin,
    },
  };
}

module.exports = {
  hojeISO,
  criarDadosIniciais,
  precisaConfigurarLoginInicial,
  verificarLoginAdmin,
  configurarLoginInicial,
  redefinirLoginAdmin,
  listarContasLogin,
  criarContaLogin,
  excluirContaLogin,
  resetarSenhaContaLogin,
  verificarLogin,
  trocarSenhaContaLogin,
  listarItens,
  adicionarItem,
  editarItem,
  removerItem,
  listarUsuarios,
  encontrarUsuarioPorTelefone,
  adicionarUsuario,
  editarUsuario,
  removerUsuario,
  favoritarUsuario,
  definirBloqueioUsuario,
  excluirTodosUsuarios,
  apenasDigitos,
  final4Telefone,
  nomeOuIdentificador,
  rotuloUsuario,
  ajustarQuantidade,
  desfazerTransacao,
  definirPendenteTransacao,
  marcarRecebidoDefaultTransacao,
  listarPrecificacao,
  definirPrecoItem,
  listarDiasComMovimentacao,
  listarTransacoesPorDia,
  listarHistoricoPorPeriodo,
  excluirTodoHistorico,
  excluirTransacoes,
  dentroDoPeriodo,
  listarHistoricoDoItem,
  consultarPorItem,
  consultarPorUsuario,
  montarPacoteExportacao,
  aplicarPacoteImportacao,
  aplicarPacoteImportacaoMesclado,
  FORMATO_BACKUP,
  adicionarLancamento,
  listarLancamentosPorUsuario,
  definirPendenteLancamento,
  marcarRecebidoDefaultLancamento,
  editarLancamento,
  removerLancamento,
  adicionarPagamento,
  listarPagamentosPorUsuario,
  editarPagamento,
  removerPagamento,
  excluirTodosLancamentosEPagamentos,
  listarLancamentosEPagamentosPorDia,
  listarLancamentosEPagamentosPorPeriodo,
  valorTransacaoPendente,
  precoUnitarioParaTransacao,
  detalharPendenciasUsuario,
  listarUsuariosPendentes,
  listarUsuariosQuitados,
  totalizarPendencias,
  quitarPendenciaUsuario,
  listarPedidosParaRelatorio,
  listarQuantidadesAtuaisParaRelatorio,
};
