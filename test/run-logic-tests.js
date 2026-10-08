'use strict';

/**
 * Testes da lógica de negócio e da criptografia, usando apenas `node` puro
 * (sem Electron). Rode com: npm run test:logic
 */

const assert = require('assert');
const logic = require('../src/logic');
const cryptoUtils = require('../src/crypto-utils');

let passou = 0;
function t(nome, fn) {
  try {
    fn();
    passou++;
    console.log(`  OK  - ${nome}`);
  } catch (erro) {
    console.error(`FALHOU - ${nome}`);
    console.error('       ', erro.message);
    process.exitCode = 1;
  }
}

console.log('== crypto-utils ==');

t('hash de senha e verificação corretas', () => {
  const salt = cryptoUtils.gerarSalt();
  const hash = cryptoUtils.hashSenha('minhaSenha123', salt);
  assert.strictEqual(cryptoUtils.verificarSenha('minhaSenha123', salt, hash), true);
  assert.strictEqual(cryptoUtils.verificarSenha('senhaErrada', salt, hash), false);
});

t('criptografar/descriptografar JSON com AES-256-GCM (round trip)', () => {
  const chave = cryptoUtils.gerarChaveAes();
  const objetoOriginal = { a: 1, b: 'texto com acentuação çãõ', lista: [1, 2, 3] };
  const payload = cryptoUtils.criptografarJSON(objetoOriginal, chave);
  assert.notStrictEqual(payload, JSON.stringify(objetoOriginal), 'não deveria estar em texto puro');
  const decodificado = cryptoUtils.descriptografarJSON(payload, chave);
  assert.deepStrictEqual(decodificado, objetoOriginal);
});

t('derivarChaveDeSenha: mesma senha+salt gera a mesma chave; senha diferente gera outra', () => {
  const salt = cryptoUtils.gerarSalt();
  const chave1 = cryptoUtils.derivarChaveDeSenha('minhaSenhaDeBackup', salt);
  const chave2 = cryptoUtils.derivarChaveDeSenha('minhaSenhaDeBackup', salt);
  assert.strictEqual(chave1.equals(chave2), true);
  const chave3 = cryptoUtils.derivarChaveDeSenha('outraSenha', salt);
  assert.strictEqual(chave1.equals(chave3), false);
});

t('descriptografar com chave errada falha (integridade AEAD)', () => {
  const chave1 = cryptoUtils.gerarChaveAes();
  const chave2 = cryptoUtils.gerarChaveAes();
  const payload = cryptoUtils.criptografarJSON({ x: 1 }, chave1);
  assert.throws(() => cryptoUtils.descriptografarJSON(payload, chave2));
});

t('criptografar/descriptografar Buffer (fotos) com AES-256-GCM, detectando adulteração', () => {
  const chave = cryptoUtils.gerarChaveAes();
  const original = Buffer.from([0, 1, 2, 250, 251, 252, 9, 9, 9]);
  const cifrado = cryptoUtils.criptografarBuffer(original, chave);
  assert.ok(!cifrado.includes(original));
  assert.deepStrictEqual(cryptoUtils.descriptografarBuffer(cifrado, chave), original);
  cifrado[cifrado.length - 1] ^= 1;
  assert.throws(() => cryptoUtils.descriptografarBuffer(cifrado, chave));
});

console.log('== logic: autenticação ==');

t('primeira execução: não existe login padrão — verificarLoginAdmin falha até configurar', () => {
  const data = logic.criarDadosIniciais();
  assert.strictEqual(data.admin, null);
  assert.strictEqual(logic.verificarLoginAdmin(data, 'qualquer', 'qualquer'), false);
});

t('precisaConfigurarLoginInicial: só é true numa instalação genuinamente nova — depois de configurado (ou depois de zerado por uma importação total) nunca mais volta a ser true', () => {
  const nova = logic.criarDadosIniciais();
  assert.strictEqual(logic.precisaConfigurarLoginInicial(nova), true);

  const configurada = logic.configurarLoginInicial(nova, { usuario: 'meuadmin', senha: 'segredo123' }).data;
  assert.strictEqual(logic.precisaConfigurarLoginInicial(configurada), false);

  // uma importação total zera `admin`, mas NÃO faz a tela de primeiro acesso reaparecer — ver
  // `aplicarPacoteImportacao` (a máquina volta pra tela de login normal, não pro assistente de
  // criação de Admin, senão qualquer pessoa que importe um arquivo viraria Admin).
  const pacote = logic.montarPacoteExportacao(logic.criarDadosIniciais());
  const importada = logic.aplicarPacoteImportacao(configurada, pacote);
  assert.strictEqual(importada.ok, true);
  assert.strictEqual(importada.data.admin, null);
  assert.strictEqual(logic.precisaConfigurarLoginInicial(importada.data), false);
  // sem nenhum Admin configurado e sem contas no arquivo desse teste, ninguém consegue logar
  assert.strictEqual(logic.verificarLogin(importada.data, 'meuadmin', 'segredo123').ok, false);
});

t('configurarLoginInicial NÃO recria o Admin depois que uma importação total o zerou (salvo permitirRecriar explícito)', () => {
  let data = logic.configurarLoginInicial(logic.criarDadosIniciais(), { usuario: 'dono', senha: 'segredo123' }).data;
  data = logic.aplicarPacoteImportacao(data, logic.montarPacoteExportacao(logic.criarDadosIniciais())).data;
  assert.strictEqual(data.admin, null);

  const invasor = logic.configurarLoginInicial(data, { usuario: 'invasor', senha: 'qualquer1' });
  assert.strictEqual(invasor.ok, false);

  const dono = logic.configurarLoginInicial(data, { usuario: 'dono2', senha: 'segredo456' }, { permitirRecriar: true });
  assert.strictEqual(dono.ok, true);
  assert.strictEqual(dono.data.admin.usuario, 'dono2');
});

t('configurarLoginInicial cria o login do admin, exige senha com 6+ caracteres e só funciona uma vez', () => {
  let data = logic.criarDadosIniciais();

  const semUsuario = logic.configurarLoginInicial(data, { usuario: '  ', senha: 'segredo123' });
  assert.strictEqual(semUsuario.ok, false);

  const senhaCurta = logic.configurarLoginInicial(data, { usuario: 'meuadmin', senha: '123' });
  assert.strictEqual(senhaCurta.ok, false);

  const res = logic.configurarLoginInicial(data, { usuario: 'meuadmin', senha: 'segredo123' });
  assert.strictEqual(res.ok, true);
  data = res.data;
  assert.strictEqual(data.admin.usuario, 'meuadmin');

  assert.strictEqual(logic.verificarLoginAdmin(data, 'meuadmin', 'segredo123'), true);
  assert.strictEqual(logic.verificarLoginAdmin(data, 'meuadmin', 'errada'), false);
  assert.strictEqual(logic.verificarLoginAdmin(data, 'outro', 'segredo123'), false);

  // uma vez configurado, não dá pra configurar de novo (não é troca de senha)
  const denovo = logic.configurarLoginInicial(data, { usuario: 'outroadmin', senha: 'outrasenha' });
  assert.strictEqual(denovo.ok, false);
  assert.strictEqual(denovo.data, undefined); // nada muda
});

t('redefinirLoginAdmin troca usuário/senha do admin, mas exige a senha ATUAL correta', () => {
  let data = logic.criarDadosIniciais();
  data = logic.configurarLoginInicial(data, { usuario: 'meuadmin', senha: 'segredo123' }).data;

  // sem admin configurado ainda: rejeita
  const semAdmin = logic.redefinirLoginAdmin(logic.criarDadosIniciais(), {
    senhaAtual: 'qualquer',
    novoUsuario: 'novo',
    novaSenha: 'novasenha1',
  });
  assert.strictEqual(semAdmin.ok, false);

  // senha atual errada: rejeita, nada muda
  const senhaErrada = logic.redefinirLoginAdmin(data, {
    senhaAtual: 'errada',
    novoUsuario: 'novoadmin',
    novaSenha: 'novasenha1',
  });
  assert.strictEqual(senhaErrada.ok, false);
  assert.strictEqual(logic.verificarLoginAdmin(data, 'meuadmin', 'segredo123'), true);

  // novo usuário vazio ou nova senha curta: rejeita
  assert.strictEqual(
    logic.redefinirLoginAdmin(data, { senhaAtual: 'segredo123', novoUsuario: '  ', novaSenha: 'novasenha1' }).ok,
    false
  );
  assert.strictEqual(
    logic.redefinirLoginAdmin(data, { senhaAtual: 'segredo123', novoUsuario: 'novoadmin', novaSenha: '123' }).ok,
    false
  );

  // com a senha atual certa: troca de verdade
  const res = logic.redefinirLoginAdmin(data, {
    senhaAtual: 'segredo123',
    novoUsuario: 'novoadmin',
    novaSenha: 'novasenha1',
  });
  assert.strictEqual(res.ok, true);
  data = res.data;
  assert.strictEqual(data.admin.usuario, 'novoadmin');
  assert.strictEqual(logic.verificarLoginAdmin(data, 'novoadmin', 'novasenha1'), true);
  assert.strictEqual(logic.verificarLoginAdmin(data, 'meuadmin', 'segredo123'), false); // login antigo não funciona mais
});

console.log('== logic: gerenciador de login (contas do Default) ==');

t('criarContaLogin: exige usuário e senha (mín. 6), rejeita usuário repetido (do admin ou de outra conta)', () => {
  let data = logic.criarDadosIniciais();
  data = logic.configurarLoginInicial(data, { usuario: 'admin', senha: 'senhadoadmin1' }).data;

  const semUsuario = logic.criarContaLogin(data, { usuario: '  ', senha: 'temporaria1' });
  assert.strictEqual(semUsuario.ok, false);

  const senhaCurta = logic.criarContaLogin(data, { usuario: 'joao', senha: '123' });
  assert.strictEqual(senhaCurta.ok, false);

  const igualAdmin = logic.criarContaLogin(data, { usuario: 'admin', senha: 'temporaria1' });
  assert.strictEqual(igualAdmin.ok, false);

  const criada = logic.criarContaLogin(data, { usuario: 'joao', senha: 'temporaria1' });
  assert.strictEqual(criada.ok, true);
  data = criada.data;
  assert.strictEqual(data.contasLogin.length, 1);
  assert.strictEqual(data.contasLogin[0].usuario, 'joao');
  assert.strictEqual(data.contasLogin[0].precisaTrocarSenha, true); // toda conta nasce com senha temporária

  const repetida = logic.criarContaLogin(data, { usuario: 'joao', senha: 'outrasenha1' });
  assert.strictEqual(repetida.ok, false);
});

t('listarContasLogin: devolve só os campos públicos (sem hash/salt), em ordem alfabética', () => {
  let data = logic.criarDadosIniciais();
  data = logic.criarContaLogin(data, { usuario: 'zeca', senha: 'temporaria1' }).data;
  data = logic.criarContaLogin(data, { usuario: 'ana', senha: 'temporaria1' }).data;

  const lista = logic.listarContasLogin(data);
  assert.strictEqual(lista.length, 2);
  assert.deepStrictEqual(lista.map((c) => c.usuario), ['ana', 'zeca']);
  assert.strictEqual(lista[0].salt, undefined);
  assert.strictEqual(lista[0].hashSenha, undefined);
  assert.strictEqual(lista[0].precisaTrocarSenha, true);
});

t('definirAdminContaLogin dá e tira o acesso de Admin; verificarLogin e listar refletem isso', () => {
  let data = logic.criarDadosIniciais();
  data = logic.configurarLoginInicial(data, { usuario: 'admin', senha: 'senhadoadmin1' }).data;
  data = logic.criarContaLogin(data, { usuario: 'joao', senha: 'temporaria1' }).data;
  const criadaAdmin = logic.criarContaLogin(data, { usuario: 'maria', senha: 'temporaria1', admin: true });
  assert.strictEqual(criadaAdmin.ok, true);
  data = criadaAdmin.data;
  const joao = data.contasLogin.find((c) => c.usuario === 'joao');
  const maria = data.contasLogin.find((c) => c.usuario === 'maria');
  assert.strictEqual(maria.admin, true);
  assert.strictEqual(!!joao.admin, false);
  // Só `true` de verdade vira Admin (nada de "sim"/1 vindo de fora).
  assert.strictEqual(logic.criarContaLogin(data, { usuario: 'zeca', senha: 'temporaria1', admin: 'sim' }).data
    .contasLogin.find((c) => c.usuario === 'zeca').admin, false);

  data = logic.trocarSenhaContaLogin(data, joao.id, { senhaAtual: 'temporaria1', novaSenha: 'senhaJoao1' }).data;
  assert.strictEqual(logic.verificarLogin(data, 'joao', 'senhaJoao1').admin, false);

  const promovido = logic.definirAdminContaLogin(data, joao.id, true);
  assert.strictEqual(promovido.ok, true);
  data = promovido.data;
  const login = logic.verificarLogin(data, 'joao', 'senhaJoao1');
  assert.strictEqual(login.ok, true);
  assert.strictEqual(login.admin, true);
  assert.strictEqual(logic.listarContasLogin(data).find((c) => c.id === joao.id).admin, true);

  data = logic.definirAdminContaLogin(data, joao.id, false).data;
  assert.strictEqual(logic.verificarLogin(data, 'joao', 'senhaJoao1').admin, false);
  assert.strictEqual(logic.definirAdminContaLogin(data, 'nao-existe', true).ok, false);
});

t('excluirContaLogin remove a conta; rejeita id inexistente', () => {
  let data = logic.criarDadosIniciais();
  data = logic.criarContaLogin(data, { usuario: 'joao', senha: 'temporaria1' }).data;
  const contaId = data.contasLogin[0].id;

  const inexistente = logic.excluirContaLogin(data, 'nao-existe');
  assert.strictEqual(inexistente.ok, false);

  const res = logic.excluirContaLogin(data, contaId);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.data.contasLogin.length, 0);
});

t('resetarSenhaContaLogin troca a senha (voltando a ser temporária) e exige mínimo de 6 caracteres', () => {
  let data = logic.criarDadosIniciais();
  data = logic.criarContaLogin(data, { usuario: 'joao', senha: 'temporaria1' }).data;
  const contaId = data.contasLogin[0].id;

  // troca de senha (fluxo normal do 1º acesso) tira o precisaTrocarSenha
  data = logic.trocarSenhaContaLogin(data, contaId, { senhaAtual: 'temporaria1', novaSenha: 'senhaSoDoJoao1' }).data;
  assert.strictEqual(data.contasLogin[0].precisaTrocarSenha, false);

  const curta = logic.resetarSenhaContaLogin(data, contaId, '123');
  assert.strictEqual(curta.ok, false);

  const inexistente = logic.resetarSenhaContaLogin(data, 'nao-existe', 'novaSenha1');
  assert.strictEqual(inexistente.ok, false);

  const res = logic.resetarSenhaContaLogin(data, contaId, 'novaTemporaria1');
  assert.strictEqual(res.ok, true);
  data = res.data;
  assert.strictEqual(data.contasLogin[0].precisaTrocarSenha, true); // volta a exigir troca
  assert.strictEqual(logic.verificarLogin(data, 'joao', 'senhaSoDoJoao1').ok, false); // senha antiga não vale mais
  assert.strictEqual(logic.verificarLogin(data, 'joao', 'novaTemporaria1').ok, true);
});

t('verificarLogin: reconhece o admin, uma conta do Default (com o aviso de precisaTrocarSenha) e rejeita usuário/senha errados', () => {
  let data = logic.criarDadosIniciais();
  data = logic.configurarLoginInicial(data, { usuario: 'admin', senha: 'senhadoadmin1' }).data;
  data = logic.criarContaLogin(data, { usuario: 'joao', senha: 'temporaria1' }).data;

  const comoAdmin = logic.verificarLogin(data, 'admin', 'senhadoadmin1');
  assert.strictEqual(comoAdmin.ok, true);
  assert.strictEqual(comoAdmin.tipo, 'admin');

  const comoDefaultTemp = logic.verificarLogin(data, 'joao', 'temporaria1');
  assert.strictEqual(comoDefaultTemp.ok, true);
  assert.strictEqual(comoDefaultTemp.tipo, 'default');
  assert.strictEqual(comoDefaultTemp.precisaTrocarSenha, true);

  const contaId = data.contasLogin[0].id;
  data = logic.trocarSenhaContaLogin(data, contaId, { senhaAtual: 'temporaria1', novaSenha: 'senhaSoDoJoao1' }).data;
  const comoDefaultDefinitivo = logic.verificarLogin(data, 'joao', 'senhaSoDoJoao1');
  assert.strictEqual(comoDefaultDefinitivo.ok, true);
  assert.strictEqual(comoDefaultDefinitivo.precisaTrocarSenha, false);

  assert.strictEqual(logic.verificarLogin(data, 'joao', 'senhaErrada').ok, false);
  assert.strictEqual(logic.verificarLogin(data, 'ninguem', 'qualquer').ok, false);
});

t('trocarSenhaContaLogin exige a senha atual correta e a nova com mínimo de 6 caracteres; rejeita conta inexistente', () => {
  let data = logic.criarDadosIniciais();
  data = logic.criarContaLogin(data, { usuario: 'joao', senha: 'temporaria1' }).data;
  const contaId = data.contasLogin[0].id;

  const inexistente = logic.trocarSenhaContaLogin(data, 'nao-existe', { senhaAtual: 'temporaria1', novaSenha: 'novasenha1' });
  assert.strictEqual(inexistente.ok, false);

  const senhaAtualErrada = logic.trocarSenhaContaLogin(data, contaId, { senhaAtual: 'errada', novaSenha: 'novasenha1' });
  assert.strictEqual(senhaAtualErrada.ok, false);

  const novaCurta = logic.trocarSenhaContaLogin(data, contaId, { senhaAtual: 'temporaria1', novaSenha: '123' });
  assert.strictEqual(novaCurta.ok, false);

  const res = logic.trocarSenhaContaLogin(data, contaId, { senhaAtual: 'temporaria1', novaSenha: 'senhaSoDoJoao1' });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.data.contasLogin[0].precisaTrocarSenha, false);
  assert.strictEqual(logic.verificarLogin(res.data, 'joao', 'senhaSoDoJoao1').ok, true);
});

console.log('== logic: itens ==');

t('adicionar, editar e remover item do catálogo', () => {
  let data = logic.criarDadosIniciais();
  const add = logic.adicionarItem(data, { nome: '  Arroz 5kg ', quantidade: '10' });
  assert.strictEqual(add.ok, true);
  data = add.data;
  assert.strictEqual(data.items.length, 1);
  assert.strictEqual(data.items[0].nome, 'Arroz 5kg');
  assert.strictEqual(data.items[0].quantidade, 10);

  const edit = logic.editarItem(data, data.items[0].id, { nome: 'Arroz 5kg tipo 1' });
  assert.strictEqual(edit.ok, true);
  data = edit.data;
  assert.strictEqual(data.items[0].nome, 'Arroz 5kg tipo 1');

  const rem = logic.removerItem(data, data.items[0].id);
  assert.strictEqual(rem.ok, true);
  assert.strictEqual(rem.data.items.length, 0);
});

t('rejeita item sem nome', () => {
  const data = logic.criarDadosIniciais();
  const add = logic.adicionarItem(data, { nome: '   ', quantidade: 5 });
  assert.strictEqual(add.ok, false);
});

console.log('== logic: usuários ==');

t('telefone é obrigatório para cadastrar usuário', () => {
  const data = logic.criarDadosIniciais();
  const semTelefone = logic.adicionarUsuario(data, { nome: 'Maria' });
  assert.strictEqual(semTelefone.ok, false);
  const telefoneCurto = logic.adicionarUsuario(data, { nome: 'Maria', telefone: '123' });
  assert.strictEqual(telefoneCurto.ok, false);
});

t('nome é opcional; sem nome o usuário é identificado pelo final do telefone', () => {
  const data = logic.criarDadosIniciais();
  const res = logic.adicionarUsuario(data, { telefone: '(27) 99999-1234' });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.usuario.nome, '');
  assert.strictEqual(logic.nomeOuIdentificador(res.usuario), 'Nº final 1234');
  assert.strictEqual(logic.rotuloUsuario(res.usuario), 'Nº final 1234');
});

t('com nome, o rótulo mostra nome + final do telefone', () => {
  const data = logic.criarDadosIniciais();
  const res = logic.adicionarUsuario(data, { nome: 'Maria Silva', telefone: '27999991234' });
  assert.strictEqual(logic.rotuloUsuario(res.usuario), 'Maria Silva (•1234)');
});

t('adicionar usuário com telefone duplicado é rejeitado, mesmo com formatação diferente', () => {
  let data = logic.criarDadosIniciais();
  const r1 = logic.adicionarUsuario(data, { nome: 'Maria Silva', telefone: '(27) 99999-1234' });
  assert.strictEqual(r1.ok, true);
  data = r1.data;
  const r2 = logic.adicionarUsuario(data, { nome: 'Outra Pessoa', telefone: '27999991234' });
  assert.strictEqual(r2.ok, false);
});

t('remover usuário funciona', () => {
  let data = logic.criarDadosIniciais();
  const r1 = logic.adicionarUsuario(data, { nome: 'João', telefone: '27988887777' });
  data = r1.data;
  const r2 = logic.removerUsuario(data, r1.usuario.id);
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(r2.data.usuarios.length, 0);
});

t('favoritar usuário funciona e favoritos aparecem sempre no topo da lista', () => {
  let data = logic.criarDadosIniciais();
  const rA = logic.adicionarUsuario(data, { nome: 'Ana', telefone: '27911110000' });
  data = rA.data;
  const rB = logic.adicionarUsuario(data, { nome: 'Bruno', telefone: '27922220000' });
  data = rB.data;
  const rZ = logic.adicionarUsuario(data, { nome: 'Zeca', telefone: '27933330000' });
  data = rZ.data;

  // ordem alfabética sem favoritos: Ana, Bruno, Zeca
  let lista = logic.listarUsuarios(data);
  assert.deepStrictEqual(lista.map((u) => u.nome), ['Ana', 'Bruno', 'Zeca']);

  // favorita "Zeca" -> ele vai para o topo, mesmo fora de ordem alfabética
  const fav = logic.favoritarUsuario(data, rZ.usuario.id, true);
  assert.strictEqual(fav.ok, true);
  assert.strictEqual(fav.usuario.favorito, true);
  data = fav.data;

  lista = logic.listarUsuarios(data);
  assert.deepStrictEqual(lista.map((u) => u.nome), ['Zeca', 'Ana', 'Bruno']);

  // desfavoritar volta pra ordem alfabética normal
  const desfav = logic.favoritarUsuario(data, rZ.usuario.id, false);
  data = desfav.data;
  lista = logic.listarUsuarios(data);
  assert.deepStrictEqual(lista.map((u) => u.nome), ['Ana', 'Bruno', 'Zeca']);
});

t('favoritar usuário inexistente é rejeitado', () => {
  const data = logic.criarDadosIniciais();
  const res = logic.favoritarUsuario(data, 'usr-nao-existe', true);
  assert.strictEqual(res.ok, false);
});

t('editarUsuario altera nome e/ou telefone (disponível para os dois perfis); valida telefone e duplicidade', () => {
  let data = logic.criarDadosIniciais();
  const rA = logic.adicionarUsuario(data, { nome: 'Ana', telefone: '27911110000' });
  data = rA.data;
  const rB = logic.adicionarUsuario(data, { nome: 'Bruno', telefone: '27922220000' });
  data = rB.data;

  // só o nome
  let res = logic.editarUsuario(data, rA.usuario.id, { nome: 'Ana Paula' });
  assert.strictEqual(res.ok, true);
  data = res.data;
  assert.strictEqual(data.usuarios.find((u) => u.id === rA.usuario.id).nome, 'Ana Paula');
  assert.strictEqual(data.usuarios.find((u) => u.id === rA.usuario.id).telefone, '27911110000');

  // nome + telefone juntos
  res = logic.editarUsuario(data, rA.usuario.id, { nome: 'Ana P.', telefone: '27977778888' });
  assert.strictEqual(res.ok, true);
  data = res.data;
  assert.strictEqual(data.usuarios.find((u) => u.id === rA.usuario.id).telefone, '27977778888');

  // telefone inválido é rejeitado
  const telInvalido = logic.editarUsuario(data, rA.usuario.id, { telefone: '123' });
  assert.strictEqual(telInvalido.ok, false);

  // telefone duplicado (de outro usuário) é rejeitado
  const telDuplicado = logic.editarUsuario(data, rA.usuario.id, { telefone: '27922220000' });
  assert.strictEqual(telDuplicado.ok, false);

  // manter o próprio telefone (sem mudar de dono) continua ok
  const mesmoTelefone = logic.editarUsuario(data, rA.usuario.id, { telefone: '27977778888', nome: 'Ana P.' });
  assert.strictEqual(mesmoTelefone.ok, true);

  // usuário inexistente é rejeitado
  const inexistente = logic.editarUsuario(data, 'usr-nao-existe', { nome: 'X' });
  assert.strictEqual(inexistente.ok, false);
});

t('definirBloqueioUsuario marca/desmarca o bloqueio para o perfil Default', () => {
  let data = logic.criarDadosIniciais();
  const rA = logic.adicionarUsuario(data, { nome: 'Ana', telefone: '27911110000' });
  data = rA.data;
  assert.strictEqual(data.usuarios[0].bloqueadoParaDefault, false);

  const bloq = logic.definirBloqueioUsuario(data, rA.usuario.id, true);
  assert.strictEqual(bloq.ok, true);
  data = bloq.data;
  assert.strictEqual(data.usuarios[0].bloqueadoParaDefault, true);

  const desbloq = logic.definirBloqueioUsuario(data, rA.usuario.id, false);
  assert.strictEqual(desbloq.data.usuarios[0].bloqueadoParaDefault, false);

  const inexistente = logic.definirBloqueioUsuario(data, 'usr-nao-existe', true);
  assert.strictEqual(inexistente.ok, false);
});

console.log('== logic: movimentação de quantidade ==');

function dataComItem(qtdInicial) {
  let data = logic.criarDadosIniciais();
  const add = logic.adicionarItem(data, { nome: 'Refrigerante', quantidade: qtdInicial });
  return { data: add.data, itemId: add.item.id };
}

t('entrada simples (admin, sem usuário) soma quantidade', () => {
  const { data, itemId } = dataComItem(5);
  const res = logic.ajustarQuantidade(data, { itemId, tipo: 'entrada', quantidade: 3, perfil: 'admin' });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.item.quantidade, 8);
  assert.strictEqual(res.transacao.tipo, 'entrada');
  assert.strictEqual(res.transacao.usuarioNome, null);
});

t('saida não pode deixar estoque negativo (admin, sem usuário)', () => {
  const { data, itemId } = dataComItem(2);
  const res = logic.ajustarQuantidade(data, { itemId, tipo: 'saida', quantidade: 5, perfil: 'admin' });
  assert.strictEqual(res.ok, false);
});

t('entrada consegue recuperar um item que ficou negativo (ex.: depois de uma mesclagem)', () => {
  const { data, itemId } = dataComItem(0);
  // Só se chega a um item com quantidade negativa via mesclagem (adicionarItem nunca aceita
  // um valor inicial negativo); simula esse estado diretamente, como a mesclagem deixaria.
  data.items.find((i) => i.id === itemId).quantidade = -5;
  // uma entrada normal, mesmo terminando ainda negativa, não é bloqueada — só saída respeita o limite de zero
  const parcial = logic.ajustarQuantidade(data, { itemId, tipo: 'entrada', quantidade: 3, perfil: 'admin' });
  assert.strictEqual(parcial.ok, true);
  assert.strictEqual(parcial.item.quantidade, -2);

  const completa = logic.ajustarQuantidade(parcial.data, { itemId, tipo: 'entrada', quantidade: 10, perfil: 'admin' });
  assert.strictEqual(completa.ok, true);
  assert.strictEqual(completa.item.quantidade, 8);
});

console.log('== logic: regras exclusivas do perfil Default (usuário obrigatório) ==');

t('default não pode fazer saída sem usuário atrelado', () => {
  const { data, itemId } = dataComItem(10);
  const semUsuario = logic.ajustarQuantidade(data, { itemId, tipo: 'saida', quantidade: 1, perfil: 'default' });
  assert.strictEqual(semUsuario.ok, false);

  const comUsuarioNovo = logic.ajustarQuantidade(data, {
    itemId, tipo: 'saida', quantidade: 1, usuarioTelefoneNovo: '27944443333', tipoEntrega: 'entrega', perfil: 'default',
  });
  assert.strictEqual(comUsuarioNovo.ok, true);
});

t('default nunca pode fazer entrada (adicionar), mesmo com usuário e histórico de saída', () => {
  let { data, itemId } = dataComItem(10);
  const ru = logic.adicionarUsuario(data, { nome: 'Fernanda', telefone: '27922223333' });
  data = ru.data;

  const semUsuario = logic.ajustarQuantidade(data, { itemId, tipo: 'entrada', quantidade: 1, perfil: 'default' });
  assert.strictEqual(semUsuario.ok, false);

  // mesmo um usuário que já tem uma saída anterior desse item continua bloqueado —
  // a "devolução" não existe mais para o Default, só o Admin pode fazer entrada
  const saida = logic.ajustarQuantidade(data, {
    itemId, tipo: 'saida', quantidade: 3, usuarioId: ru.usuario.id, tipoEntrega: 'entrega', perfil: 'default',
  });
  assert.strictEqual(saida.ok, true);
  data = saida.data;

  const entradaComHistorico = logic.ajustarQuantidade(data, {
    itemId, tipo: 'entrada', quantidade: 2, usuarioId: ru.usuario.id, tipoEntrega: 'entrega', perfil: 'default',
  });
  assert.strictEqual(entradaComHistorico.ok, false);

  // admin, esse sim, pode
  const entradaPeloAdmin = logic.ajustarQuantidade(data, {
    itemId, tipo: 'entrada', quantidade: 2, usuarioId: ru.usuario.id, tipoEntrega: 'entrega', perfil: 'admin',
  });
  assert.strictEqual(entradaPeloAdmin.ok, true);
});

t('admin não tem essas restrições (entrada/saída livres, com ou sem usuário)', () => {
  const { data, itemId } = dataComItem(10);
  const entrada = logic.ajustarQuantidade(data, { itemId, tipo: 'entrada', quantidade: 5, perfil: 'admin' });
  assert.strictEqual(entrada.ok, true);
  const saida = logic.ajustarQuantidade(entrada.data, { itemId, tipo: 'saida', quantidade: 5, perfil: 'admin' });
  assert.strictEqual(saida.ok, true);
});

t('saida com usuário exige Entrega ou Retirada', () => {
  let { data, itemId } = dataComItem(10);
  const ru = logic.adicionarUsuario(data, { nome: 'Carlos', telefone: '27977776666' });
  data = ru.data;
  const semEntrega = logic.ajustarQuantidade(data, {
    itemId, tipo: 'saida', quantidade: 2, usuarioId: ru.usuario.id, perfil: 'default',
  });
  assert.strictEqual(semEntrega.ok, false);

  const comEntrega = logic.ajustarQuantidade(data, {
    itemId, tipo: 'saida', quantidade: 2, usuarioId: ru.usuario.id, tipoEntrega: 'entrega', perfil: 'default',
  });
  assert.strictEqual(comEntrega.ok, true);
  assert.strictEqual(comEntrega.item.quantidade, 8);
  assert.strictEqual(comEntrega.transacao.usuarioNome, 'Carlos (•6666)');
  assert.strictEqual(comEntrega.transacao.usuarioTelefone, '27977776666');
  assert.strictEqual(comEntrega.transacao.tipoEntrega, 'entrega');
  // Perfil Default: nasce sempre pendente, mesmo sem pedir (ver `ajustarQuantidade`).
  assert.strictEqual(comEntrega.transacao.pendente, true);
});

t('pendente: fica marcado quando informado, e o admin pode alternar nos dois sentidos', () => {
  let { data, itemId } = dataComItem(10);
  const ru = logic.adicionarUsuario(data, { nome: 'Diego', telefone: '27955556666' });
  data = ru.data;

  const mov = logic.ajustarQuantidade(data, {
    itemId, tipo: 'saida', quantidade: 2, usuarioId: ru.usuario.id, tipoEntrega: 'retirada', pendente: true, perfil: 'default',
  });
  assert.strictEqual(mov.ok, true);
  assert.strictEqual(mov.transacao.pendente, true);
  data = mov.data;

  const concluir = logic.definirPendenteTransacao(data, mov.transacao.id, false);
  assert.strictEqual(concluir.ok, true);
  assert.strictEqual(concluir.transacao.pendente, false);
  data = concluir.data;

  // e o inverso também funciona: admin pode voltar um concluído para pendente
  const voltarPendente = logic.definirPendenteTransacao(data, mov.transacao.id, true);
  assert.strictEqual(voltarPendente.ok, true);
  assert.strictEqual(voltarPendente.transacao.pendente, true);
});

t('definirPendenteTransacao rejeita id inexistente', () => {
  const data = logic.criarDadosIniciais();
  const res = logic.definirPendenteTransacao(data, 'mov-nao-existe', true);
  assert.strictEqual(res.ok, false);
});

t('perfil Default nunca escolhe pendente: toda saída dele nasce pendente mesmo pedindo false; Admin continua livre', () => {
  let { data, itemId } = dataComItem(10);
  const ru = logic.adicionarUsuario(data, { nome: 'Fabiana', telefone: '27966667777' });
  data = ru.data;

  const defaultTentaFalse = logic.ajustarQuantidade(data, {
    itemId, tipo: 'saida', quantidade: 1, usuarioId: ru.usuario.id, tipoEntrega: 'retirada', pendente: false, perfil: 'default',
  });
  assert.strictEqual(defaultTentaFalse.ok, true);
  assert.strictEqual(defaultTentaFalse.transacao.pendente, true); // ignora o pendente:false pedido
  data = defaultTentaFalse.data;

  const adminEscolheFalse = logic.ajustarQuantidade(data, {
    itemId, tipo: 'saida', quantidade: 1, usuarioId: ru.usuario.id, tipoEntrega: 'retirada', pendente: false, perfil: 'admin',
  });
  assert.strictEqual(adminEscolheFalse.ok, true);
  assert.strictEqual(adminEscolheFalse.transacao.pendente, false); // admin continua podendo escolher
});

t('marcarRecebidoDefaultTransacao: só marca/desmarca um controle informal, nunca muda `pendente`', () => {
  let { data, itemId } = dataComItem(10);
  const ru = logic.adicionarUsuario(data, { nome: 'Gustavo', telefone: '27966668888' });
  data = ru.data;
  const mov = logic.ajustarQuantidade(data, {
    itemId, tipo: 'saida', quantidade: 1, usuarioId: ru.usuario.id, tipoEntrega: 'retirada', perfil: 'default',
  });
  data = mov.data;

  const marcado = logic.marcarRecebidoDefaultTransacao(data, mov.transacao.id, true);
  assert.strictEqual(marcado.ok, true);
  assert.strictEqual(marcado.transacao.marcadoRecebidoDefault, true);
  assert.strictEqual(marcado.transacao.pendente, true); // continua pendente de verdade
  data = marcado.data;

  // Admin confirmando de verdade zera a marcação informal
  const confirmado = logic.definirPendenteTransacao(data, mov.transacao.id, false);
  assert.strictEqual(confirmado.ok, true);
  assert.strictEqual(confirmado.transacao.pendente, false);
  assert.strictEqual(confirmado.transacao.marcadoRecebidoDefault, false);

  assert.strictEqual(logic.marcarRecebidoDefaultTransacao(data, 'mov-nao-existe', true).ok, false);
});

t('marcarRecebidoDefaultLancamento: mesmo controle informal, agora para lançamento avulso', () => {
  let { data } = dataComItem(10);
  const ru = logic.adicionarUsuario(data, { nome: 'Helena', telefone: '27966669999' });
  data = ru.data;
  const lanc = logic.adicionarLancamento(data, { usuarioId: ru.usuario.id, valor: 15, perfil: 'default' });
  data = lanc.data;
  assert.strictEqual(lanc.lancamento.pendente, true);

  const marcado = logic.marcarRecebidoDefaultLancamento(data, lanc.lancamento.id, true);
  assert.strictEqual(marcado.ok, true);
  assert.strictEqual(marcado.lancamento.marcadoRecebidoDefault, true);
  assert.strictEqual(marcado.lancamento.pendente, true);
  data = marcado.data;

  const confirmado = logic.definirPendenteLancamento(data, lanc.lancamento.id, false);
  assert.strictEqual(confirmado.ok, true);
  assert.strictEqual(confirmado.lancamento.pendente, false);
  assert.strictEqual(confirmado.lancamento.marcadoRecebidoDefault, false);

  assert.strictEqual(logic.marcarRecebidoDefaultLancamento(data, 'lanc-nao-existe', true).ok, false);
});

t('usuário novo (com telefone obrigatório) pode ser criado na hora da movimentação', () => {
  const { data, itemId } = dataComItem(10);
  const semTelefone = logic.ajustarQuantidade(data, {
    itemId, tipo: 'saida', quantidade: 1, usuarioNomeNovo: 'Nova Pessoa', tipoEntrega: 'retirada', perfil: 'default',
  });
  // sem usuarioTelefoneNovo, nenhum usuário fica vinculado -> perfil default exige usuário numa saída
  assert.strictEqual(semTelefone.ok, false);

  const comTelefone = logic.ajustarQuantidade(data, {
    itemId, tipo: 'saida', quantidade: 1, usuarioNomeNovo: 'Nova Pessoa', usuarioTelefoneNovo: '27966665555',
    tipoEntrega: 'retirada', perfil: 'default',
  });
  assert.strictEqual(comTelefone.ok, true);
  assert.strictEqual(comTelefone.data.usuarios.some((u) => u.telefone === '27966665555'), true);
  assert.strictEqual(comTelefone.transacao.usuarioNome, 'Nova Pessoa (•5555)');
});

t('regressão: o primeiro pedido de um usuário criado na hora realmente desconta o catálogo', () => {
  // Este teste checa `data.items` (o que de fato é salvo em disco), não só o
  // `item` solto que a função devolve — foi exatamente essa diferença que
  // escondeu o bug em que a baixa de estoque não era persistida.
  const { data, itemId } = dataComItem(10);
  const res = logic.ajustarQuantidade(data, {
    itemId, tipo: 'saida', quantidade: 4, usuarioNomeNovo: 'Primeiro Pedido', usuarioTelefoneNovo: '27911112222',
    tipoEntrega: 'entrega', perfil: 'default',
  });
  assert.strictEqual(res.ok, true);
  const itemSalvo = res.data.items.find((i) => i.id === itemId);
  assert.strictEqual(itemSalvo.quantidade, 6); // 10 - 4
  assert.strictEqual(res.data.transacoes.length, 1);
  assert.strictEqual(res.data.transacoes[0].quantidadeResultante, 6);
});

t('novo usuário sem nome é identificado pelo final do telefone na movimentação', () => {
  const { data, itemId } = dataComItem(10);
  const res = logic.ajustarQuantidade(data, {
    itemId, tipo: 'saida', quantidade: 1, usuarioTelefoneNovo: '27955554444',
    tipoEntrega: 'entrega', perfil: 'default',
  });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.transacao.usuarioNome, 'Nº final 4444');
});

t('admin pode anexar foto numa movimentação sem usuário vinculado', () => {
  const { data, itemId } = dataComItem(10);
  const comoAdmin = logic.ajustarQuantidade(data, {
    itemId, tipo: 'entrada', quantidade: 1, foto: 'data:image/jpeg;base64,AAA', perfil: 'admin',
  });
  assert.strictEqual(comoAdmin.ok, true);
  assert.strictEqual(comoAdmin.transacao.foto, 'data:image/jpeg;base64,AAA');
});

console.log('== logic: consulta por usuário/item (com período) ==');

t('consultarPorUsuario soma por item e respeita o período (ou período inteiro)', () => {
  let { data, itemId } = dataComItem(100);
  const ru = logic.adicionarUsuario(data, { nome: 'Pedro', telefone: '27911112222' });
  data = ru.data;

  // 3 movimentações do mesmo usuário, em dias diferentes (manipulados diretamente para o teste)
  let r = logic.ajustarQuantidade(data, {
    itemId, tipo: 'saida', quantidade: 5, usuarioId: ru.usuario.id, tipoEntrega: 'entrega', perfil: 'default',
  });
  data = r.data;
  data.transacoes[data.transacoes.length - 1].dataDia = '2026-01-10';

  r = logic.ajustarQuantidade(data, {
    itemId, tipo: 'saida', quantidade: 3, usuarioId: ru.usuario.id, tipoEntrega: 'retirada', perfil: 'default',
  });
  data = r.data;
  data.transacoes[data.transacoes.length - 1].dataDia = '2026-02-15';

  r = logic.ajustarQuantidade(data, {
    itemId, tipo: 'entrada', quantidade: 2, usuarioId: ru.usuario.id, tipoEntrega: 'entrega', perfil: 'admin',
  });
  data = r.data;
  data.transacoes[data.transacoes.length - 1].dataDia = '2026-02-20';

  const periodoInteiro = logic.consultarPorUsuario(data, ru.usuario.id, null, null);
  assert.strictEqual(periodoInteiro.transacoes.length, 3);
  assert.strictEqual(periodoInteiro.somaPorItem[0].totalSaida, 8);
  assert.strictEqual(periodoInteiro.somaPorItem[0].totalEntrada, 2);
  assert.strictEqual(periodoInteiro.somaPorItem[0].saldoLiquido, -6);

  const periodoFevereiro = logic.consultarPorUsuario(data, ru.usuario.id, '2026-02-01', '2026-02-28');
  assert.strictEqual(periodoFevereiro.transacoes.length, 2);
  assert.strictEqual(periodoFevereiro.somaPorItem[0].totalSaida, 3);
  assert.strictEqual(periodoFevereiro.somaPorItem[0].totalEntrada, 2);
});

t('consultarPorItem soma entradas/saídas e lista usuários envolvidos', () => {
  let { data, itemId } = dataComItem(50);
  const ru1 = logic.adicionarUsuario(data, { nome: 'Ana', telefone: '27933334444' });
  data = ru1.data;
  const ru2 = logic.adicionarUsuario(data, { telefone: '27922221111' });
  data = ru2.data;

  let r = logic.ajustarQuantidade(data, {
    itemId, tipo: 'saida', quantidade: 4, usuarioId: ru1.usuario.id, tipoEntrega: 'entrega', perfil: 'default',
  });
  data = r.data;
  r = logic.ajustarQuantidade(data, {
    itemId, tipo: 'saida', quantidade: 6, usuarioId: ru2.usuario.id, tipoEntrega: 'retirada', perfil: 'default',
  });
  data = r.data;
  r = logic.ajustarQuantidade(data, { itemId, tipo: 'entrada', quantidade: 10, perfil: 'admin' });
  data = r.data;

  const resumo = logic.consultarPorItem(data, itemId, null, null);
  assert.strictEqual(resumo.totalSaida, 10);
  assert.strictEqual(resumo.totalEntrada, 10);
  assert.strictEqual(resumo.quantidadeAtual, 50);
  assert.strictEqual(resumo.usuariosEnvolvidos.length, 2);
  assert.strictEqual(resumo.usuariosEnvolvidos[0].usuarioNome, 'Nº final 1111'); // maior totalRecebido primeiro
});

console.log('== logic: histórico ==');

t('histórico agrupa por dia e lista em ordem', () => {
  let { data, itemId } = dataComItem(20);
  const r1 = logic.ajustarQuantidade(data, { itemId, tipo: 'saida', quantidade: 1, perfil: 'admin' });
  assert.strictEqual(r1.ok, true);
  data = r1.data;
  const r2 = logic.ajustarQuantidade(data, { itemId, tipo: 'entrada', quantidade: 4, perfil: 'admin' });
  assert.strictEqual(r2.ok, true);
  data = r2.data;

  const dias = logic.listarDiasComMovimentacao(data);
  assert.strictEqual(dias.length, 1);
  const hojeISO = logic.hojeISO();
  assert.strictEqual(dias[0], hojeISO);

  const transacoesHoje = logic.listarTransacoesPorDia(data, hojeISO);
  assert.strictEqual(transacoesHoje.length, 2);
});

t('excluirTodoHistorico apaga todas as transações E devolve a quantidade de cada uma ao item', () => {
  let { data, itemId } = dataComItem(10);
  const mov = logic.ajustarQuantidade(data, { itemId, tipo: 'saida', quantidade: 3, perfil: 'admin' });
  data = mov.data;
  assert.strictEqual(data.transacoes.length, 1);
  assert.strictEqual(data.items.find((i) => i.id === itemId).quantidade, 7);

  const res = logic.excluirTodoHistorico(data);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.removidos, 1);
  assert.strictEqual(res.data.transacoes.length, 0);
  assert.strictEqual(res.data.items.find((i) => i.id === itemId).quantidade, 10); // saída de 3 desfeita: volta a 10
});

t('excluirTodoHistorico: transação de item já removido do catálogo não quebra (não há o que reverter)', () => {
  let { data, itemId } = dataComItem(10);
  const mov = logic.ajustarQuantidade(data, { itemId, tipo: 'saida', quantidade: 3, perfil: 'admin' });
  data = mov.data;
  const rem = logic.removerItem(data, itemId);
  data = rem.data;

  const res = logic.excluirTodoHistorico(data);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.removidos, 1);
});

t('excluirTransacoes remove só as selecionadas, mantendo o resto do histórico, e devolve a quantidade delas', () => {
  let { data, itemId } = dataComItem(20);
  const m1 = logic.ajustarQuantidade(data, { itemId, tipo: 'saida', quantidade: 1, perfil: 'admin' });
  data = m1.data;
  const m2 = logic.ajustarQuantidade(data, { itemId, tipo: 'saida', quantidade: 2, perfil: 'admin' });
  data = m2.data;
  const m3 = logic.ajustarQuantidade(data, { itemId, tipo: 'entrada', quantidade: 5, perfil: 'admin' });
  data = m3.data;
  assert.strictEqual(data.transacoes.length, 3);
  assert.strictEqual(data.items.find((i) => i.id === itemId).quantidade, 22); // 20 -1 -2 +5

  // Desfaz a saída de 1 (m1) e a entrada de 5 (m3), mantendo só a saída de 2 (m2)
  const res = logic.excluirTransacoes(data, [m1.transacao.id, m3.transacao.id]);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.removidos, 2);
  assert.strictEqual(res.data.transacoes.length, 1);
  assert.strictEqual(res.data.transacoes[0].id, m2.transacao.id);
  assert.strictEqual(res.data.items.find((i) => i.id === itemId).quantidade, 18); // 22 +1 (saída desfeita) -5 (entrada desfeita)
});

t('excluirTransacoes exige seleção e rejeita ids que não existem', () => {
  const { data } = dataComItem(10);
  const semSelecao = logic.excluirTransacoes(data, []);
  assert.strictEqual(semSelecao.ok, false);

  const idsInexistentes = logic.excluirTransacoes(data, ['mov_inexistente']);
  assert.strictEqual(idsInexistentes.ok, false);
});

t('excluirTodosUsuarios apaga todos os usuários, mas mantém o histórico com o rótulo gravado', () => {
  let { data, itemId } = dataComItem(10);
  const ru = logic.adicionarUsuario(data, { nome: 'Bianca', telefone: '27999998888' });
  data = ru.data;
  const mov = logic.ajustarQuantidade(data, {
    itemId, tipo: 'saida', quantidade: 1, usuarioId: ru.usuario.id, tipoEntrega: 'entrega', perfil: 'default',
  });
  data = mov.data;

  const res = logic.excluirTodosUsuarios(data);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.removidos, 1);
  assert.strictEqual(res.data.usuarios.length, 0);
  assert.strictEqual(res.data.transacoes.length, 1);
  assert.strictEqual(res.data.transacoes[0].usuarioNome, 'Bianca (•8888)'); // rótulo continua gravado
});

t('desfazerTransacao apaga o registro e devolve a quantidade retirada ao item', () => {
  let { data, itemId } = dataComItem(10);
  const ru = logic.adicionarUsuario(data, { nome: 'Fernanda', telefone: '27922223333' });
  data = ru.data;
  const mov = logic.ajustarQuantidade(data, {
    itemId, tipo: 'saida', quantidade: 4, usuarioId: ru.usuario.id, tipoEntrega: 'entrega', perfil: 'default',
  });
  data = mov.data;
  assert.strictEqual(data.items.find((i) => i.id === itemId).quantidade, 6); // 10 - 4

  const res = logic.desfazerTransacao(data, mov.transacao.id);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.data.items.find((i) => i.id === itemId).quantidade, 10); // devolvido
  assert.strictEqual(res.data.transacoes.length, 0); // registro removido do histórico
});

t('desfazerTransacao rejeita id inexistente e transação que não é saída', () => {
  let { data, itemId } = dataComItem(10);
  const inexistente = logic.desfazerTransacao(data, 'mov-nao-existe');
  assert.strictEqual(inexistente.ok, false);

  const entrada = logic.ajustarQuantidade(data, { itemId, tipo: 'entrada', quantidade: 5, perfil: 'admin' });
  data = entrada.data;
  const naoSaida = logic.desfazerTransacao(data, entrada.transacao.id);
  assert.strictEqual(naoSaida.ok, false);
});

t('desfazerTransacao rejeita quando o item já foi removido do catálogo', () => {
  let { data, itemId } = dataComItem(10);
  const mov = logic.ajustarQuantidade(data, { itemId, tipo: 'saida', quantidade: 2, perfil: 'admin' });
  data = mov.data;
  const removeItem = logic.removerItem(data, itemId);
  data = removeItem.data;

  const res = logic.desfazerTransacao(data, mov.transacao.id);
  assert.strictEqual(res.ok, false);
});

console.log('== logic: backup (exportar/importar) ==');

t('exportar/importar preserva catálogo, usuários e histórico (e não inclui login do admin)', () => {
  let { data, itemId } = dataComItem(10);
  const ru = logic.adicionarUsuario(data, { nome: 'Roberto', telefone: '27911114444' });
  data = ru.data;
  const mov = logic.ajustarQuantidade(data, {
    itemId, tipo: 'saida', quantidade: 2, usuarioId: ru.usuario.id, tipoEntrega: 'entrega', perfil: 'default',
  });
  data = mov.data;

  const pacote = logic.montarPacoteExportacao(data);
  assert.strictEqual(pacote.formato, logic.FORMATO_BACKUP);
  assert.strictEqual(pacote.admin, undefined);
  assert.strictEqual(pacote.items.length, 1);
  assert.strictEqual(pacote.usuarios.length, 1);
  assert.strictEqual(pacote.transacoes.length, 1);

  // simula restaurar num app "zerado" que já tem o próprio login de admin configurado
  let appZerado = logic.criarDadosIniciais();
  appZerado = logic.configurarLoginInicial(appZerado, { usuario: 'admin-local', senha: 'senhalocal123' }).data;
  const restaurado = logic.aplicarPacoteImportacao(appZerado, pacote);
  assert.strictEqual(restaurado.ok, true);
  assert.strictEqual(restaurado.data.items.length, 1);
  assert.strictEqual(restaurado.data.usuarios.length, 1);
  assert.strictEqual(restaurado.data.transacoes.length, 1);
  assert.strictEqual(restaurado.data.lancamentos.length, 0);
  // o Admin que existia ANTES da importação total é zerado de propósito (o login criado no
  // primeiro acesso só vale até uma importação "substituir tudo" acontecer — depois dela, a
  // máquina volta a pedir a criação de um novo Admin, como se fosse instalação nova).
  assert.strictEqual(restaurado.data.admin, null);
  assert.strictEqual(restaurado.resumo.adminReiniciado, true);
});

t('importar recusa um backup "montado à mão" com HTML em ids/quantidades ou foto que não é imagem/vídeo', () => {
  const base = logic.montarPacoteExportacao(dataComItem(3).data);
  const casos = [
    (p) => { p.items[0].id = 'x"><meta http-equiv="refresh" content="0;url=https://golpe.example">'; },
    (p) => { p.items[0].quantidade = '<b>1</b>'; },
    (p) => { p.items[0].foto = 'data:image/svg+xml;base64,PHN2Zz4='.replace('image/svg+xml', 'text/html'); },
    (p) => { p.items[0].precoUnitario = Infinity; },
    (p) => { p.usuarios = [{ id: 'usr_a', nome: 'ok', extra: { aninhado: true } }]; },
  ];
  for (const estragar of casos) {
    const pacote = JSON.parse(JSON.stringify(base));
    estragar(pacote);
    assert.strictEqual(logic.aplicarPacoteImportacao(logic.criarDadosIniciais(), pacote).ok, false);
    assert.strictEqual(logic.aplicarPacoteImportacaoMesclado(logic.criarDadosIniciais(), pacote).ok, false);
  }
  // texto livre (nome, observação…) pode ter qualquer caractere — a interface sempre escapa
  const comNomeEsquisito = JSON.parse(JSON.stringify(base));
  comNomeEsquisito.items[0].nome = 'Caixa <grande> "dupla" & cia';
  assert.strictEqual(logic.aplicarPacoteImportacao(logic.criarDadosIniciais(), comNomeEsquisito).ok, true);
});

t('importar rejeita arquivo que não é um backup válido', () => {
  const data = logic.criarDadosIniciais();
  const res = logic.aplicarPacoteImportacao(data, { formato: 'outra-coisa' });
  assert.strictEqual(res.ok, false);
});

t('exportação inclui as contas de login do Default (mas nunca o login do admin) — importação total substitui as contas atuais pelas do arquivo e zera o Admin local', () => {
  let origem = logic.criarDadosIniciais();
  origem = logic.configurarLoginInicial(origem, { usuario: 'admin-origem', senha: 'senhadoadmin1' }).data;
  origem = logic.criarContaLogin(origem, { usuario: 'joao', senha: 'temporaria1' }).data;
  origem = logic.criarContaLogin(origem, { usuario: 'maria', senha: 'temporaria1' }).data;

  const pacote = logic.montarPacoteExportacao(origem);
  assert.strictEqual(pacote.admin, undefined); // login do admin nunca entra no arquivo
  assert.strictEqual(pacote.contasLogin.length, 2);

  let destino = logic.criarDadosIniciais();
  destino = logic.configurarLoginInicial(destino, { usuario: 'admin-destino', senha: 'senhalocal123' }).data;
  destino = logic.criarContaLogin(destino, { usuario: 'pedro', senha: 'temporaria1' }).data; // conta local, some na substituição total

  const res = logic.aplicarPacoteImportacao(destino, pacote);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.resumo.totalContasLogin, 2);
  assert.strictEqual(res.data.contasLogin.length, 2);
  assert.deepStrictEqual(res.data.contasLogin.map((c) => c.usuario).sort(), ['joao', 'maria']);
  // o Admin de quem RECEBEU o backup ("admin-destino") é zerado por uma importação total — o
  // login que prevalece depois dela é o que veio (ou não) do arquivo, nunca o antigo local.
  assert.strictEqual(res.data.admin, null);
});

console.log('== logic: backup (importação mesclada) ==');

t('mesclagem: item novo do arquivo é adicionado, usuário novo é adicionado', () => {
  const destino = logic.criarDadosIniciais();
  let { data: origem, itemId: itemOrigemId } = dataComItem(20);
  const ru = logic.adicionarUsuario(origem, { nome: 'Juliana', telefone: '27988887777' });
  origem = ru.data;
  const mov = logic.ajustarQuantidade(origem, {
    itemId: itemOrigemId, tipo: 'saida', quantidade: 5, usuarioId: ru.usuario.id, tipoEntrega: 'entrega', perfil: 'default',
  });
  origem = mov.data;

  const pacote = logic.montarPacoteExportacao(origem);
  const res = logic.aplicarPacoteImportacaoMesclado(destino, pacote);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.resumo.itensNovos, 1);
  assert.strictEqual(res.resumo.usuariosNovos, 1);
  assert.strictEqual(res.data.items.length, 1);
  assert.strictEqual(res.data.items[0].quantidade, 15); // item era novo aqui, entra com a quantidade do arquivo
  assert.strictEqual(res.data.usuarios.length, 1);
  assert.strictEqual(res.data.transacoes.length, 1);
  // ids remapeados para os registros locais recém-criados (não os do arquivo)
  assert.strictEqual(res.data.transacoes[0].itemId, res.data.items[0].id);
  assert.strictEqual(res.data.transacoes[0].usuarioId, res.data.usuarios[0].id);
});

t('mesclagem não toca a quantidade de um item já existente quando o arquivo não traz nenhuma movimentação nova', () => {
  // destino já tem "Refrigerante" com 10 unidades; origem tem o mesmo item (por nome), com
  // uma quantidade "de largada" totalmente diferente (30) mas SEM nenhuma transação —
  // como não há movimentação nova pra comparar, a quantidade local não é tocada.
  let { data: destino, itemId: itemDestinoId } = dataComItem(10);
  const { data: origem } = dataComItem(30);
  const pacote = logic.montarPacoteExportacao(origem);

  const res = logic.aplicarPacoteImportacaoMesclado(destino, pacote);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.resumo.itensNovos, 0);
  assert.strictEqual(res.resumo.itensAtualizados, 0); // nenhuma transação nova -> nenhum item "atualizado"
  assert.strictEqual(res.data.items.find((i) => i.id === itemDestinoId).quantidade, 10); // continua igual
});

t('mesclagem: só o que é DIFERENTE (movimentação nova) é aplicado à quantidade — o resto se mantém', () => {
  // Duas instalações que partiram do mesmo estado (10 unidades) e cada uma seguiu seu caminho:
  // localmente já saíram 2 unidades; no arquivo a ser mesclado saíram 3 (outra movimentação, com
  // outro id — evento diferente).
  let { data: destino, itemId: itemDestinoId } = dataComItem(10);
  const saidaLocal = logic.ajustarQuantidade(destino, { itemId: itemDestinoId, tipo: 'saida', quantidade: 2, perfil: 'admin' });
  destino = saidaLocal.data; // fica com 8

  let { data: origem, itemId: itemOrigemId } = dataComItem(10);
  const saidaOrigem = logic.ajustarQuantidade(origem, { itemId: itemOrigemId, tipo: 'saida', quantidade: 3, perfil: 'admin' });
  origem = saidaOrigem.data;
  const pacote = logic.montarPacoteExportacao(origem);

  const res = logic.aplicarPacoteImportacaoMesclado(destino, pacote);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.resumo.itensAtualizados, 1);
  assert.strictEqual(res.resumo.transacoesImportadas, 1); // só a saída de 3 é nova aqui
  assert.strictEqual(res.resumo.transacoesRepetidas, 0);
  // 8 (local, depois de já ter saído 2) menos a saída nova de 3 = 5 — nunca ficou negativo nem "somou"
  assert.strictEqual(res.data.items.find((i) => i.id === itemDestinoId).quantidade, 5);
  assert.strictEqual(res.data.transacoes.length, 2); // a local + a nova do arquivo
});

t('mesclar o MESMO backup de novo é um no-op: nada duplica, quantidade não muda (id do evento já existe aqui)', () => {
  let { data: destino, itemId } = dataComItem(10);
  const saida = logic.ajustarQuantidade(destino, { itemId, tipo: 'saida', quantidade: 4, perfil: 'admin' });
  destino = saida.data; // fica com 6
  const pacote = logic.montarPacoteExportacao(destino);

  // mescla o próprio backup (que já reflete exatamente o estado atual) de volta em si mesmo
  const res = logic.aplicarPacoteImportacaoMesclado(destino, pacote);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.resumo.itensNovos, 0);
  assert.strictEqual(res.resumo.itensAtualizados, 0);
  assert.strictEqual(res.resumo.transacoesImportadas, 0);
  assert.strictEqual(res.resumo.transacoesRepetidas, 1); // a mesma saída, mesmo id -> reconhecida e ignorada
  assert.strictEqual(res.data.transacoes.length, 1); // não duplicou
  assert.strictEqual(res.data.items.find((i) => i.id === itemId).quantidade, 6); // continua igual
});

t('mesclagem reconhece lançamentos avulsos e pagamentos repetidos pelo id (mesma lógica das transações)', () => {
  let { data: destino } = dataComItem(10);
  const ru = logic.adicionarUsuario(destino, { nome: 'Fernanda', telefone: '27966665555' });
  destino = ru.data;
  const lanc = logic.adicionarLancamento(destino, { usuarioId: ru.usuario.id, valor: 20, observacao: 'Combinado' });
  destino = lanc.data;
  const pag = logic.adicionarPagamento(destino, { usuarioId: ru.usuario.id, valor: 5, observacao: 'Pix parcial' });
  destino = pag.data;

  const pacote = logic.montarPacoteExportacao(destino);
  const res = logic.aplicarPacoteImportacaoMesclado(destino, pacote);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.resumo.lancamentosNovos, 0);
  assert.strictEqual(res.resumo.lancamentosRepetidos, 1);
  assert.strictEqual(res.resumo.pagamentosNovos, 0);
  assert.strictEqual(res.resumo.pagamentosRepetidos, 1);
  assert.strictEqual(res.data.lancamentos.length, 1);
  assert.strictEqual(res.data.pagamentos.length, 1);
});

t('mesclagem não duplica usuário já cadastrado (casa pelo telefone)', () => {
  let { data: destino } = dataComItem(10);
  const ruDestino = logic.adicionarUsuario(destino, { nome: 'Marcos', telefone: '27900001111' });
  destino = ruDestino.data;

  const { data: origem } = dataComItem(10);
  const ruOrigem = logic.adicionarUsuario(origem, { nome: 'Marcos (outro cadastro)', telefone: '27900001111' });
  const pacote = logic.montarPacoteExportacao(ruOrigem.data);

  const res = logic.aplicarPacoteImportacaoMesclado(destino, pacote);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.resumo.usuariosNovos, 0);
  assert.strictEqual(res.data.usuarios.length, 1);
  assert.strictEqual(res.data.usuarios[0].nome, 'Marcos'); // mantém o cadastro local, não sobrescreve
});

t('mesclagem: conta de login nova do arquivo é adicionada; uma que já existe localmente (mesmo usuário) mantém a senha local', () => {
  let destino = logic.criarDadosIniciais();
  destino = logic.criarContaLogin(destino, { usuario: 'joao', senha: 'senhaLocalDoJoao1' }).data;

  let origem = logic.criarDadosIniciais();
  origem = logic.criarContaLogin(origem, { usuario: 'joao', senha: 'senhaDiferenteDoArquivo1' }).data; // mesmo usuário
  origem = logic.criarContaLogin(origem, { usuario: 'maria', senha: 'temporaria1' }).data; // só existe no arquivo
  const pacote = logic.montarPacoteExportacao(origem);

  const res = logic.aplicarPacoteImportacaoMesclado(destino, pacote);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.resumo.contasLoginNovas, 1);
  assert.strictEqual(res.resumo.contasLoginRepetidas, 1);
  assert.strictEqual(res.data.contasLogin.length, 2);
  assert.deepStrictEqual(res.data.contasLogin.map((c) => c.usuario).sort(), ['joao', 'maria']);
  // a conta "joao" continua com a senha local — mesclar não sobrescreve
  assert.strictEqual(logic.verificarLogin(res.data, 'joao', 'senhaLocalDoJoao1').ok, true);
  assert.strictEqual(logic.verificarLogin(res.data, 'joao', 'senhaDiferenteDoArquivo1').ok, false);
});

t('mesclagem: uma conta de login do arquivo com o mesmo usuário do ADMIN local é ignorada (nunca cria conflito com o admin)', () => {
  let destino = logic.criarDadosIniciais();
  destino = logic.configurarLoginInicial(destino, { usuario: 'admin', senha: 'senhadoadmin1' }).data;

  let origem = logic.criarDadosIniciais();
  origem = logic.criarContaLogin(origem, { usuario: 'admin', senha: 'outraSenha1' }).data; // colide com o usuário do admin local
  const pacote = logic.montarPacoteExportacao(origem);

  const res = logic.aplicarPacoteImportacaoMesclado(destino, pacote);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.resumo.contasLoginNovas, 0);
  assert.strictEqual(res.resumo.contasLoginRepetidas, 0);
  assert.strictEqual(res.resumo.contasLoginIgnoradasColisaoAdmin, 1); // contado à parte, não como "já existia"
  assert.strictEqual(res.data.contasLogin.length, 0);
});

t('importação TOTAL zera o Admin local mesmo quando o arquivo importado tem uma conta com o mesmo nome de usuário do Admin — depois da importação essa conta já consegue logar normalmente, sem ficar "atrás" de ninguém', () => {
  let destino = logic.criarDadosIniciais();
  destino = logic.configurarLoginInicial(destino, { usuario: 'admin', senha: 'senhadoadmin1' }).data;
  destino = logic.criarContaLogin(destino, { usuario: 'joao', senha: 'temporaria1' }).data; // conta local, some na substituição total

  let origem = logic.criarDadosIniciais();
  origem = logic.criarContaLogin(origem, { usuario: 'admin', senha: 'outraSenha1' }).data; // mesmo "usuario" do admin de destino, mas é conta do Default no arquivo
  const pacote = logic.montarPacoteExportacao(origem);

  const res = logic.aplicarPacoteImportacao(destino, pacote);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.data.admin, null); // o Admin antigo de "destino" para de valer
  assert.strictEqual(res.data.contasLogin.length, 1);
  assert.strictEqual(res.data.contasLogin[0].usuario, 'admin');
  // a conta que veio do arquivo já consegue logar de verdade (não fica mais "atrás" de nenhum admin)
  const login = logic.verificarLogin(res.data, 'admin', 'outraSenha1');
  assert.strictEqual(login.ok, true);
  assert.strictEqual(login.tipo, 'default');
  // o login antigo do Admin de "destino" não funciona mais (nem como admin, nem como default)
  assert.strictEqual(logic.verificarLogin(res.data, 'admin', 'senhadoadmin1').ok, false);
});

t('importação TOTAL funciona normalmente quando não há nenhuma conta de login no arquivo — mesmo assim o Admin local é zerado e a máquina volta a pedir a criação de um novo', () => {
  let destino = logic.criarDadosIniciais();
  destino = logic.configurarLoginInicial(destino, { usuario: 'admin-destino', senha: 'senhadoadmin1' }).data;

  let origem = logic.criarDadosIniciais();
  origem = logic.criarContaLogin(origem, { usuario: 'joao', senha: 'temporaria1' }).data;
  const pacote = logic.montarPacoteExportacao(origem);

  const res = logic.aplicarPacoteImportacao(destino, pacote);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.data.contasLogin.length, 1);
  assert.strictEqual(res.data.contasLogin[0].usuario, 'joao');
  assert.strictEqual(res.data.admin, null); // Admin local é sempre zerado numa importação total
});

t('configurarLoginInicial rejeita escolher pro novo Admin um usuário que já é de uma conta do Default (evita recriar o mesmo problema logo depois de uma importação total)', () => {
  let data = logic.criarDadosIniciais();
  data = logic.criarContaLogin(data, { usuario: 'joao', senha: 'temporaria1' }).data;

  const res = logic.configurarLoginInicial(data, { usuario: 'joao', senha: 'novasenha1' });
  assert.strictEqual(res.ok, false);
  assert.ok(/já existe uma conta de login/i.test(res.erro));

  // com outro usuário, funciona normalmente
  const ok = logic.configurarLoginInicial(data, { usuario: 'admin-novo', senha: 'novasenha1' });
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.data.admin.usuario, 'admin-novo');
});

t('mesclagem rejeita arquivo que não é um backup válido', () => {
  const data = logic.criarDadosIniciais();
  const res = logic.aplicarPacoteImportacaoMesclado(data, { formato: 'outra-coisa' });
  assert.strictEqual(res.ok, false);
});

t('movimentação feita direto no app fica marcada como não-importada (local)', () => {
  const { data, itemId } = dataComItem(10);
  const res = logic.ajustarQuantidade(data, { itemId, tipo: 'entrada', quantidade: 1, perfil: 'admin' });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.transacao.importado, false);
  assert.strictEqual(res.data.transacoes[0].importado, false);
});

t('importação total marca todo o histórico resultante como importado', () => {
  let { data: origem, itemId: itemOrigemId } = dataComItem(20);
  const mov = logic.ajustarQuantidade(origem, { itemId: itemOrigemId, tipo: 'entrada', quantidade: 1, perfil: 'admin' });
  origem = mov.data;
  const pacote = logic.montarPacoteExportacao(origem);

  const destino = logic.criarDadosIniciais();
  const res = logic.aplicarPacoteImportacao(destino, pacote);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.data.transacoes.length, 1);
  assert.strictEqual(res.data.transacoes[0].importado, true);
});

t('mesclagem marca as transações trazidas pelo arquivo como importadas, sem afetar as locais', () => {
  let { data: destino, itemId: itemDestinoId } = dataComItem(10);
  const movLocal = logic.ajustarQuantidade(destino, { itemId: itemDestinoId, tipo: 'entrada', quantidade: 1, perfil: 'admin' });
  destino = movLocal.data;

  let { data: origem, itemId: itemOrigemId } = dataComItem(5);
  const movOrigem = logic.ajustarQuantidade(origem, { itemId: itemOrigemId, tipo: 'entrada', quantidade: 1, perfil: 'admin' });
  origem = movOrigem.data;
  const pacote = logic.montarPacoteExportacao(origem);

  const res = logic.aplicarPacoteImportacaoMesclado(destino, pacote);
  assert.strictEqual(res.ok, true);
  const transacaoLocal = res.data.transacoes.find((t) => t.id === movLocal.transacao.id);
  const transacaoImportada = res.data.transacoes.find((t) => t.id !== movLocal.transacao.id);
  assert.strictEqual(transacaoLocal.importado, false);
  assert.strictEqual(transacaoImportada.importado, true);
});

t('uma nova mesclagem faz a importação anterior virar "local" e só a nova fica marcada', () => {
  const destinoInicial = logic.criarDadosIniciais();

  // Primeira mesclagem (arquivo A, item com nome próprio pra não casar com nada local)
  let origemA = logic.criarDadosIniciais();
  const addA = logic.adicionarItem(origemA, { nome: 'Item A', quantidade: 5 });
  origemA = addA.data;
  const movA = logic.ajustarQuantidade(origemA, { itemId: addA.item.id, tipo: 'entrada', quantidade: 1, perfil: 'admin' });
  origemA = movA.data;
  const pacoteA = logic.montarPacoteExportacao(origemA);
  const resA = logic.aplicarPacoteImportacaoMesclado(destinoInicial, pacoteA);
  assert.strictEqual(resA.ok, true);
  assert.strictEqual(resA.data.transacoes.length, 1);
  const idTransacaoA = resA.data.transacoes[0].id;
  assert.strictEqual(resA.data.transacoes[0].importado, true);

  // Segunda mesclagem (arquivo B, outro item) — a transação do arquivo A deve virar "local"
  let origemB = logic.criarDadosIniciais();
  const addB = logic.adicionarItem(origemB, { nome: 'Item B', quantidade: 3 });
  origemB = addB.data;
  const movB = logic.ajustarQuantidade(origemB, { itemId: addB.item.id, tipo: 'entrada', quantidade: 1, perfil: 'admin' });
  origemB = movB.data;
  const pacoteB = logic.montarPacoteExportacao(origemB);
  const resB = logic.aplicarPacoteImportacaoMesclado(resA.data, pacoteB);
  assert.strictEqual(resB.ok, true);
  assert.strictEqual(resB.data.transacoes.length, 2);

  const transacaoAAgora = resB.data.transacoes.find((t) => t.id === idTransacaoA);
  assert.strictEqual(transacaoAAgora.importado, false); // virou local

  const transacaoB = resB.data.transacoes.find((t) => t.id !== idTransacaoA);
  assert.strictEqual(transacaoB.importado, true); // a nova é que fica marcada
});

console.log('== logic: precificação ==');

t('item novo começa com valor unitário zero; definirPrecoItem define o valor', () => {
  const { data, itemId } = dataComItem(10);
  const item = data.items.find((i) => i.id === itemId);
  assert.strictEqual(item.precoUnitario, 0);

  const res = logic.definirPrecoItem(data, itemId, 12.5);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.item.precoUnitario, 12.5);
});

t('definirPrecoItem rejeita valor inválido ou negativo, e item inexistente', () => {
  const { data, itemId } = dataComItem(10);
  assert.strictEqual(logic.definirPrecoItem(data, itemId, -5).ok, false);
  assert.strictEqual(logic.definirPrecoItem(data, itemId, 'abc').ok, false);
  assert.strictEqual(logic.definirPrecoItem(data, 'item-nao-existe', 10).ok, false);
});

t('listarPrecificacao calcula valor em estoque, saído (concluído) e pendente por item e no total', () => {
  let { data, itemId } = dataComItem(20);
  const precificado = logic.definirPrecoItem(data, itemId, 10); // R$ 10 por unidade
  data = precificado.data;

  const ru = logic.adicionarUsuario(data, { nome: 'Larissa', telefone: '27911119999' });
  data = ru.data;

  // 3 concluída (paga) + 2 pendente, saindo do estoque de 20 -> sobra 15. Só o Admin pode criar
  // já como concluída (pendente: false) — o Default nasce sempre pendente (ver `ajustarQuantidade`).
  const saidaConcluida = logic.ajustarQuantidade(data, {
    itemId, tipo: 'saida', quantidade: 3, usuarioId: ru.usuario.id, tipoEntrega: 'entrega', pendente: false, perfil: 'admin',
  });
  data = saidaConcluida.data;
  const saidaPendente = logic.ajustarQuantidade(data, {
    itemId, tipo: 'saida', quantidade: 2, usuarioId: ru.usuario.id, tipoEntrega: 'retirada', pendente: true, perfil: 'default',
  });
  data = saidaPendente.data;

  const resultado = logic.listarPrecificacao(data);
  const linha = resultado.itens.find((l) => l.itemId === itemId);
  assert.strictEqual(linha.quantidade, 15);
  assert.strictEqual(linha.precoUnitario, 10);
  assert.strictEqual(linha.valorEstoque, 150); // 15 x 10
  assert.strictEqual(linha.valorSaida, 30); // 3 x 10 (concluído)
  assert.strictEqual(linha.valorPendente, 20); // 2 x 10 (pendente)

  assert.strictEqual(resultado.totalEstoque, 150);
  assert.strictEqual(resultado.totalSaida, 30);
  assert.strictEqual(resultado.totalPendente, 20);
});

t('exigirPreco bloqueia saída de item sem valor definido, mas só quando enviado (fluxo de registro em lote)', () => {
  const { data, itemId } = dataComItem(10);
  // item ainda não tem preço (fica 0 por padrão) — exigirPreco bloqueia
  const bloqueado = logic.ajustarQuantidade(data, {
    itemId, tipo: 'saida', quantidade: 1, perfil: 'admin', exigirPreco: true,
  });
  assert.strictEqual(bloqueado.ok, false);

  // sem exigirPreco, a mesma saída funciona normalmente (comportamento de sempre)
  const semExigencia = logic.ajustarQuantidade(data, { itemId, tipo: 'saida', quantidade: 1, perfil: 'admin' });
  assert.strictEqual(semExigencia.ok, true);

  // depois de definir o preço, exigirPreco deixa de bloquear
  const precificado = logic.definirPrecoItem(data, itemId, 5);
  const liberado = logic.ajustarQuantidade(precificado.data, {
    itemId, tipo: 'saida', quantidade: 1, perfil: 'admin', exigirPreco: true,
  });
  assert.strictEqual(liberado.ok, true);

  // exigirPreco nunca bloqueia entrada, mesmo sem preço definido
  const entradaLivre = logic.ajustarQuantidade(data, {
    itemId, tipo: 'entrada', quantidade: 1, perfil: 'admin', exigirPreco: true,
  });
  assert.strictEqual(entradaLivre.ok, true);
});

console.log('== logic: lançamentos avulsos (valor + observação, sem item) ==');

t('adicionarLancamento cria uma pendência de valor pra um usuário, sem vincular item nenhum', () => {
  let { data } = dataComItem(10);
  const ru = logic.adicionarUsuario(data, { nome: 'Patrícia', telefone: '27933338888' });
  data = ru.data;

  const semUsuario = logic.adicionarLancamento(data, { usuarioId: 'usr-nao-existe', valor: 50 });
  assert.strictEqual(semUsuario.ok, false);

  const semValor = logic.adicionarLancamento(data, { usuarioId: ru.usuario.id, valor: 0, observacao: 'teste' });
  assert.strictEqual(semValor.ok, false);

  const res = logic.adicionarLancamento(data, {
    usuarioId: ru.usuario.id, valor: 37.5, observacao: 'Cobrança avulsa combinada por telefone',
  });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.lancamento.valor, 37.5);
  assert.strictEqual(res.lancamento.pendente, true); // nasce pendente
  assert.strictEqual(res.lancamento.observacao, 'Cobrança avulsa combinada por telefone');
  assert.strictEqual(res.lancamento.usuarioId, ru.usuario.id);
  assert.strictEqual(res.data.lancamentos.length, 1);
});

t('adicionarLancamento: o perfil Default pode lançar normalmente, exceto valor positivo pra usuário bloqueado pelo Admin', () => {
  let { data } = dataComItem(10);
  const ru = logic.adicionarUsuario(data, { nome: 'Patrícia', telefone: '27933338888' });
  data = ru.data;

  // Default consegue lançar normalmente (usuário não bloqueado)
  const semBloqueio = logic.adicionarLancamento(data, { usuarioId: ru.usuario.id, valor: 10, perfil: 'default' });
  assert.strictEqual(semBloqueio.ok, true);
  data = semBloqueio.data;

  // Admin bloqueia o usuário
  const bloq = logic.definirBloqueioUsuario(data, ru.usuario.id, true);
  data = bloq.data;

  // Default agora é rejeitado pra valor positivo (cobrança)
  const comBloqueio = logic.adicionarLancamento(data, { usuarioId: ru.usuario.id, valor: 10, perfil: 'default' });
  assert.strictEqual(comBloqueio.ok, false);

  // Admin continua livre mesmo com o usuário bloqueado
  const comoAdmin = logic.adicionarLancamento(data, { usuarioId: ru.usuario.id, valor: 10, perfil: 'admin' });
  assert.strictEqual(comoAdmin.ok, true);
});

t('adicionarLancamento: mesmo bloqueado, o Default pode lançar valor NEGATIVO (crédito/desconto) pro usuário', () => {
  let { data } = dataComItem(10);
  const ru = logic.adicionarUsuario(data, { nome: 'Otávio', telefone: '27933339999' });
  data = ru.data;
  const bloq = logic.definirBloqueioUsuario(data, ru.usuario.id, true);
  data = bloq.data;

  const negativo = logic.adicionarLancamento(data, { usuarioId: ru.usuario.id, valor: -15, perfil: 'default' });
  assert.strictEqual(negativo.ok, true);
  assert.strictEqual(negativo.lancamento.valor, -15);
  data = negativo.data;

  // Valor zero continua sempre rejeitado, bloqueado ou não
  assert.strictEqual(logic.adicionarLancamento(data, { usuarioId: ru.usuario.id, valor: 0, perfil: 'default' }).ok, false);
  assert.strictEqual(logic.adicionarLancamento(data, { usuarioId: ru.usuario.id, valor: 0, perfil: 'admin' }).ok, false);
});

t('listarLancamentosPorUsuario só traz os lançamentos daquele usuário; definirPendenteLancamento alterna nos dois sentidos', () => {
  let { data } = dataComItem(10);
  const ru1 = logic.adicionarUsuario(data, { nome: 'Igor', telefone: '27944445555' });
  data = ru1.data;
  const ru2 = logic.adicionarUsuario(data, { nome: 'Sofia', telefone: '27955556666' });
  data = ru2.data;

  const l1 = logic.adicionarLancamento(data, { usuarioId: ru1.usuario.id, valor: 20, observacao: 'A' });
  data = l1.data;
  const l2 = logic.adicionarLancamento(data, { usuarioId: ru2.usuario.id, valor: 30, observacao: 'B' });
  data = l2.data;

  const doUsuario1 = logic.listarLancamentosPorUsuario(data, ru1.usuario.id);
  assert.strictEqual(doUsuario1.length, 1);
  assert.strictEqual(doUsuario1[0].observacao, 'A');

  const concluir = logic.definirPendenteLancamento(data, l1.lancamento.id, false);
  assert.strictEqual(concluir.ok, true);
  assert.strictEqual(concluir.lancamento.pendente, false);
  data = concluir.data;

  const voltarPendente = logic.definirPendenteLancamento(data, l1.lancamento.id, true);
  assert.strictEqual(voltarPendente.ok, true);
  assert.strictEqual(voltarPendente.lancamento.pendente, true);

  const inexistente = logic.definirPendenteLancamento(data, 'lanc-nao-existe', true);
  assert.strictEqual(inexistente.ok, false);
});

t('consultarPorUsuario inclui os lançamentos avulsos do usuário, respeitando o período', () => {
  let { data } = dataComItem(10);
  const ru = logic.adicionarUsuario(data, { nome: 'Tales', telefone: '27966667777' });
  data = ru.data;
  const l = logic.adicionarLancamento(data, { usuarioId: ru.usuario.id, valor: 15, observacao: 'X' });
  data = l.data;

  const resultado = logic.consultarPorUsuario(data, ru.usuario.id, null, null);
  assert.strictEqual(resultado.lancamentos.length, 1);
  assert.strictEqual(resultado.lancamentos[0].valor, 15);
});

t('backup preserva lançamentos avulsos (exportar/importar total e mesclado)', () => {
  let { data: origem, itemId } = dataComItem(10);
  const ru = logic.adicionarUsuario(origem, { nome: 'Vinícius', telefone: '27977778888' });
  origem = ru.data;
  const lanc = logic.adicionarLancamento(origem, { usuarioId: ru.usuario.id, valor: 42, observacao: 'Pendência solta' });
  origem = lanc.data;

  const pacote = logic.montarPacoteExportacao(origem);
  assert.strictEqual(pacote.lancamentos.length, 1);

  const destinoTotal = logic.criarDadosIniciais();
  const restaurado = logic.aplicarPacoteImportacao(destinoTotal, pacote);
  assert.strictEqual(restaurado.ok, true);
  assert.strictEqual(restaurado.data.lancamentos.length, 1);
  assert.strictEqual(restaurado.data.lancamentos[0].valor, 42);

  const destinoMesclado = logic.criarDadosIniciais();
  const mesclado = logic.aplicarPacoteImportacaoMesclado(destinoMesclado, pacote);
  assert.strictEqual(mesclado.ok, true);
  assert.strictEqual(mesclado.data.lancamentos.length, 1);
  // o usuarioId foi remapeado pro usuário local recém-criado, não o do arquivo
  assert.strictEqual(mesclado.data.lancamentos[0].usuarioId, mesclado.data.usuarios[0].id);
});

console.log('== logic: pagamentos e pendências (aba "Pendências") ==');

t('adicionarPagamento exige usuário, valor > 0 e comentário; cria o registro quando válido', () => {
  let { data } = dataComItem(10);
  const ru = logic.adicionarUsuario(data, { nome: 'Bianca', telefone: '27911112222' });
  data = ru.data;

  assert.strictEqual(logic.adicionarPagamento(data, { usuarioId: 'usr-nao-existe', valor: 10, observacao: 'x' }).ok, false);
  assert.strictEqual(logic.adicionarPagamento(data, { usuarioId: ru.usuario.id, valor: 0, observacao: 'x' }).ok, false);
  assert.strictEqual(logic.adicionarPagamento(data, { usuarioId: ru.usuario.id, valor: 10, observacao: '  ' }).ok, false);

  const res = logic.adicionarPagamento(data, { usuarioId: ru.usuario.id, valor: 25.5, observacao: 'Pix recebido hoje' });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.pagamento.valor, 25.5);
  assert.strictEqual(res.pagamento.observacao, 'Pix recebido hoje');
  assert.strictEqual(res.pagamento.usuarioId, ru.usuario.id);
  assert.strictEqual(res.data.pagamentos.length, 1);
});

t('adicionarPagamento: o perfil Default pode registrar normalmente, exceto pra usuário bloqueado pelo Admin', () => {
  let { data } = dataComItem(10);
  const ru = logic.adicionarUsuario(data, { nome: 'Bianca', telefone: '27911112222' });
  data = ru.data;

  const semBloqueio = logic.adicionarPagamento(data, {
    usuarioId: ru.usuario.id, valor: 10, observacao: 'Pix', perfil: 'default',
  });
  assert.strictEqual(semBloqueio.ok, true);
  data = semBloqueio.data;

  data = logic.definirBloqueioUsuario(data, ru.usuario.id, true).data;

  const comBloqueio = logic.adicionarPagamento(data, {
    usuarioId: ru.usuario.id, valor: 10, observacao: 'Pix', perfil: 'default',
  });
  assert.strictEqual(comBloqueio.ok, false);

  const comoAdmin = logic.adicionarPagamento(data, {
    usuarioId: ru.usuario.id, valor: 10, observacao: 'Pix', perfil: 'admin',
  });
  assert.strictEqual(comoAdmin.ok, true);
});

t('listarPagamentosPorUsuario só traz os pagamentos daquele usuário', () => {
  let { data } = dataComItem(10);
  const ru1 = logic.adicionarUsuario(data, { nome: 'Caio', telefone: '27922223333' });
  data = ru1.data;
  const ru2 = logic.adicionarUsuario(data, { nome: 'Duda', telefone: '27933334444' });
  data = ru2.data;

  const p1 = logic.adicionarPagamento(data, { usuarioId: ru1.usuario.id, valor: 10, observacao: 'A' });
  data = p1.data;
  const p2 = logic.adicionarPagamento(data, { usuarioId: ru2.usuario.id, valor: 20, observacao: 'B' });
  data = p2.data;

  const doUsuario1 = logic.listarPagamentosPorUsuario(data, ru1.usuario.id);
  assert.strictEqual(doUsuario1.length, 1);
  assert.strictEqual(doUsuario1[0].observacao, 'A');
});

t('detalharPendenciasUsuario soma saídas pendentes + lançamentos pendentes, menos pagamentos', () => {
  let { data, itemId } = dataComItem(20);
  data = logic.definirPrecoItem(data, itemId, 10).data; // R$ 10/un
  const ru = logic.adicionarUsuario(data, { nome: 'Eliza', telefone: '27944445566' });
  data = ru.data;

  // Saída pendente: 3 un x R$10 = R$30
  const saida = logic.ajustarQuantidade(data, {
    itemId, tipo: 'saida', quantidade: 3, usuarioId: ru.usuario.id, tipoEntrega: 'entrega', pendente: true, perfil: 'admin',
  });
  data = saida.data;

  // Lançamento avulso pendente: R$15
  const lanc = logic.adicionarLancamento(data, { usuarioId: ru.usuario.id, valor: 15, observacao: 'Extra' });
  data = lanc.data;

  // Sem pagamento ainda: pendência total = 30 + 15 = 45
  let detalhe = logic.detalharPendenciasUsuario(data, ru.usuario.id);
  assert.strictEqual(detalhe.pendencias.length, 2);
  assert.strictEqual(detalhe.totalPendencias, 45);
  assert.strictEqual(detalhe.totalPagamentos, 0);
  assert.strictEqual(detalhe.totalPendente, 45);
  assert.strictEqual(detalhe.bloqueadoParaDefault, false); // ver `definirBloqueioUsuario`

  // Pagamento parcial de R$20 abate o total, sem mexer no status de nenhuma pendência
  const pag = logic.adicionarPagamento(data, { usuarioId: ru.usuario.id, valor: 20, observacao: 'Pagamento parcial' });
  data = pag.data;
  detalhe = logic.detalharPendenciasUsuario(data, ru.usuario.id);
  assert.strictEqual(detalhe.totalPagamentos, 20);
  assert.strictEqual(detalhe.totalPendente, 25); // 45 - 20
  assert.strictEqual(detalhe.pendencias.length, 2); // pendências continuam lá, intactas
  const transacaoAtual = data.transacoes.find((t) => t.id === saida.transacao.id);
  assert.strictEqual(transacaoAtual.pendente, true); // pagamento não altera o status individual

  // Marcando a saída como concluída manualmente, ela some do detalhamento
  const concluida = logic.definirPendenteTransacao(data, saida.transacao.id, false);
  data = concluida.data;
  detalhe = logic.detalharPendenciasUsuario(data, ru.usuario.id);
  assert.strictEqual(detalhe.pendencias.length, 1); // só o lançamento continua pendente
  assert.strictEqual(detalhe.totalPendencias, 15);
  assert.strictEqual(detalhe.totalPendente, -5); // pagamento de 20 já cobre os 15 + sobra
});

t('ajustarQuantidade grava precoUnitarioNaHora (foto do preço no momento da movimentação)', () => {
  let { data, itemId } = dataComItem(10);
  data = logic.definirPrecoItem(data, itemId, 7.5).data;

  const saida = logic.ajustarQuantidade(data, { itemId, tipo: 'saida', quantidade: 2, perfil: 'admin' });
  assert.strictEqual(saida.transacao.precoUnitarioNaHora, 7.5);

  // Item sem preço definido (0) grava null, não 0 — deixa claro que "não tinha preço"
  // em vez de parecer que o preço registrado de fato era zero.
  const { data: data2, itemId: itemId2 } = dataComItem(10);
  const saidaSemPreco = logic.ajustarQuantidade(data2, { itemId: itemId2, tipo: 'saida', quantidade: 1, perfil: 'admin' });
  assert.strictEqual(saidaSemPreco.transacao.precoUnitarioNaHora, null);
});

t('pendência de item removido do catálogo mantém quantidade e valor (usa o último preço conhecido do item)', () => {
  let { data, itemId } = dataComItem(20);
  data = logic.definirPrecoItem(data, itemId, 10).data; // R$ 10/un
  const ru = logic.adicionarUsuario(data, { nome: 'Ivo', telefone: '27988889900' });
  data = ru.data;

  // Saída pendente: 4 un x R$10 = R$40, feita enquanto o item ainda tinha preço 10.
  const saida = logic.ajustarQuantidade(data, {
    itemId, tipo: 'saida', quantidade: 4, usuarioId: ru.usuario.id, tipoEntrega: 'retirada', pendente: true, perfil: 'admin',
  });
  data = saida.data;

  // Enquanto o item ainda existe, o valor usa o preço ATUAL (comportamento antigo,
  // inalterado): se o admin corrige o preço antes do pagamento, a pendência acompanha.
  data = logic.definirPrecoItem(data, itemId, 12).data;
  let detalhe = logic.detalharPendenciasUsuario(data, ru.usuario.id);
  assert.strictEqual(detalhe.totalPendencias, 48); // 4 x 12 (preço atual)

  // Remove o item do catálogo (Precificação/Catálogo perdem o item por completo — o
  // histórico da retirada, porém, tem que continuar valendo o que valia).
  const removido = logic.removerItem(data, itemId);
  assert.strictEqual(removido.ok, true);
  data = removido.data;
  assert.strictEqual(data.items.find((i) => i.id === itemId), undefined);

  // A movimentação continua no histórico, com nome e quantidade intactos...
  const transacaoNoHistorico = data.transacoes.find((t) => t.id === saida.transacao.id);
  assert.ok(transacaoNoHistorico, 'a transação não deveria sumir do histórico');
  assert.strictEqual(transacaoNoHistorico.itemNome, 'Refrigerante');
  assert.strictEqual(transacaoNoHistorico.quantidade, 4);

  // ...e a pendência continua valendo o ÚLTIMO preço que o item teve antes de ser
  // removido (12 — o valor "congelado" em `removerItem`, não mais o de quando a
  // movimentação foi feita) — nunca R$ 0,00, o que faria a dívida da pessoa sumir da
  // aba Pendências só porque o item foi excluído do catálogo.
  detalhe = logic.detalharPendenciasUsuario(data, ru.usuario.id);
  assert.strictEqual(detalhe.pendencias.length, 1);
  assert.strictEqual(detalhe.pendencias[0].quantidade, 4);
  assert.strictEqual(detalhe.pendencias[0].valor, 48); // 4 x 12 (último preço conhecido)
  assert.strictEqual(detalhe.totalPendencias, 48);
  assert.strictEqual(detalhe.totalPendente, 48);
  assert.ok(
    logic.listarUsuariosPendentes(data).some((u) => u.usuarioId === ru.usuario.id),
    'o usuário não pode sumir da lista de pendências só porque o item da dívida foi removido'
  );
});

t('pendência de item removido continua valendo mesmo quando o preço só foi definido DEPOIS da saída (fluxo comum)', () => {
  // Cenário real: a saída é registrada primeiro (sem preço definido ainda — muito comum,
  // já que precificação costuma ser feita depois), e só então o preço é cadastrado.
  let { data, itemId } = dataComItem(20);
  const ru = logic.adicionarUsuario(data, { nome: 'Julia', telefone: '27999990011' });
  data = ru.data;

  const saida = logic.ajustarQuantidade(data, {
    itemId, tipo: 'saida', quantidade: 5, usuarioId: ru.usuario.id, tipoEntrega: 'entrega', pendente: true, perfil: 'admin',
  });
  data = saida.data;
  assert.strictEqual(saida.transacao.precoUnitarioNaHora, null); // item ainda sem preço na hora da saída

  // Só agora o preço é definido — a pendência (item ainda no catálogo) já reflete isso.
  data = logic.definirPrecoItem(data, itemId, 8).data;
  let detalhe = logic.detalharPendenciasUsuario(data, ru.usuario.id);
  assert.strictEqual(detalhe.totalPendencias, 40); // 5 x 8

  // Removendo o item agora, a pendência não pode voltar a valer R$ 0,00 só porque o
  // `precoUnitarioNaHora` gravado na hora da saída era null (sem preço na época).
  data = logic.removerItem(data, itemId).data;
  detalhe = logic.detalharPendenciasUsuario(data, ru.usuario.id);
  assert.strictEqual(detalhe.pendencias.length, 1);
  assert.strictEqual(detalhe.pendencias[0].valor, 40);
  assert.strictEqual(detalhe.totalPendente, 40);
});

t('listarUsuariosPendentes só lista quem tem saldo pendente > 0, do maior pro menor', () => {
  let { data, itemId } = dataComItem(20);
  data = logic.definirPrecoItem(data, itemId, 10).data;

  const ru1 = logic.adicionarUsuario(data, { nome: 'Fábio', telefone: '27955556677' });
  data = ru1.data;
  const ru2 = logic.adicionarUsuario(data, { nome: 'Gabriela', telefone: '27966667788' });
  data = ru2.data;
  const ru3 = logic.adicionarUsuario(data, { nome: 'Heitor', telefone: '27977778899' });
  data = ru3.data;

  // ru1: pendência de 20 (2 un x 10), sem pagamento -> pendente
  const s1 = logic.ajustarQuantidade(data, {
    itemId, tipo: 'saida', quantidade: 2, usuarioId: ru1.usuario.id, tipoEntrega: 'entrega', pendente: true, perfil: 'admin',
  });
  data = s1.data;

  // ru2: pendência de 50 (5 un x 10), sem pagamento -> maior pendência
  const s2 = logic.ajustarQuantidade(data, {
    itemId, tipo: 'saida', quantidade: 5, usuarioId: ru2.usuario.id, tipoEntrega: 'retirada', pendente: true, perfil: 'admin',
  });
  data = s2.data;

  // ru3: pendência de 10, mas paga os 10 -> saldo zerado, não deve aparecer
  const s3 = logic.ajustarQuantidade(data, {
    itemId, tipo: 'saida', quantidade: 1, usuarioId: ru3.usuario.id, tipoEntrega: 'entrega', pendente: true, perfil: 'admin',
  });
  data = s3.data;
  const pagQuitaTudo = logic.adicionarPagamento(data, { usuarioId: ru3.usuario.id, valor: 10, observacao: 'Quitado' });
  data = pagQuitaTudo.data;

  const lista = logic.listarUsuariosPendentes(data);
  assert.strictEqual(lista.length, 2);
  assert.strictEqual(lista[0].usuarioId, ru2.usuario.id); // maior pendência primeiro
  assert.strictEqual(lista[0].totalPendente, 50);
  assert.strictEqual(lista[1].usuarioId, ru1.usuario.id);
  assert.strictEqual(lista[1].totalPendente, 20);

  // ru3 pagou tudo — some dos pendentes, mas aparece na "segunda coluna" dos quitados;
  // ru1/ru2 ainda devem, então não aparecem lá; Fábio (ru1)/Gabriela (ru2)/Heitor (ru3) nunca
  // pagaram nada além disso, então só o Heitor tem pagamento > 0.
  const quitados = logic.listarUsuariosQuitados(data);
  assert.strictEqual(quitados.length, 1);
  assert.strictEqual(quitados[0].usuarioId, ru3.usuario.id);
  assert.strictEqual(quitados[0].totalPago, 10);
});

t('listarUsuariosQuitados: ninguém aparece antes de pagar, e some de novo se a pendência voltar', () => {
  let { data, itemId } = dataComItem(20);
  data = logic.definirPrecoItem(data, itemId, 5).data;
  const ru = logic.adicionarUsuario(data, { nome: 'Íris', telefone: '27988887766' });
  data = ru.data;

  // Ainda sem nenhuma movimentação — usuário não deve aparecer em nenhuma das duas listas
  assert.deepStrictEqual(logic.listarUsuariosPendentes(data), []);
  assert.deepStrictEqual(logic.listarUsuariosQuitados(data), []);

  data = logic.ajustarQuantidade(data, {
    itemId, tipo: 'saida', quantidade: 2, usuarioId: ru.usuario.id, tipoEntrega: 'retirada', pendente: true, perfil: 'admin',
  }).data;
  assert.strictEqual(logic.listarUsuariosPendentes(data).length, 1);
  assert.deepStrictEqual(logic.listarUsuariosQuitados(data), []);

  data = logic.adicionarPagamento(data, { usuarioId: ru.usuario.id, valor: 10, observacao: 'Pago tudo' }).data;
  assert.deepStrictEqual(logic.listarUsuariosPendentes(data), []); // quitado, some dos pendentes
  let quitados = logic.listarUsuariosQuitados(data);
  assert.strictEqual(quitados.length, 1);
  assert.strictEqual(quitados[0].totalPago, 10);

  // Nova pendência depois de quitado — volta pros pendentes e some dos quitados de novo
  data = logic.ajustarQuantidade(data, {
    itemId, tipo: 'saida', quantidade: 1, usuarioId: ru.usuario.id, tipoEntrega: 'retirada', pendente: true, perfil: 'admin',
  }).data;
  assert.strictEqual(logic.listarUsuariosPendentes(data).length, 1);
  assert.deepStrictEqual(logic.listarUsuariosQuitados(data), []);
});

t('totalizarPendencias: soma pendências, pagamentos e saldo de TODOS os usuários juntos (pendentes e já quitados) — mesma conta pros dois perfis', () => {
  let { data, itemId } = dataComItem(50);
  data = logic.definirPrecoItem(data, itemId, 10).data; // R$10/un

  const r1 = logic.adicionarUsuario(data, { nome: 'Ana', telefone: '27911110001' });
  data = r1.data;
  const r2 = logic.adicionarUsuario(data, { nome: 'Bia', telefone: '27911110002' });
  data = r2.data;

  // sem nenhuma movimentação ainda — tudo zerado
  assert.deepStrictEqual(logic.totalizarPendencias(data), { totalPendencias: 0, totalPagamentos: 0, totalPendente: 0 });

  // Ana: saída pendente de R$30, ainda não paga
  data = logic.ajustarQuantidade(data, {
    itemId, tipo: 'saida', quantidade: 3, usuarioId: r1.usuario.id, tipoEntrega: 'retirada', pendente: true, perfil: 'admin',
  }).data;
  // Bia: saída pendente de R$20, paga por completo (fica "quitada")
  data = logic.ajustarQuantidade(data, {
    itemId, tipo: 'saida', quantidade: 2, usuarioId: r2.usuario.id, tipoEntrega: 'retirada', pendente: true, perfil: 'admin',
  }).data;
  data = logic.adicionarPagamento(data, { usuarioId: r2.usuario.id, valor: 20, observacao: 'Pago tudo' }).data;

  const totais = logic.totalizarPendencias(data);
  assert.strictEqual(totais.totalPendencias, 50); // 30 (Ana) + 20 (Bia) — inclui o que já foi pago
  assert.strictEqual(totais.totalPagamentos, 20); // só o pagamento da Bia
  assert.strictEqual(totais.totalPendente, 30); // só o saldo em aberto da Ana

  // bate com a soma manual de listarUsuariosPendentes + listarUsuariosQuitados
  const somaPendentes = logic.listarUsuariosPendentes(data).reduce((s, u) => s + u.totalPendente, 0);
  const somaQuitadosPago = logic.listarUsuariosQuitados(data).reduce((s, u) => s + u.totalPago, 0);
  assert.strictEqual(totais.totalPendente, somaPendentes);
  assert.strictEqual(totais.totalPagamentos, somaQuitadosPago);
});

t('quitarPendenciaUsuario: registra um pagamento no valor exato do saldo, zerando de vez; rejeita sem pendência ou usuário inexistente', () => {
  let { data, itemId } = dataComItem(20);
  data = logic.definirPrecoItem(data, itemId, 7).data; // R$7/un
  const ru = logic.adicionarUsuario(data, { nome: 'Joaquim', telefone: '27999990000' });
  data = ru.data;

  // Duas saídas pendentes (3 + 2 = 5 un x R$7 = R$35) e um pagamento parcial de R$10 —
  // saldo restante: 35 - 10 = 25
  data = logic.ajustarQuantidade(data, {
    itemId, tipo: 'saida', quantidade: 3, usuarioId: ru.usuario.id, tipoEntrega: 'retirada', pendente: true, perfil: 'admin',
  }).data;
  data = logic.ajustarQuantidade(data, {
    itemId, tipo: 'saida', quantidade: 2, usuarioId: ru.usuario.id, tipoEntrega: 'entrega', pendente: true, perfil: 'admin',
  }).data;
  data = logic.adicionarPagamento(data, { usuarioId: ru.usuario.id, valor: 10, observacao: 'Parcial' }).data;

  const antes = logic.detalharPendenciasUsuario(data, ru.usuario.id);
  assert.strictEqual(antes.totalPendente, 25);

  const res = logic.quitarPendenciaUsuario(data, ru.usuario.id, 'Quitado via teste');
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.pagamento.valor, 25); // exatamente o saldo que faltava, não os R$35 originais
  assert.strictEqual(res.pagamento.observacao, 'Quitado via teste');
  data = res.data;

  const depois = logic.detalharPendenciasUsuario(data, ru.usuario.id);
  assert.strictEqual(depois.totalPendente, 0);
  assert.strictEqual(logic.listarUsuariosPendentes(data).length, 0);
  assert.strictEqual(logic.listarUsuariosQuitados(data).length, 1);

  // Sem comentário — usa o padrão
  const outroUsuario = logic.adicionarUsuario(data, { nome: 'Kelly', telefone: '27911112222' });
  data = outroUsuario.data;
  data = logic.ajustarQuantidade(data, {
    itemId, tipo: 'saida', quantidade: 1, usuarioId: outroUsuario.usuario.id, tipoEntrega: 'retirada', pendente: true, perfil: 'admin',
  }).data;
  const resSemComentario = logic.quitarPendenciaUsuario(data, outroUsuario.usuario.id);
  assert.strictEqual(resSemComentario.ok, true);
  assert.strictEqual(resSemComentario.pagamento.observacao, 'Quitação total via aba Pendências');

  // Rejeita: usuário sem nenhuma pendência
  const semPendencia = logic.quitarPendenciaUsuario(data, ru.usuario.id);
  assert.strictEqual(semPendencia.ok, false);

  // Rejeita: usuário inexistente
  const inexistente = logic.quitarPendenciaUsuario(data, 'usr-nao-existe');
  assert.strictEqual(inexistente.ok, false);
});

t('listarPedidosParaRelatorio: filtra por período, só saídas, com valor precificado e total geral', () => {
  let { data, itemId } = dataComItem(50);
  data = logic.definirPrecoItem(data, itemId, 5).data; // R$ 5/un
  const ru = logic.adicionarUsuario(data, { nome: 'Karen', telefone: '27900001111' });
  data = ru.data;

  // Pedido 1 (fora do período que vamos filtrar): 3 un x R$5 = R$15
  let r = logic.ajustarQuantidade(data, {
    itemId, tipo: 'saida', quantidade: 3, usuarioId: ru.usuario.id, tipoEntrega: 'retirada', perfil: 'admin',
  });
  data = r.data;
  data.transacoes[data.transacoes.length - 1].dataDia = '2026-01-01';

  // Pedido 2 (dentro do período): 2 un x R$5 = R$10
  r = logic.ajustarQuantidade(data, {
    itemId, tipo: 'saida', quantidade: 2, usuarioId: ru.usuario.id, tipoEntrega: 'entrega', perfil: 'admin',
  });
  data = r.data;
  data.transacoes[data.transacoes.length - 1].dataDia = '2026-02-10';

  // Entrada (nunca é "pedido" — não deve aparecer no relatório mesmo estando no período)
  r = logic.ajustarQuantidade(data, { itemId, tipo: 'entrada', quantidade: 10, perfil: 'admin' });
  data = r.data;
  data.transacoes[data.transacoes.length - 1].dataDia = '2026-02-10';

  // Pedido 3 (dentro do período): 4 un x R$5 = R$20
  r = logic.ajustarQuantidade(data, {
    itemId, tipo: 'saida', quantidade: 4, usuarioId: ru.usuario.id, tipoEntrega: 'retirada', perfil: 'admin',
  });
  data = r.data;
  data.transacoes[data.transacoes.length - 1].dataDia = '2026-02-15';

  const relatorio = logic.listarPedidosParaRelatorio(data, '2026-02-01', '2026-02-28');
  assert.strictEqual(relatorio.pedidos.length, 2); // só os 2 pedidos de fevereiro, sem a entrada
  assert.strictEqual(relatorio.pedidos[0].dataDia, '2026-02-10'); // ordem cronológica (mais antigo primeiro)
  assert.strictEqual(relatorio.pedidos[0].valorTotal, 10);
  assert.strictEqual(relatorio.pedidos[1].dataDia, '2026-02-15');
  assert.strictEqual(relatorio.pedidos[1].valorTotal, 20);
  assert.strictEqual(relatorio.totalQuantidade, 6); // 2 + 4
  assert.strictEqual(relatorio.totalValor, 30); // 10 + 20

  const semFiltro = logic.listarPedidosParaRelatorio(data, null, null);
  assert.strictEqual(semFiltro.pedidos.length, 3); // os 3 pedidos, período inteiro

  // Removendo o item, o relatório de um período antigo continua com o valor que era
  // (mesma regra usada nas Pendências — ver `precoUnitarioParaTransacao`).
  data = logic.removerItem(data, itemId).data;
  const depoisDeRemover = logic.listarPedidosParaRelatorio(data, '2026-01-01', '2026-01-31');
  assert.strictEqual(depoisDeRemover.pedidos.length, 1);
  assert.strictEqual(depoisDeRemover.pedidos[0].valorTotal, 15);
});

t('listarPedidosParaRelatorio: porItem soma quantidade e valor de cada item, do que mais saiu pro que menos saiu', () => {
  let data = logic.criarDadosIniciais();
  let add = logic.adicionarItem(data, { nome: 'Refrigerante', quantidade: 50 });
  data = add.data;
  const itemRefri = add.item.id;
  add = logic.adicionarItem(data, { nome: 'Água', quantidade: 50 });
  data = add.data;
  const itemAgua = add.item.id;

  data = logic.definirPrecoItem(data, itemRefri, 5).data; // R$5/un
  data = logic.definirPrecoItem(data, itemAgua, 2).data; // R$2/un

  // Refrigerante: duas saídas no período (2 + 3 = 5 un, R$10 + R$15 = R$25)
  data = logic.ajustarQuantidade(data, {
    itemId: itemRefri, tipo: 'saida', quantidade: 2, tipoEntrega: 'retirada', perfil: 'admin',
  }).data;
  data.transacoes[data.transacoes.length - 1].dataDia = '2026-03-01';
  data = logic.ajustarQuantidade(data, {
    itemId: itemRefri, tipo: 'saida', quantidade: 3, tipoEntrega: 'retirada', perfil: 'admin',
  }).data;
  data.transacoes[data.transacoes.length - 1].dataDia = '2026-03-02';

  // Água: uma saída (6 un, R$12) — mais unidades que Refrigerante (5 un), então vem primeiro
  data = logic.ajustarQuantidade(data, {
    itemId: itemAgua, tipo: 'saida', quantidade: 6, tipoEntrega: 'entrega', perfil: 'admin',
  }).data;
  data.transacoes[data.transacoes.length - 1].dataDia = '2026-03-03';

  // Fora do período — não deve entrar na soma
  data = logic.ajustarQuantidade(data, {
    itemId: itemRefri, tipo: 'saida', quantidade: 10, tipoEntrega: 'retirada', perfil: 'admin',
  }).data;
  data.transacoes[data.transacoes.length - 1].dataDia = '2026-04-01';

  const relatorio = logic.listarPedidosParaRelatorio(data, '2026-03-01', '2026-03-31');
  assert.strictEqual(relatorio.porItem.length, 2);
  assert.strictEqual(relatorio.porItem[0].itemNome, 'Água'); // 6 un > 5 un do Refrigerante
  assert.strictEqual(relatorio.porItem[0].quantidade, 6);
  assert.strictEqual(relatorio.porItem[0].valorTotal, 12);
  assert.strictEqual(relatorio.porItem[1].itemNome, 'Refrigerante');
  assert.strictEqual(relatorio.porItem[1].quantidade, 5);
  assert.strictEqual(relatorio.porItem[1].valorTotal, 25);

  const semPedidos = logic.listarPedidosParaRelatorio(data, '2099-01-01', '2099-01-31');
  assert.deepStrictEqual(semPedidos.porItem, []);
});

t('listarQuantidadesAtuaisParaRelatorio: só itens com quantidade > 0, em ordem alfabética, com o total geral', () => {
  let data = logic.criarDadosIniciais();
  data = logic.adicionarItem(data, { nome: 'Refrigerante', quantidade: 12 }).data;
  data = logic.adicionarItem(data, { nome: 'Água', quantidade: 0 }).data; // zerado — fica de fora
  data = logic.adicionarItem(data, { nome: 'Biscoito', quantidade: 5 }).data;
  data = logic.adicionarItem(data, { nome: 'Chocolate', quantidade: 0 }).data; // zerado — fica de fora

  const relatorio = logic.listarQuantidadesAtuaisParaRelatorio(data);
  assert.strictEqual(relatorio.itens.length, 2);
  assert.strictEqual(relatorio.itens[0].nome, 'Biscoito'); // alfabética, não por quantidade
  assert.strictEqual(relatorio.itens[0].quantidade, 5);
  assert.strictEqual(relatorio.itens[1].nome, 'Refrigerante');
  assert.strictEqual(relatorio.itens[1].quantidade, 12);
  assert.strictEqual(relatorio.totalItens, 2);
  assert.strictEqual(relatorio.totalQuantidade, 17); // 12 + 5, sem contar os zerados

  // Uma saída zera um item que tinha quantidade — some do relatório na próxima chamada
  const itemBiscoito = data.items.find((i) => i.nome === 'Biscoito').id;
  data = logic.ajustarQuantidade(data, {
    itemId: itemBiscoito, tipo: 'saida', quantidade: 5, tipoEntrega: 'retirada', perfil: 'admin',
  }).data;
  const depois = logic.listarQuantidadesAtuaisParaRelatorio(data);
  assert.strictEqual(depois.itens.length, 1);
  assert.strictEqual(depois.itens[0].nome, 'Refrigerante');
  assert.strictEqual(depois.totalQuantidade, 12);

  // Catálogo vazio (ou só com zerados) — relatório vazio, sem quebrar
  const vazio = logic.listarQuantidadesAtuaisParaRelatorio(logic.criarDadosIniciais());
  assert.deepStrictEqual(vazio.itens, []);
  assert.strictEqual(vazio.totalItens, 0);
  assert.strictEqual(vazio.totalQuantidade, 0);
});

t('listarLancamentosEPagamentosPorDia junta os dois tipos do dia, marcados com tipoRegistro', () => {
  let { data } = dataComItem(10);
  const ru = logic.adicionarUsuario(data, { nome: 'Íris', telefone: '27988889900' });
  data = ru.data;

  const lanc = logic.adicionarLancamento(data, { usuarioId: ru.usuario.id, valor: 12, observacao: 'Lanç.' });
  data = lanc.data;
  const pag = logic.adicionarPagamento(data, { usuarioId: ru.usuario.id, valor: 8, observacao: 'Pag.' });
  data = pag.data;

  const hoje = logic.hojeISO();
  const doDia = logic.listarLancamentosEPagamentosPorDia(data, hoje);
  assert.strictEqual(doDia.length, 2);
  const tipos = doDia.map((r) => r.tipoRegistro).sort();
  assert.deepStrictEqual(tipos, ['lancamento', 'pagamento']);

  const outroDia = logic.listarLancamentosEPagamentosPorDia(data, '2000-01-01');
  assert.strictEqual(outroDia.length, 0);
});

t('listarHistoricoPorPeriodo: sem datas mostra TUDO; com "de"/"até" filtra, os dois opcionais', () => {
  let { data } = dataComItem(10);
  const ru = logic.adicionarUsuario(data, { nome: 'Wagner', telefone: '27988880011' });
  data = ru.data;
  const saida = logic.ajustarQuantidade(data, {
    itemId: data.items[0].id,
    tipo: 'saida',
    quantidade: 2,
    usuarioId: ru.usuario.id,
    tipoEntrega: 'retirada',
    perfil: 'admin',
  });
  assert.strictEqual(saida.ok, true);
  data = saida.data;

  const hoje = logic.hojeISO();
  const tudo = logic.listarHistoricoPorPeriodo(data, null, null);
  assert.strictEqual(tudo.length, 1);

  const soHoje = logic.listarHistoricoPorPeriodo(data, hoje, hoje);
  assert.strictEqual(soHoje.length, 1);

  const soDataInicioFutura = logic.listarHistoricoPorPeriodo(data, '2999-01-01', null);
  assert.strictEqual(soDataInicioFutura.length, 0);

  const soDataFimPassada = logic.listarHistoricoPorPeriodo(data, null, '2000-01-01');
  assert.strictEqual(soDataFimPassada.length, 0);
});

t('listarLancamentosEPagamentosPorPeriodo: sem datas mostra TUDO; com período filtra igual à versão por dia', () => {
  let { data } = dataComItem(10);
  const ru = logic.adicionarUsuario(data, { nome: 'Ximena', telefone: '27988880022' });
  data = ru.data;
  const lanc = logic.adicionarLancamento(data, { usuarioId: ru.usuario.id, valor: 12, observacao: 'Lanç.' });
  data = lanc.data;
  const pag = logic.adicionarPagamento(data, { usuarioId: ru.usuario.id, valor: 8, observacao: 'Pag.' });
  data = pag.data;

  const tudo = logic.listarLancamentosEPagamentosPorPeriodo(data, null, null);
  assert.strictEqual(tudo.length, 2);
  const tipos = tudo.map((r) => r.tipoRegistro).sort();
  assert.deepStrictEqual(tipos, ['lancamento', 'pagamento']);

  const hoje = logic.hojeISO();
  const soHoje = logic.listarLancamentosEPagamentosPorPeriodo(data, hoje, hoje);
  assert.strictEqual(soHoje.length, 2);

  const semNada = logic.listarLancamentosEPagamentosPorPeriodo(data, '2000-01-01', '2000-01-02');
  assert.strictEqual(semNada.length, 0);
});

t('backup preserva pagamentos (exportar/importar total e mesclado)', () => {
  let { data: origem } = dataComItem(10);
  const ru = logic.adicionarUsuario(origem, { nome: 'Júlio', telefone: '27999990011' });
  origem = ru.data;
  const pag = logic.adicionarPagamento(origem, { usuarioId: ru.usuario.id, valor: 33, observacao: 'Depósito' });
  origem = pag.data;

  const pacote = logic.montarPacoteExportacao(origem);
  assert.strictEqual(pacote.pagamentos.length, 1);

  const destinoTotal = logic.criarDadosIniciais();
  const restaurado = logic.aplicarPacoteImportacao(destinoTotal, pacote);
  assert.strictEqual(restaurado.ok, true);
  assert.strictEqual(restaurado.data.pagamentos.length, 1);
  assert.strictEqual(restaurado.data.pagamentos[0].valor, 33);

  const destinoMesclado = logic.criarDadosIniciais();
  const mesclado = logic.aplicarPacoteImportacaoMesclado(destinoMesclado, pacote);
  assert.strictEqual(mesclado.ok, true);
  assert.strictEqual(mesclado.data.pagamentos.length, 1);
  assert.strictEqual(mesclado.data.pagamentos[0].usuarioId, mesclado.data.usuarios[0].id);
});

console.log('== logic: editar/excluir lançamentos e pagamentos (registro das pendências) ==');

t('editarLancamento altera valor e/ou observação; rejeita valor inválido e id inexistente', () => {
  let { data } = dataComItem(10);
  const ru = logic.adicionarUsuario(data, { nome: 'Karina', telefone: '27911223344' });
  data = ru.data;
  const lanc = logic.adicionarLancamento(data, { usuarioId: ru.usuario.id, valor: 10, observacao: 'Original' });
  data = lanc.data;

  const soValor = logic.editarLancamento(data, lanc.lancamento.id, { valor: 25 });
  assert.strictEqual(soValor.ok, true);
  assert.strictEqual(soValor.lancamento.valor, 25);
  assert.strictEqual(soValor.lancamento.observacao, 'Original'); // não enviado, preserva
  data = soValor.data;

  const soObs = logic.editarLancamento(data, lanc.lancamento.id, { observacao: 'Atualizado' });
  assert.strictEqual(soObs.ok, true);
  assert.strictEqual(soObs.lancamento.valor, 25); // não enviado, preserva
  assert.strictEqual(soObs.lancamento.observacao, 'Atualizado');

  // Negativo agora é permitido (funciona como crédito/desconto) — só valor zero é rejeitado.
  const negativo = logic.editarLancamento(data, lanc.lancamento.id, { valor: -5 });
  assert.strictEqual(negativo.ok, true);
  assert.strictEqual(negativo.lancamento.valor, -5);
  data = negativo.data;

  assert.strictEqual(logic.editarLancamento(data, lanc.lancamento.id, { valor: 0 }).ok, false);
  assert.strictEqual(logic.editarLancamento(data, 'lanc-nao-existe', { valor: 10 }).ok, false);
});

t('removerLancamento apaga o registro; rejeita id inexistente', () => {
  let { data } = dataComItem(10);
  const ru = logic.adicionarUsuario(data, { nome: 'Leandro', telefone: '27922334455' });
  data = ru.data;
  const lanc = logic.adicionarLancamento(data, { usuarioId: ru.usuario.id, valor: 10, observacao: 'X' });
  data = lanc.data;

  assert.strictEqual(logic.removerLancamento(data, 'lanc-nao-existe').ok, false);
  const res = logic.removerLancamento(data, lanc.lancamento.id);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.data.lancamentos.length, 0);
});

t('editarPagamento altera valor e/ou observação; comentário não pode ficar vazio; rejeita id inexistente', () => {
  let { data } = dataComItem(10);
  const ru = logic.adicionarUsuario(data, { nome: 'Mara', telefone: '27933445566' });
  data = ru.data;
  const pag = logic.adicionarPagamento(data, { usuarioId: ru.usuario.id, valor: 10, observacao: 'Pix' });
  data = pag.data;

  const editado = logic.editarPagamento(data, pag.pagamento.id, { valor: 40, observacao: 'Dinheiro' });
  assert.strictEqual(editado.ok, true);
  assert.strictEqual(editado.pagamento.valor, 40);
  assert.strictEqual(editado.pagamento.observacao, 'Dinheiro');
  data = editado.data;

  assert.strictEqual(logic.editarPagamento(data, pag.pagamento.id, { observacao: '   ' }).ok, false);
  assert.strictEqual(logic.editarPagamento(data, pag.pagamento.id, { valor: 0 }).ok, false);
  assert.strictEqual(logic.editarPagamento(data, 'pag-nao-existe', { valor: 10 }).ok, false);
});

t('removerPagamento apaga o registro; rejeita id inexistente', () => {
  let { data } = dataComItem(10);
  const ru = logic.adicionarUsuario(data, { nome: 'Nicolas', telefone: '27944556677' });
  data = ru.data;
  const pag = logic.adicionarPagamento(data, { usuarioId: ru.usuario.id, valor: 10, observacao: 'X' });
  data = pag.data;

  assert.strictEqual(logic.removerPagamento(data, 'pag-nao-existe').ok, false);
  const res = logic.removerPagamento(data, pag.pagamento.id);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.data.pagamentos.length, 0);
});

t('excluirTodosLancamentosEPagamentos apaga os dois de uma vez, sem mexer nas transações de item', () => {
  let { data, itemId } = dataComItem(10);
  const ru = logic.adicionarUsuario(data, { nome: 'Otávio', telefone: '27955667788' });
  data = ru.data;
  const saida = logic.ajustarQuantidade(data, {
    itemId, tipo: 'saida', quantidade: 1, usuarioId: ru.usuario.id, tipoEntrega: 'entrega', pendente: true, perfil: 'admin',
  });
  data = saida.data;
  const lanc = logic.adicionarLancamento(data, { usuarioId: ru.usuario.id, valor: 10, observacao: 'X' });
  data = lanc.data;
  const pag = logic.adicionarPagamento(data, { usuarioId: ru.usuario.id, valor: 5, observacao: 'Y' });
  data = pag.data;

  const res = logic.excluirTodosLancamentosEPagamentos(data);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.removidosLancamentos, 1);
  assert.strictEqual(res.removidosPagamentos, 1);
  assert.strictEqual(res.data.lancamentos.length, 0);
  assert.strictEqual(res.data.pagamentos.length, 0);
  assert.strictEqual(res.data.transacoes.length, 1); // movimentação de item intacta
});

console.log(`\n${passou} teste(s) passaram.`);
if (process.exitCode === 1) {
  console.error('Existem falhas acima.');
} else {
  console.log('Todos os testes passaram.');
}
