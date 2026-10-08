# Controle de Estoque (Default / Admin)

Aplicativo de computador (Windows) para controlar um catálogo de itens com
foto/vídeo e quantidade, registrar quem retirou/recebeu cada item, se foi
Entrega ou Retirada (com um status de Pendente/Concluído), anexos de foto ou
vídeo por movimentação, um histórico diário e uma aba de precificação — com
dois perfis de acesso (Default e Admin) e todos os dados criptografados.

Existe em **duas formas, com as mesmas telas e as mesmas regras**:

- **App desktop (Windows)** — instalado no computador, dados num arquivo
  criptografado local (ver "Como gerar o instalador").
- **Versão web** — abre por um endereço (URL) no navegador do **PC ou do
  celular**, com os dados num banco na nuvem, publicada **sem custo nenhum**
  (GitHub + Render + Supabase, todos no plano gratuito). Ver a seção logo
  abaixo.

## Versão web (PC e celular) — publicação gratuita

### Como funciona (e por que três serviços)

O GitHub, sozinho, só hospeda **site estático** de graça — ele não roda um
servidor nem guarda um banco de dados. Por isso a versão web junta três
serviços, todos com plano **gratuito permanente** (não é período de teste):

| Serviço | Papel | Plano grátis |
|---|---|---|
| **GitHub** | Guarda o código. Cada envio dispara os testes e publica a nova versão sozinho. | Repositório privado |
| **Render** | Roda o servidor do app e dá o endereço `https://...onrender.com` (com HTTPS). | 750 h/mês, 512 MB |
| **Supabase** | Banco de dados (Postgres) + armazenamento das fotos/vídeos. | 500 MB banco + 1 GB arquivos |

As telas são as mesmas do desktop (a pasta `renderer/`), as regras são as
mesmas (`src/handlers.js` + `src/logic.js`, compartilhados) e o arquivo de
**backup é o mesmo** — dá pra exportar no desktop e importar na web (e
vice-versa).

**Limitações do plano gratuito, pra saber de antemão:**

- O servidor do Render **"dorme" depois de 15 minutos sem uso**. O primeiro
  acesso depois disso leva **cerca de 1 minuto** pra abrir (aparece um aviso
  "Conectando ao servidor…" na tela). Depois fica rápido. Quem estava logado
  continua logado quando ele acorda.
- O Supabase gratuito **pausa o projeto depois de 7 dias sem nenhum acesso**.
  Pra isso não acontecer, o próprio GitHub chama o app a cada 2 dias (ver
  passo 6). Se um dia pausar mesmo assim, é só entrar no painel do Supabase e
  clicar em "Restore project".
- Fotos continuam sendo reduzidas no navegador antes de enviar; **vídeos na
  versão web têm limite de 10 MB** cada (no desktop são 25 MB) — é o que faz
  o 1 GB gratuito durar bastante. Fotos repetidas não ocupam espaço duas
  vezes, e foto que deixou de ser usada é apagada sozinha.
- Faça **backups de vez em quando** (aba Backup) — é sua cópia de segurança
  fora da nuvem.

### Passo a passo (só na primeira vez — uns 20 minutos)

**1. Colocar o código no seu GitHub**

1. Crie um repositório **vazio e privado** em <https://github.com/new>
   (ex.: `controle-estoque`; **não** marque "Add a README").
2. Com o [Git](https://git-scm.com/download/win) instalado, dê **duplo
   clique em `PUBLICAR_NO_GITHUB.bat`** (na pasta do projeto) e cole o
   endereço do repositório quando ele pedir. Na primeira vez abre uma janela
   pra você entrar na sua conta do GitHub.
   *(Alternativa sem Git: no repositório vazio, "uploading an existing file" e
   arraste todo o conteúdo da pasta — inclusive a pasta `.github`.)*
3. Pra mandar atualizações depois, é só rodar o mesmo `.bat` de novo **na
   mesma pasta** (extraia as versões novas por cima dela).

**2. Criar o banco no Supabase**

1. Crie uma conta em <https://supabase.com> e um projeto novo (**Free**).
   Região: **East US (North Virginia)** (a mesma do servidor no Render — deixa
   as gravações mais rápidas). Anote a senha do banco que ele pedir (não é
   usada pelo app, mas é sua).
2. No menu **SQL Editor → New query**, cole o conteúdo de
   `supabase/schema.sql` e clique em **Run**. Isso cria a tabela e o espaço
   das fotos, fechados pra qualquer acesso de fora.
3. Em **Project Settings → API Keys**, copie:
   - a **Project URL** (algo como `https://abcd1234.supabase.co`);
   - uma **Secret key** (`sb_secret_...`; crie uma se não houver). Se o seu
     painel ainda mostrar o modelo antigo, use a chave `service_role` (essa
     também funciona).
   ⚠️ Essa chave dá acesso total ao banco: **nunca** coloque em lugar público.
   Ela vai só no Render (próximo passo).

**3. Publicar no Render**

1. Crie uma conta em <https://render.com> entrando **com o GitHub** e
   autorize o acesso ao repositório do passo 1.
2. **New → Blueprint**, escolha o repositório. O Render lê o arquivo
   `render.yaml` e já configura tudo (plano Free, comandos, região).
3. Ele vai pedir dois valores: `SUPABASE_URL` (a Project URL) e
   `SUPABASE_CHAVE_SECRETA` (a secret key). Clique em **Apply**.
4. Espere o deploy terminar (alguns minutos). O endereço do app aparece no
   topo do serviço: `https://controle-estoque-xxxx.onrender.com`.

**4. Guardar as duas chaves geradas (importante!)**

No Render, abra o serviço → **Environment**. Ele gerou sozinho:

- `CHAVE_DADOS` — a chave que **criptografa todos os dados** antes de irem pro
  Supabase. **Copie e guarde num lugar seguro** (gerenciador de senhas). Se ela
  se perder (ex.: apagou o serviço e criou outro), os dados no banco ficam
  ilegíveis pra sempre. O servidor se recusa a subir com uma chave diferente
  da que gravou os dados — ele nunca sobrescreve nada.
- `TOKEN_PRIMEIRO_ACESSO` — a "senha do link" que permite criar o login do
  Admin (próximo passo). Guarde também.

**5. Primeiro acesso: criar o Admin**

Abra no navegador o endereço do app **com o token no final**:

```
https://controle-estoque-xxxx.onrender.com/?configurar=COLE_O_TOKEN_AQUI
```

Aparece a tela "Crie o login de Admin" — igual ao desktop. Sem o token no
link, ninguém consegue criar o Admin (nem quem descobrir o endereço antes de
você). Depois de criado, o token some da barra de endereço; daí em diante
use o endereço normal, sem nada no final.

**6. Manter o Supabase ativo (uma vez só)**

No GitHub, no repositório: **Settings → Secrets and variables → Actions →
aba Variables → New repository variable**: nome `URL_APP`, valor = o
endereço do app (ex.: `https://controle-estoque-xxxx.onrender.com`). Pronto: o
GitHub chama o app a cada 2 dias (arquivo `.github/workflows/manter-ativo.yml`).
Dá pra testar na hora em **Actions → Manter ativo → Run workflow**.

**7. Trazer os dados do app desktop (opcional)**

No desktop, aba **Backup → Exportar**. Na web, logado como **Admin**, aba
**Backup → Importar**, escolha **"Mesclar com o que já existe"** e o arquivo.
Num app web ainda vazio, mesclar traz tudo (catálogo, fotos, usuários,
histórico, pendências e as contas de login do Default) **mantendo o Admin
que você acabou de criar**. *(Se usar "Substituir tudo", o Admin é zerado, como
no desktop — aí é só abrir de novo o link do passo 5 pra criar outro.)*

**8. No celular**

Abra o endereço no navegador do celular e use **"Adicionar à tela de
início"** (Safari: botão Compartilhar; Chrome: menu ⋮). Fica com ícone
próprio e abre em tela cheia, como um app. As telas se ajustam ao celular:
as abas rolam de lado, as tabelas largas rolam com o dedo e as janelas
abrem de baixo pra cima.

### O que muda na versão web (além do endereço)

- **PDFs**: os relatórios (pedidos, quantidades, pendência de um usuário,
  consulta) abrem numa aba nova já com a janela de impressão — escolha
  **"Salvar como PDF"** (no celular também). Se fechar a janela sem querer,
  há um botão "Imprimir / Salvar PDF" no topo do relatório. Se o navegador
  bloquear a aba, permita pop-ups para o endereço do app.
- **Backup**: exportar **baixa** o arquivo `.estoquebkp`; importar abre o
  seletor de arquivos do aparelho. O arquivo é o mesmo do desktop.
- **Mesmas regras de backup do desktop**: o Default exporta e importa
  ("substituir tudo"); "mesclar" é só do Admin. Depois de um "substituir
  tudo", o Admin desta instalação é zerado como no desktop — na web, o dono
  recria pelo link com o token (passo 5). Atenção: quem tem uma conta Default
  consegue, com isso, trocar todos os dados e contas pelos de um arquivo;
  dê contas Default só a pessoas de confiança e faça backups com frequência.
- **Vários aparelhos ao mesmo tempo**: cada navegador tem sua própria sessão
  de login. As gravações entram em fila (nunca uma sobrescreve a outra). Se
  o Admin trocar/resetar a senha de alguém, excluir uma conta ou importar um
  backup substituindo tudo, quem estava logado com aquela conta volta pra
  tela de login na hora.
- **Recriar o Admin depois de um "Substituir tudo"**: no desktop isso exige
  apagar os dados locais; na web, quem tem acesso ao painel do Render (o dono)
  usa o link com o token do passo 5.

### Segurança da versão web

- Tudo trafega por **HTTPS** (o Render fornece). Dados e fotos são
  **criptografados no servidor (AES-256-GCM) antes de ir pro Supabase**, com a
  `CHAVE_DADOS` — o Supabase só guarda texto cifrado. A tabela e o bucket são
  fechados a qualquer acesso de fora (RLS ligado, sem permissões públicas).
- Senhas: o mesmo hash (scrypt) do desktop. Em 15 minutos, **10 senhas
  erradas** pro mesmo usuário a partir do mesmo endereço de internet (ou
  **100** no total de um mesmo endereço) bloqueiam novas tentativas **daquele
  endereço** até o fim desses 15 minutos — o mesmo vale pro token do link do
  Admin e pra senha de backup. O bloqueio é sempre por endereço: ninguém
  consegue travar o login de outra pessoa errando a senha dela de propósito.
- Backups importados passam por uma conferência de formato (números são
  números, ids não têm HTML, fotos são imagem/vídeo) — um arquivo alterado
  fora do app é recusado inteiro.
- A sessão de login fica num cookie **criptografado**, `HttpOnly`, `Secure` e
  `SameSite=Strict`; expira após 4 h sem uso (ou 12 h no total). Toda ação
  exige um cabeçalho próprio do app e confere a origem (contra CSRF).
- Cabeçalhos de proteção (CSP sem scripts externos, anti-iframe, nosniff,
  HSTS). Fotos só são aceitas em formatos de imagem/vídeo comuns (SVG e
  links externos são descartados) e só são entregues pra quem está logado.
- O servidor **nunca** devolve hashes de senha nem o banco inteiro pra
  interface. Limites de tamanho por envio (e de envios grandes simultâneos)
  protegem a memória do plano grátis.
- Limitação conhecida: "Sair" apaga o cookie do navegador, mas uma cópia
  dele roubada antes continuaria valendo até expirar (4 h parado / 12 h no
  total) — a não ser que a senha daquela conta seja trocada.

### Rodar a versão web no próprio computador (pra testar)

```
node web/server.js
```

e abra <http://localhost:3000>. Sem as variáveis do Supabase, ele guarda os
dados (criptografados) na pasta `dados-web-local/` — só pra testes.

## Login obrigatório (toda vez que o app abre)

Não existe mais entrada livre e sem senha: **todo mundo precisa logar**,
Admin ou Default, sempre que o app abrir — não tem "pular" nem "entrar como
convidado". A única exceção é a primeiríssima execução (ver abaixo).

**Na primeira vez que o app abre nesta máquina** (instalação nova de
verdade, sem nenhum dado ainda), ele pede para você criar o seu próprio
login de Admin (usuário + senha, senha com no mínimo 6 caracteres) antes de
liberar qualquer outra tela — é uma etapa obrigatória, sem opção de pular.
Depois de criada, essa conta já entra automaticamente como Admin nesta
primeira sessão. Uma instalação que já existia antes desse recurso — ou
seja, que já tinha um login de Admin configurado — não passa por ela na
primeira vez que abre depois de atualizar o app; ela já pula direto pra
tela de login normal, com o Admin de sempre funcionando. A única mudança
prática pra uma instalação assim é que a entrada livre do Default deixou de
existir: até o Admin cadastrar contas de login pra cada pessoa (ver seção
seguinte), só ele mesmo consegue entrar — isso é esperado, não é um bug.

**Essa tela NÃO reaparece depois de uma importação de backup**, mesmo no
modo "Substituir tudo" (que zera o login do Admin desta máquina de
propósito — ver seção "Backup" abaixo): nesse caso o app volta direto pra
tela de login normal, e não pro assistente de criar um Admin. É proposital
— por segurança, ela só existe mesmo na primeiríssima execução da
instalação; do contrário, qualquer pessoa (mesmo alguém logado como
Default, que também pode importar substituindo tudo) poderia virar Admin
desta máquina só de importar um arquivo qualquer e passar por esse
assistente. Depois de uma importação total, então, **não sobra nenhum
Admin configurado nesta máquina** — só as contas de login trazidas pelo
arquivo conseguem entrar (como perfil Default). Não existe, hoje, nenhuma
tela dentro do app para recriar um Admin nessa situação — a única forma é
apagar os dados locais desta instalação (ver "Onde ficam os dados" abaixo)
e passar pelo primeiro acesso de novo, como numa instalação nova.

Da segunda vez em diante (e pra qualquer instalação que já tinha Admin
configurado), o app sempre abre com a **tela de login obrigatória**: usuário
e senha, tanto pro Admin quanto para uma conta de login do Default cadastrada
pelo Admin (próxima seção). Uma conta recém-criada (ou que teve a senha
resetada) entra com uma senha **temporária** — nesse caso, antes de liberar o
resto do app, é pedida uma senha nova e só dessa pessoa; essa troca acontece
uma única vez, logo depois desse primeiro login com a senha temporária.

Pra trocar de conta sem fechar o app, use o botão **"Sair"** no topo da tela
— ele desloga de vez e volta pra tela de login. Ele é diferente de "Entrar
como Admin"/"Sair do modo Admin": esse outro par é uma **escalada
temporária** dentro da mesma sessão (por exemplo, alguém logado com sua
própria conta de Default que quer confirmar uma ação como Admin e depois
volta pra sua própria conta) — os dois continuam funcionando exatamente como
antes.

Para trocar o usuário/senha do próprio Admin (ex.: esqueceu de anotar, quer
usar outro usuário, ou simplesmente quer trocar por segurança), use o botão
**"Trocar login do Admin…"** que aparece no topo da tela quando você está
logado como Admin — por segurança, ele pede a **senha atual** antes de
aceitar o novo usuário/senha (mesma regra de senha: mínimo 6 caracteres).

Nenhuma dessas contas fica salva "lembrada" entre uma execução e outra do
app: a sessão (quem está logado agora) vale só enquanto o app está aberto —
existe apenas na memória do programa, nunca é salva em disco. Fechar e
reabrir o app sempre volta pra tela de login.

## Gerenciador de login (contas do Default) — exclusivo do Admin

Como não existe mais entrada livre, o Admin cadastra uma conta de login
(usuário + senha temporária) pra cada pessoa que vai usar o app como
Default. Essa aba, **"Contas de login"**, só aparece pra quem está logado
como Admin, e permite:

- **Criar uma conta**: define o usuário e uma senha temporária (mínimo 6
  caracteres) — a pessoa vai trocar por uma senha só dela no primeiro login
  (ver seção anterior).
- **Resetar a senha** de uma conta já existente: define outra senha
  temporária, que também vai precisar ser trocada no próximo acesso — útil
  se a pessoa esqueceu a senha.
- **Excluir** uma conta: a pessoa deixa de conseguir entrar até que uma
  conta nova seja criada pra ela. Não afeta nada do que ela já registrou no
  histórico (fica tudo com o nome/telefone gravado na hora, como sempre).

A tabela mostra, pra cada conta, se ela ainda está com senha temporária
("Aguardando 1º acesso") ou já é uma senha definitiva da pessoa ("Ativa").

### Dar acesso de Admin a uma conta

O Admin pode escolher quais contas também são **Admin, com exatamente os
mesmos poderes que ele** (editar tudo, quitar pendências, importar/exportar
backup — inclusive "mesclar" — e gerenciar as contas de login, inclusive
promover ou rebaixar outras):

- Na criação: marque a caixinha **"Admin"** antes de clicar em "Criar conta
  de login".
- Numa conta que já existe: botão **"Tornar Admin"** na tabela (e
  **"Tirar Admin"** pra devolver a conta pro Default). Os dois pedem
  confirmação.
- A coluna **Perfil** mostra quem é Admin ou Default, e a sua própria conta
  aparece marcada com "(você)".

Como funciona na prática:

- A conta Admin entra pela tela de login normal, com o próprio usuário e
  senha, e já cai direto no modo Admin — o topo mostra
  **"Perfil: Admin (nome da conta)"**. Ela também serve no botão "Entrar
  como Admin" a partir de uma sessão do Default.
- Dar ou tirar o acesso vale **na hora**: se a pessoa estiver com o app
  aberto (na web), a sessão dela é encerrada e ela entra de novo já com o
  perfil novo.
- Ninguém tira o próprio acesso de Admin nem exclui a própria conta — isso
  sempre fica a cargo de outro Admin.
- O **Admin principal** (o login criado no primeiro acesso) continua à
  parte e não pode ser rebaixado por essa tela. O botão "Trocar login do
  Admin" é só dele; uma conta Admin que esqueceu a senha pede a outro Admin
  um "Resetar senha".
- Backup: as contas Admin vão no arquivo com o acesso de Admin. Se quem
  importar for um **Default**, todas as contas do arquivo entram como
  Default (ninguém consegue se promover a Admin importando um arquivo
  editado).

## O que cada perfil pode fazer

**Default**
- Ver o catálogo (nome, foto, quantidade de cada item).
- **Só remover** quantidade de um item (nunca adicionar — ver regra
  abaixo): escolhe `−`, digita a quantidade exata a subtrair e clica em
  **"Confirmar"** para aplicar — **sempre vinculado a um usuário**.
- Cadastrar, **editar** (nome/telefone, pelo botão "Editar" na aba
  "Usuários") ou remover "usuários" (pessoas para quem a quantidade é
  destinada) — inclusive na hora, direto na tela de movimentação, se a
  pessoa ainda não estiver cadastrada. **O telefone é sempre obrigatório**;
  o nome é opcional — sem nome, o usuário fica identificado pelo final do
  telefone (ex.: "Nº final 1234").
- Ao vincular a movimentação a um usuário: escolher **Entrega** ou
  **Retirada** (obrigatório) e, opcionalmente, anexar uma foto. Todo
  registro do Default nasce **sempre como Pendente** — ele não escolhe isso
  (ver "Entrega/Retirada e status Pendente/Concluído" abaixo); só o Admin
  confirma depois.
- Movimentar **vários itens de uma vez** direto pela aba **"Usuários"**:
  escolha o usuário na lista e clique em **"Movimentar item"** — abre uma
  tabela com todos os itens do catálogo, cada um com uma caixinha de marcar e
  um campo de quantidade. Marque quantos itens quiser, informe a quantidade
  de cada um, tem um campo de busca para achar o item mais rápido, e escolha
  **uma** direção (+ ou −) e **um** Entrega/Retirada para o lote inteiro —
  não dá para misturar entrada e saída, nem Entrega/Retirada diferente, no
  mesmo envio. Ao confirmar, cada item marcado é registrado como uma
  movimentação separada no histórico (mesma regra de sempre: o Default só
  remove, e tudo nasce Pendente).
- Ver a aba **"Precificação"** — mas só o card **"Valor em estoque"** e a
  coluna correspondente da tabela; os demais totais/colunas (valor saído e
  valor pendente) ficam visíveis só para o Admin, e a edição dos valores
  continua exclusiva do Admin (ver seção própria abaixo).
- Criar e **editar** (valor/observação, direto na tabela) **lançamentos
  avulsos** e registrar/**editar pagamentos** para **qualquer usuário**
  (mesmas telas do Admin, ver seção própria abaixo). A única restrição é
  para um usuário que o Admin tenha marcado como bloqueado (aba "Usuários"):
  nesse caso o Default só pode criar um lançamento avulso com **valor
  negativo** (funciona como um crédito/desconto — reduz a pendência do
  usuário), não pode criar um lançamento positivo (cobrança), e não pode
  registrar pagamento nenhum. Editar um lançamento/pagamento já existente
  continua liberado mesmo com o usuário bloqueado. Excluir um lançamento ou
  pagamento, e alternar o status Pendente ⇄ Concluído, continuam exclusivos
  do Admin.
- Se errar uma quantidade, **desfazer a última movimentação** feita nesta
  sessão do app (ver "Corrigindo um erro de quantidade (Default)" abaixo).
- Favoritar usuários (ver seção "Usuários favoritos" abaixo).
- Consultar (aba "Consultar"): ver, por usuário, todas as quantidades já
  movimentadas com ele e a soma por item do catálogo; ou, por item, todo o
  histórico de alterações e quais usuários estiveram envolvidos. Em ambos,
  dá para escolher um período específico ou "período inteiro".
- Exportar e importar (só no modo **"Substituir tudo"** — "Mesclar" é
  exclusivo do Admin) um backup do catálogo/usuários/histórico/contas de
  login (aba "Backup") — o login do próprio Admin nunca entra nem sai desse
  arquivo, mas **importar substituindo tudo zera o login do Admin desta
  máquina** (ver seção "Backup" abaixo). Depois de importar, o app volta pra
  tela de login normal — e, sem nenhum Admin configurado, só as contas de
  login trazidas pelo arquivo conseguem entrar.
- Gerar o **PDF de pedidos** (aba "Histórico") — ver "Relatório de pedidos em
  PDF" abaixo.

## Corrigindo um erro de quantidade (Default)

O perfil Default **nunca pode adicionar quantidade** — nem como devolução,
nem de nenhuma outra forma. É uma restrição proposital: só o Admin pode
fazer estoque "aparecer". Por isso, se o Default errar uma quantidade ao
remover, a única correção possível é **desfazer a última movimentação**:

- Quando há algo pra desfazer, um aviso aparece no topo da aba
  **"Catálogo"** mostrando qual foi a última movimentação (item, quantidade
  e usuário) com um botão **"Desfazer"**. Clicar nele apaga esse registro do
  histórico e devolve a quantidade retirada para o catálogo.
- Essa opção só existe para a **movimentação mais recente feita nesta
  sessão do app** (a que está aberta agora). Ao desfazer, a movimentação
  anterior a ela (se também foi feita nesta sessão) passa a ser a "última" e
  pode ser desfeita em seguida, e assim por diante.
- **Ao reiniciar o app**, essa possibilidade desaparece por completo: nada
  do que já estava no histórico antes do reinício pode mais ser alterado
  pelo Default (o controle de "o que pode ser desfeito" fica só na memória
  do programa enquanto ele está aberto, nunca é salvo em disco).
- O Admin não precisa dessa ferramenta: ele já pode fazer entrada livremente
  e também tem as ferramentas de excluir histórico (aba Histórico), que
  **devolvem** a quantidade automaticamente (ver seção própria abaixo).

**Admin** (tudo do Default, mais)
- Adicionar novos itens ao catálogo (nome, foto, quantidade inicial) e
  editar itens existentes.
- Remover itens do catálogo.
- Fazer entrada (adicionar) e saída (remover) quantidade livremente, com ou
  sem usuário vinculado, novo ou existente — sem nenhuma das restrições do
  Default.
- Anexar foto a uma movimentação de quantidade **mesmo sem vincular a um
  usuário** (o Default só anexa foto quando há um usuário selecionado).
- Excluir movimentações do histórico: uma ou várias selecionadas (aba
  "Histórico", com caixinhas de marcação) ou todo o histórico de uma vez.
  Assim como o "Desfazer" do Default, isso **devolve a quantidade** de cada
  movimentação removida pro item correspondente (uma saída volta a somar,
  uma entrada volta a subtrair) — exceto se o item já não existir mais no
  catálogo, caso em que só o registro some (ver seção "Histórico e
  Consulta").
- Excluir todos os usuários cadastrados de uma vez (aba "Usuários").
- **Bloquear/desbloquear um usuário** para o perfil Default (botão na linha
  do usuário, aba "Usuários"): um usuário bloqueado passa a ter um ícone 🔒
  ao lado do nome, e o Default fica restrito a lançar só valores
  **negativos** (créditos/descontos) para ele e deixa de conseguir registrar
  pagamento nenhum — o Admin continua livre sobre qualquer usuário,
  bloqueado ou não, com qualquer sinal de valor.
- **Trocar o próprio usuário/senha de login** a qualquer momento (botão
  "Trocar login do Admin…" no topo da tela, pede a senha atual — ver seção
  "Login obrigatório" acima).
- **Gerenciar as contas de login do Default** (aba "Contas de login"):
  criar, resetar senha e excluir — ver seção "Gerenciador de login" acima.
- **Importar mesclando** com os dados atuais (o Default só pode substituir
  tudo ou exportar — ver seção "Backup" abaixo).
- Ver, na aba **"Precificação"**, todos os cards e colunas (valor saído e
  valor pendente, além do valor em estoque) — o Default só vê o valor em
  estoque (ver seção própria abaixo).
- **Confirmar de verdade** uma pendência: alternar o status **Pendente ⇄
  Concluído** de qualquer movimentação ou lançamento no Histórico ou na
  Consulta, nos dois sentidos (marcar um pendente como concluído, ou voltar
  um concluído para pendente) — é só o Admin que efetivamente some com uma
  pendência dessa forma (ver "Entrega/Retirada e status Pendente/Concluído"
  abaixo). Também é só o Admin que pode criar uma movimentação já direto
  como Concluída (via a caixinha "Pagamento pendente") — todo registro do
  Default nasce sempre Pendente.
- Definir o **valor unitário** de cada item na aba **"Precificação"** — só o
  Admin pode alterar esses valores, e só ali (ver seção própria abaixo).
- No modal **"Movimentar item"** da aba Usuários, ao fazer uma **saída**, é
  **obrigatório** que cada item marcado já tenha um valor unitário definido
  na Precificação. Assim que "−" é escolhido, os itens sem preço já aparecem
  destacados em vermelho na própria tabela (com a etiqueta "sem preço
  definido"), antes mesmo de tentar confirmar. Ao confirmar, esses itens são
  **pulados automaticamente** — os demais itens marcados (com preço definido)
  são registrados normalmente, e o app avisa quais ficaram de fora e por quê.
  Essa exigência vale só nesse fluxo de registro em lote pela aba Usuários; o
  botão `−`/`+` de cada card no Catálogo continua funcionando sem exigir
  preço.
- **Lançamentos avulsos**: um valor + observação atribuído a um usuário, sem
  vincular a nenhum item do catálogo (ex.: uma cobrança combinada por
  telefone, ou um crédito/desconto quando o valor é negativo). Acesse pelo
  botão **"Lançamentos"** no card do usuário (aba "Usuários") — os dois
  perfis podem adicionar e **editar o valor/observação diretamente na
  tabela** de qualquer lançamento, de qualquer usuário (a restrição de
  valor negativo para usuário bloqueado vale só pra criar, não pra editar —
  ver acima). Só o Admin pode **excluir** um lançamento e alternar o status
  Pendente ⇄ Concluído. As mesmas ações também estão disponíveis na aba
  **"Pendências"**, no detalhamento de cada usuário. Os lançamentos de um
  usuário também aparecem na aba **"Consultar"**, dentro do resumo por
  usuário, respeitando o período escolhido.
- **Pagamentos** que abatem a pendência de um usuário, na aba
  **"Pendências"** — os dois perfis podem registrar e **editar** um
  pagamento (valor/comentário), exceto **registrar** um novo pagamento para
  um usuário bloqueado, que continua exclusivo do Admin (editar um pagamento
  já existente continua liberado mesmo assim). Pagamento continua sempre com
  valor **positivo** — diferente do lançamento avulso, ele representa
  dinheiro de fato recebido. Só o Admin pode **excluir** um pagamento já
  registrado.

## Fotos e vídeos anexados

Em qualquer lugar do app onde dá para anexar uma "foto" (item do catálogo,
movimentação de quantidade), também é possível escolher um **vídeo** —
o seletor de arquivo aceita imagens (jpg, png, e outros formatos de imagem
do navegador) e vídeos (mp4, mpeg, e outros formatos de vídeo do navegador).
O app detecta sozinho se o arquivo escolhido é imagem ou vídeo:

- **Imagens** continuam sendo redimensionadas e comprimidas automaticamente
  antes de salvar (para não pesar no arquivo de dados).
- **Vídeos** não são comprimidos (o navegador não oferece isso), então são
  anexados como estão, com um limite de **25MB por vídeo** — arquivos
  maiores são recusados com um aviso, para não deixar o arquivo de dados
  local gigante (lembrando que tudo fica embutido, criptografado, num único
  arquivo carregado por inteiro na memória).
- Nas pré-visualizações, no catálogo, no histórico e ao clicar para ampliar,
  um vídeo anexado aparece com os controles de reprodução do navegador em
  vez de como imagem estática.

## Histórico e Consulta

A aba **"Histórico"** mostra, **por padrão, TODO o histórico** (todos os
dias, do mais recente pro mais antigo) — não só um dia específico: data e
hora completas, item, quantidade (+/−), quantidade resultante, usuário (se
houver), se foi **Entrega** ou **Retirada** (se houver usuário), o
**status** de pagamento (Pendente/Concluído — ver seção própria abaixo),
quem fez (Default/Admin), a **origem** do registro (ver abaixo) e a foto ou
vídeo anexado (se houver, clicável para ampliar).

Se você quiser ver só um dia específico ou um período, use os campos **"De"**
e **"Até"** no topo da aba: preencha os dois com a mesma data para um único
dia, ou datas diferentes para um período; qualquer um dos dois pode ficar em
branco (só "De" filtra a partir dali sem data final, só "Até" filtra até ali
sem data inicial). O botão **"Ver tudo"** limpa os dois campos e volta a
mostrar o histórico inteiro.

Pra ver só as movimentações de um usuário específico, use o filtro
**"Usuário"**: digite o nome ou telefone e as sugestões já vão aparecendo
por baixo da caixa **a cada letra digitada** (sem precisar abrir nada nem
"confirmar" a busca) — clique numa delas pra aplicar o filtro. Isso filtra
as duas tabelas da aba (movimentações de item, e lançamentos/pagamentos) só
pros registros daquele usuário, em cima do período já selecionado. O "×" que
aparece dentro da caixa (ou escolher "Todos os usuários" na lista de
sugestões) limpa o filtro e volta a mostrar todo mundo.

Como Admin, essa aba também mostra uma caixinha de marcação em cada linha
(dentro do período mostrado) e dois botões: **"Excluir selecionadas"** (as
marcadas) e **"Excluir todo o histórico…"** (todas as movimentações, de
todos os dias, independente do filtro de período aplicado na tela). Em
ambos os casos, isso **devolve a quantidade** de cada movimentação removida
pro item correspondente — uma saída volta a somar, uma entrada volta a
subtrair —, igual ao "Desfazer" do Default; a única exceção é quando o item
já não existe mais no catálogo, caso em que só o registro some (não há mais
onde devolver a quantidade).

Logo abaixo da tabela de movimentações, uma **segunda tabela** mostra os
**lançamentos avulsos e pagamentos** do mesmo período selecionado (ver
"Lançamentos avulsos" e "Pendências e pagamentos" mais abaixo) — com
data/hora completas, usuário, tipo (Lançamento avulso ou Pagamento), valor,
comentário e, para um lançamento, o mesmo status Pendente/Concluído com o
botão de alternar exclusivo do Admin. Pagamentos não têm esse status: eles
são sempre um recebimento já efetivado. Essa tabela só aparece quando há
algo lançado no período mostrado.

Acima dela, o Admin tem um botão **"Excluir todos os lançamentos e
pagamentos…"** — diferente do "Excluir todo o histórico…" da tabela de
movimentações (que apaga só as entradas/saídas de item), esse apaga **todos**
os lançamentos avulsos e pagamentos registrados, de **todos** os usuários e
de **todos** os dias, de uma vez (não só os do dia selecionado). Pede
confirmação antes e não pode ser desfeito; as movimentações de item não são
afetadas. Para editar ou excluir um lançamento ou pagamento individualmente,
veja "Pendências e pagamentos" mais abaixo.

### Origem de um registro do histórico: Local ou Importado

Toda movimentação no histórico tem uma etiqueta de origem:
- **Local**: foi feita direto no app (uma entrada/saída normal).
- **Importado**: veio de um backup importado no modo **"Mesclar com o que já
  existe"** (aba Backup) — ou de um backup importado no modo **"Substituir
  tudo"**, já que nesse caso todo o histórico resultante vem do arquivo.

Isso vale só para a mesclagem **mais recente**: ao mesclar um novo backup, as
movimentações da mesclagem anterior deixam de aparecer como "Importado" e
passam a contar como "Local" (o histórico local de fato), e só as trazidas
pelo backup recém-mesclado ficam marcadas como "Importado".

Na aba **"Histórico"**, o marcador **"Mostrar só importados"** filtra a
tabela para mostrar só as movimentações importadas dentro do período
mostrado (todo o histórico, por padrão, ou o período escolhido em "De"/"Até").

### Entrega/Retirada e status Pendente/Concluído

Toda movimentação com um usuário atrelado tem duas informações extras:

- **Entrega ou Retirada**: escolhida na hora de fazer a movimentação (no
  card do item, no modal "Movimentar item" da aba Usuários), em vez da
  antiga forma de pagamento (Pix/Dinheiro).
- **Status — Pendente ou Concluído**: toda movimentação ou lançamento avulso
  criado pelo perfil **Default** nasce **sempre Pendente** — ele não tem
  como escolher; no lugar da antiga caixinha "Pagamento pendente" aparece
  uma nota fixa "🔒 Sempre pendente" só avisando disso. O **Admin** continua
  podendo escolher na hora (a caixinha "Pagamento pendente" continua só pra
  ele): marcada, nasce Pendente; desmarcada, nasce direto Concluído. No
  Histórico e na Consulta, esse status aparece como uma etiqueta colorida na
  coluna "Status".

O marcador **"Mostrar só pendentes"** (ao lado de "Mostrar só importados",
na aba Histórico) filtra a tabela para mostrar só as movimentações pendentes
dentro do período mostrado.

**Só o Admin resolve uma pendência de verdade** — pelo botão que aparece ao
lado da etiqueta (Histórico e Consulta) —, e isso funciona nos **dois
sentidos**: tanto marcar um registro concluído como pendente, quanto voltar
um pendente para concluído (por exemplo, depois que o pagamento é
recebido). Essa troca só mexe na etiqueta — não altera quantidade nenhuma
no catálogo. É essa ação (ou registrar um pagamento/lançamento que abata o
saldo — ver "Pendências e pagamentos" abaixo) que efetivamente some com a
pendência do usuário.

O **Default**, enquanto uma movimentação ou lançamento continuar Pendente,
pode clicar em **"📝 Marcar como recebido"** (no mesmo lugar do botão do
Admin) — é só um **controle informal dele**, pra lembrar do que já recebeu:
o registro continua contando normalmente na pendência do usuário, e some da
lista só quando o Admin de fato confirmar. Quando marcado, aparece a
etiqueta "📝 Default marcou como recebido" ao lado do status, visível pros
dois perfis, pra o Admin saber o que já foi sinalizado e confirmar com mais
agilidade. Assim que o Admin confirma (ou desfaz a confirmação) pelo botão
de status, essa marcação informal é zerada — ela não sobrevive à decisão de
verdade do Admin.

### Relatório de pedidos em PDF

O botão **"📄 Gerar PDF de pedidos…"**, ao lado dos filtros no topo da aba
Histórico, gera um PDF com os **pedidos** (as saídas de item) de um período —
disponível tanto para o Default quanto para o Admin. O PDF traz duas tabelas:
uma tabela-resumo **"Total por item"**, no topo, com a quantidade e o valor
somados de cada item que saiu no período (do item que mais saiu pro que menos
saiu), e logo abaixo o **"Detalhamento dos pedidos"**, linha a linha — cada
uma com horário, item, usuário (ou "—", se não houver), quantidade, Entrega/
Retirada, status (Pendente/Concluído), valor unitário e valor total
**precificado** (mesma regra usada na aba Pendências: o preço atual do item
na Precificação, ou o último preço conhecido dele, se o item já tiver sido
removido do catálogo — ver "Precificação" e "Pendências e pagamentos" mais
abaixo), com o rodapé somando a quantidade e o valor totais do período.

Por padrão, o período já vem preenchido com o que estiver marcado em "De"/
"Até" na aba Histórico naquele momento (ou o dia de hoje, se a aba estiver
mostrando todo o histórico), mas as duas datas ("De" / "Até") do modal podem
ser alteradas livremente para cobrir qualquer intervalo — um único dia, uma
semana, um mês, ou o período inteiro.
Ao clicar em "Gerar PDF…", o app pede onde salvar o arquivo (como qualquer
"Salvar como") e escreve o PDF ali; movimentações de **entrada** (reposição
de estoque) nunca entram nesse relatório, só as saídas.

A aba **"Consultar"** (novidade) responde duas perguntas diferentes:
- **Por usuário**: escolha um usuário e veja a soma de quantidade por item
  do catálogo, além da lista detalhada de cada movimentação — no período
  inteiro ou num intervalo de datas que você escolher. Também dá para chegar
  aqui clicando em "Consultar" na aba Usuários.
- **Por item**: escolha um item e veja o histórico só dele — todas as
  entradas/saídas, quais usuários estiveram envolvidos e a data de cada uma.
  Também dá para chegar aqui clicando em "Ver histórico deste item" no card
  do item, na aba Catálogo.

### Exportando a Consulta em PDF

Depois de clicar em "Consultar" e o resultado aparecer na tela, um botão
**"Exportar PDF"** aparece ao lado — ele gera um PDF com exatamente o que
está sendo mostrado: o mesmo usuário ou item, o mesmo período escolhido (ou
"todo o período"), o resumo/totais (soma por item, no modo por usuário; ou
total adicionado/removido e quantidade atual, no modo por item) **e** a
tabela de movimentações detalhada, linha a linha — tudo num único arquivo.
Disponível tanto para o Default quanto para o Admin. O botão some de novo se
você trocar o modo (usuário/item) ou limpar o resultado, até rodar uma nova
consulta.

### Exportando as quantidades do catálogo em PDF

Diferente do relatório acima (que olha pro **histórico** — os pedidos de um
período), o botão **"📦 Exportar quantidades (PDF)"**, no topo da aba
**Catálogo**, gera uma **foto de agora**: um PDF simples, com o nome e a
quantidade atual de cada item — só os itens que **têm** quantidade (maior
que zero); itens zerados ficam de fora, de propósito, já que o pedido é
"o que tem quantidade". A lista sai em ordem alfabética, com o total geral
de unidades no rodapé. Disponível tanto para o Default quanto para o Admin,
sem nenhum filtro de período pra preencher — é só clicar e escolher onde
salvar.

## Pendências e pagamentos

A aba **"Pendências"** reúne, num só lugar, todos os usuários que ainda têm
algo pendente — uma saída de item marcada como **Pendente** (ver "Entrega/
Retirada e status Pendente/Concluído" acima), ou um **lançamento avulso**
pendente (ver seção anterior) — mostrando o **total** que falta receber de
cada um. Só aparecem aqui usuários com saldo pendente maior que zero, do
maior para o menor.

No topo da aba, **três cartões de resumo GERAL** — **"Total pendências"**,
**"Total já pago"** e **"Saldo pendente"**, cada um somando **todos os
usuários juntos** (pendentes e já quitados) — dão uma visão geral de tudo
sem precisar abrir usuário por usuário. Esses cartões (e os totais
individuais de cada usuário, no detalhamento logo abaixo) são visíveis
tanto para o **Default** quanto para o **Admin** — não é uma informação
exclusiva do Admin.

A tela é dividida em **duas colunas**: **"Pendentes"** (a lista de sempre) e
**"✓ Já pago"**, ao lado — quem já teve alguma pendência e hoje está com o
saldo zerado (ver "Marcar como pago numa tacada só", logo abaixo). A coluna
"Já pago" tem um **destaque visual em verde** (cartão com fundo e borda
próprios, título em negrito) — de propósito, pra ficar bem diferenciável da
coluna "Pendentes" ao lado num único olhar, sem precisar ler o título de
cada uma. Clicar em qualquer usuário, de qualquer uma das duas colunas, abre
o mesmo painel de detalhamento.

Clicar num usuário abre, logo abaixo da lista, **nessa mesma aba**, o
detalhamento: cada pendência individual (o item ou o lançamento, com data e
valor), cada pagamento já registrado, e três totais — total das pendências,
total já pago, e o **saldo pendente** (pendências menos pagamentos). Um botão
**"Fechar detalhamento"** no topo do painel fecha essa visão. Também dá pra
chegar direto aqui de outro lugar: o botão **"Pendências"** em cada card da
aba **"Usuários"** já abre a aba Pendências com o detalhamento daquele
usuário específico pronto na tela (mesmo que o total dele esteja zerado no
momento — útil pra ver o histórico de pagamentos já feitos).

Ao lado de "Fechar detalhamento", o botão **"Exportar PDF"** gera um PDF só
daquele usuário — pendências em aberto, pagamentos já feitos e os três
totais — pra guardar ou entregar pra pessoa. É uma foto do estado ATUAL da
pendência dele (não pede período, diferente do relatório de pedidos ou da
Consulta), disponível tanto para o Default quanto para o Admin.

**Editar ou excluir um registro** fica direto nas linhas do detalhamento:
- Um **lançamento avulso** pendente: o valor (pode ser negativo — funciona
  como crédito/desconto) e a descrição ficam editáveis direto na linha
  (salva ao sair do campo), **disponível para os dois perfis, em qualquer
  usuário** (mesmo um bloqueado — a restrição de bloqueio vale só pra criar
  um lançamento novo, não pra editar um já existente). Só o **Admin** tem o
  botão **"Excluir"** pra removê-lo definitivamente. A mesma edição/exclusão
  também está disponível na tela de **"Lançamentos"** da aba Usuários (onde
  o lançamento também pode ser criado e ter o status alternado, esse último
  exclusivo do Admin).
- Uma **saída de item pendente**: só pode ser excluída daqui, exclusivo do
  Admin (o registro some do Histórico e a quantidade volta pro item,
  igual ao "Excluir" de lá) — pra mudar só o status dela sem excluir, use o
  Histórico ou o "Desfazer última movimentação".
- Um **pagamento**: valor (sempre positivo — é dinheiro de fato recebido) e
  comentário também ficam editáveis direto na linha, **disponível para os
  dois perfis**, mesmo pra um usuário bloqueado. Só o Admin tem o botão
  **"Excluir"** pra removê-lo (o saldo pendente do usuário volta a contar
  esse valor como não pago).

Excluir qualquer um desses registros pede confirmação antes e não pode ser
desfeito.

**Registrar um pagamento** fica no mesmo painel de detalhamento: um campo de
valor e um campo de **comentário obrigatório** (ex.: forma de pagamento, o
que foi combinado). Os dois perfis podem registrar um pagamento — **exceto**
para um usuário que o Admin tenha marcado como **bloqueado** (ver "Usuários e
telefone" abaixo): nesse caso, o formulário de registrar pagamento é
substituído por um aviso, e só o Admin consegue registrar ali (mas ambos
continuam podendo **editar** um pagamento já existente desse usuário — ver
acima). Esse pagamento:
- **Não é atribuído a nenhum item** nem a nenhuma pendência específica — ele
  só abate o **saldo total** mostrado aqui.
- **Não marca** nenhuma saída ou lançamento como "Concluído" automaticamente
  — isso continua sendo feito manualmente, um por um, pelo botão de
  alternar no Histórico/Consulta/Lançamentos. Por isso dá pra registrar um
  **pagamento parcial** (por exemplo, R$ 20 de uma pendência de R$ 45) sem
  precisar quitar uma pendência específica por inteiro.
- **Aparece no Histórico** do dia em que foi feito, na segunda tabela (ver
  seção "Histórico e Consulta" acima).
- Entra no **backup** (exportar/importar, nos dois modos) junto com o resto
  dos dados.

### Marcar como pago numa tacada só (exclusivo do Admin)

Na coluna **"Pendentes"**, o Admin tem um botão extra em cada linha: **"✓
Marcar como pago"**. Diferente do "Registrar pagamento" manual acima (que
pede pra digitar o valor e o comentário, e está disponível pros dois
perfis), esse botão é um atalho que **registra sozinho um pagamento no valor
EXATO do saldo pendente daquele usuário no momento**, zerando a pendência
inteira dele numa única ação — sem precisar abrir o detalhamento nem digitar
nada. Pede confirmação antes (mostrando o valor exato que vai virar
pagamento) e não pode ser desfeito.

É uma ação **exclusiva do Admin** — o botão nem aparece pro perfil Default —,
seguindo a mesma regra de sempre: só o Admin resolve uma pendência de
verdade. Depois de usado, o usuário sai da coluna "Pendentes" e passa a
aparecer na coluna **"Já pago"**, ao lado (com o total que ele pagou no
total). Essa segunda coluna não é uma marcação guardada à parte — ela é
recalculada a cada vez a partir do saldo de verdade, então: se o usuário
tiver uma pendência nova depois (uma saída ou lançamento novo em nome dele),
ele volta pra "Pendentes" e some de "Já pago" automaticamente; e só entra em
"Já pago" quem **já teve** alguma pendência paga alguma vez — quem nunca
comprou nada não aparece em nenhuma das duas colunas.

Um detalhe importante: como o **valor** de uma saída pendente é calculado
pelo **preço unitário atual** do item (aba Precificação), o total mostrado
aqui pode mudar se esse preço for alterado depois — diferente do total
"Valor pendente" da aba Precificação, que soma por item e **não** é abatido
por pagamentos (os dois números respondem perguntas diferentes: um é "quanto
esse item tem pendente no total", o outro é "quanto esse usuário ainda deve,
descontando o que ele já pagou").

## Usuários e telefone

A aba **"Usuários"** mostra cada pessoa cadastrada como um **card** (com um
avatar de iniciais, telefone e data de cadastro), em vez da antiga lista em
tabela — mais fácil de bater o olho, principalmente com muitos usuários
cadastrados. Todas as ações de sempre (favoritar, movimentar item,
lançamentos, pendências, consultar, editar, bloquear, remover) continuam nos
mesmos botões, agora na base de cada card.

Todo usuário precisa de um **telefone cadastrado** (é a forma de identificar
e evitar duplicidade — dois usuários com o mesmo telefone não são permitidos).
O nome é opcional: se não for informado, o usuário aparece nas listas e no
histórico como "Nº final XXXX" (os 4 últimos dígitos do telefone).

### Buscando um usuário

Em qualquer lugar do app onde apareça uma lista de usuários, dá para buscar
por nome ou telefone em vez de rolar a lista inteira:
- Na aba **"Usuários"**, uma caixa de busca acima dos cards filtra os
  exibidos.
- No seletor de usuário de cada item do catálogo (ao adicionar/remover
  quantidade) e no seletor da aba **"Consultar"**, uma caixa de busca acima
  do seletor filtra as opções da lista — dá pra digitar para achar rápido ou
  simplesmente abrir e escolher da lista normalmente (as duas formas
  funcionam juntas).

### Usuários favoritos

Cada card da aba **"Usuários"** tem uma estrela (☆/★) clicável para marcar
ou desmarcar um usuário como favorito. Usuários favoritos aparecem **sempre
no topo** de qualquer lista de usuários do app — na própria aba Usuários, no
seletor de usuário de cada item do catálogo (ao adicionar/remover
quantidade) e no seletor da aba Consultar — vindo antes de todo mundo,
independente de ordem alfabética. Nos seletores, um favorito também aparece
com uma ★ na frente do nome para ficar fácil de identificar. É útil para
deixar sempre à mão as pessoas que mais movimentam itens do catálogo.

### Editando um usuário

O botão **"Editar"** de cada card da aba "Usuários" abre um formulário
simples para corrigir **nome e/ou telefone** — disponível para os dois
perfis. É só isso: favoritar, bloquear e remover continuam em seus próprios
botões, com suas próprias regras (algumas exclusivas do Admin, ver abaixo).
O telefone continua sendo validado (mínimo 8 dígitos) e não pode coincidir
com o de outro usuário já cadastrado.

### Bloqueando um usuário (exclusivo do Admin)

O botão **"🔒 Bloquear" / "🔓 Desbloquear"** de cada card (só aparece para o
Admin) marca um usuário como bloqueado para o perfil Default. Um usuário
bloqueado ganha uma etiqueta 🔒 no próprio card, e a partir daí:

- O perfil Default fica restrito a criar só **lançamentos avulsos com valor
  negativo** (crédito/desconto) para esse usuário — não pode criar um
  lançamento positivo (cobrança) — e **não consegue mais registrar
  pagamento** nenhum para ele. A tela "Lançamentos" mostra um aviso
  explicando essa restrição, mas o formulário continua disponível (só o de
  pagamento, no detalhamento da aba "Pendências", é substituído pelo aviso).
- **Editar** um lançamento ou pagamento já existente desse usuário continua
  liberado para o Default normalmente — a restrição do bloqueio vale só para
  criar um lançamento/pagamento novo.
- O **Admin continua livre** para agir sobre qualquer usuário, bloqueado ou
  não, com qualquer sinal de valor — o bloqueio afeta só o que o perfil
  Default pode fazer.
- Todo o resto (movimentar itens, ver histórico, editar o cadastro do
  usuário) continua funcionando normalmente para os dois perfis — o bloqueio
  é específico para **criar** lançamentos avulsos e pagamentos.

### Excluindo usuários

O botão **"Remover"** de cada card continua removendo um usuário por vez
(Default ou Admin). Já o botão **"Excluir todos os usuários…"**, ao lado da
busca, é exclusivo do Admin e apaga o cadastro inteiro de uma vez — o
histórico já registrado é mantido, com o nome/telefone gravado na hora de
cada movimentação (mesma regra da remoção individual).

## Precificação

A aba **"Precificação"** existe só para dar um valor unitário a cada item do
catálogo e ver o valor total de três coisas:

- **Valor em estoque**: quantidade atual de cada item x valor unitário,
  somado no total lá em cima.
- **Valor que saiu (concluído)**: soma das saídas com status **Concluído**,
  x o valor unitário.
- **Valor pendente**: soma das saídas ainda marcadas como **Pendente**, x o
  valor unitário.

Esses três totais aparecem em destaque no topo da aba, e a tabela abaixo
mostra a mesma conta item a item. **Só o Admin pode definir o valor
unitário de um item, e só nesta aba** — o campo de valor fica editável só
para ele; o Default só visualiza os valores já definidos. Um item novo
sempre começa com valor unitário R$ 0,00 até o Admin definir um valor.

**O que o Default vê aqui é mais restrito que o Admin**: o perfil Default só
enxerga o card e a coluna **"Valor em estoque"** — os totais/colunas "Valor
que saiu (concluído)" e "Valor pendente" (tanto os cards no topo quanto as
colunas da tabela) ficam visíveis só para o Admin. O Default continua vendo
o valor unitário de cada item (só leitura) e a quantidade em estoque
normalmente.

## Backup (Import/Export)

Na aba **"Backup"**:
- **Exportar** (Default e Admin): gera um arquivo `.estoquebkp` com todo o
  catálogo (nome, quantidade, valor unitário e a foto/vídeo de cada item),
  usuários, histórico, lançamentos avulsos, pagamentos e as **contas de
  login do Default** (usuário e senha, do jeito que estão — ver
  "Gerenciador de login" acima) — o login do próprio Admin nunca entra no
  arquivo. Toda a mídia (foto/vídeo) já anexada aos itens e às movimentações
  vai embutida no arquivo junto com os dados, sem precisar de nenhum passo
  extra. Você escolhe uma senha na hora de exportar (não é a senha do
  admin nem de nenhuma conta de login) — pode ter **letras, números e
  símbolos, com no mínimo 6 caracteres**; essa senha é pedida de volta para
  importar. É esse arquivo que você usa para guardar uma cópia de segurança
  ou migrar os dados para outro computador.
- **Importar** (Default e Admin): escolhe um arquivo `.estoquebkp` exportado
  antes, a senha usada na exportação e um dos dois modos abaixo — mas
  **"Mesclar" é exclusivo do Admin**: o Default só pode escolher
  "Substituir tudo" (o botão de mesclar nem aparece pra ele). O arquivo de
  backup nunca carrega o login do Admin, em nenhum dos dois modos — mas veja
  a exceção importante do modo "Substituir tudo" logo abaixo: esse modo
  **reinicia** o login do Admin desta máquina, mesmo o arquivo não trazendo
  nenhum.

  **Depois de qualquer importação bem-sucedida** (substituir tudo ou
  mesclar, tanto faz), o app **desloga automaticamente e volta pra tela de
  login** — as contas de login podem ter mudado (vieram outras do arquivo,
  ou a própria conta que estava logada pode ter sido substituída), então a
  sessão atual deixa de valer por segurança. A tela de login que aparece já
  reflete as contas que ficaram valendo depois da importação.

### Os dois modos de importação

- **Substituir tudo**: apaga o catálogo, usuários, histórico e **contas de
  login do Default** atuais, e coloca no lugar exatamente o que está no
  arquivo. Use para restaurar uma cópia de segurança ou clonar os dados de
  uma máquina para outra do zero. Não pode ser desfeito.
  **O login do Admin desta máquina também é zerado** sempre que esse modo é
  usado — não importa se a máquina é nova ou já tinha um Admin configurado
  há tempos. A regra é: um login criado (ou já existente) antes de um
  "substituir tudo" só vale para o que foi feito **antes** dessa importação;
  depois dela, o que prevalece é só o que veio do arquivo (as contas de
  login do Default, se houver), e o Admin antigo desta máquina **para de
  funcionar por completo**. Isso evita o problema de uma conta de login do
  arquivo ficar "atrás" de um Admin antigo local pra sempre (o Admin é
  sempre checado primeiro na hora de logar — ver `verificarLogin`).
  **Depois da importação, o app volta pra tela de login NORMAL — nunca pra
  tela de criar um novo Admin.** Isso é proposital, por segurança: como
  qualquer perfil (inclusive Default) pode fazer essa importação, deixar um
  assistente de "criar Admin" aparecer logo depois dela permitiria que
  qualquer pessoa virasse Admin desta máquina só de importar um arquivo
  qualquer. Na prática, então, depois de um "substituir tudo" **não sobra
  nenhum Admin configurado nesta máquina** — só as contas de login do
  Default trazidas pelo arquivo conseguem entrar; não existe hoje uma tela
  para recriar um Admin nessa situação (a única forma é apagar os dados
  locais desta instalação e passar pelo primeiro acesso de novo).
- **Mesclar com o que já existe** (exclusivo do Admin): em vez de apagar,
  soma ao que já está aqui só o que for **novo ou diferente** — o que já
  existe dos dois lados se mantém como está, sem duplicar e sem "cancelar"
  errado:
  - **Usuários** do arquivo que ainda não existem localmente (comparando
    pelo telefone) são adicionados; os que já existem não são alterados.
  - **Itens** são casados pelo nome. Um item que só existe no arquivo é
    adicionado normalmente, com a quantidade do arquivo. Um item que **já
    existe no catálogo local não tem a quantidade alterada diretamente** —
    ela só muda por causa de **movimentações novas** que o arquivo traga
    (ver próximo item). Ou seja: mesclar um backup que reflete exatamente o
    que já está aqui **não muda nada**.
  - **Movimentações (histórico), lançamentos avulsos e pagamentos** são
    reconhecidos individualmente pelo id com que nasceram (criado na hora
    do evento — praticamente impossível de coincidir entre instalações
    diferentes), não pela quantidade total. Um registro cujo id já existe
    aqui é **o mesmo evento** — já foi registrado antes (localmente ou numa
    mesclagem anterior) — e é **ignorado, sem duplicar**. Um registro com
    id novo é de fato um evento novo: entra no histórico, e **só nesse
    caso** seu efeito (soma numa entrada, subtrai numa saída) é aplicado à
    quantidade do item. Isso significa que mesclar duas instalações que
    divergiram (cada uma registrou movimentações próprias a partir de um
    ponto em comum) só aplica a **diferença real** — o que cada uma tem de
    exclusivo — sem contar duas vezes o que as duas já tinham em comum, e
    sem nunca inflar estoque com algo que não aconteceu de fato.
  - **Contas de login do Default** do arquivo são reconhecidas pelo nome de
    usuário (mesma ideia dos usuários comuns, só que pelo usuário em vez do
    telefone). Uma conta cujo usuário já existe localmente **fica como
    está** — a senha local continua valendo, nunca é sobrescrita pela do
    arquivo. Uma conta cujo usuário **colide com o do Admin desta máquina**
    é ignorada por um motivo diferente (e avisada separadamente no resumo
    da mesclagem): ela ficaria impossível de usar, porque o Admin é sempre
    checado primeiro na hora de logar. Diferente da importação "substituir
    tudo" (que reinicia o Admin da máquina — ver acima), a mesclagem
    **nunca** toca no login do Admin — é uma ação exclusiva dele, então não
    faria sentido ela mudar o próprio login sem querer; por isso, quando
    colide, a conta do arquivo é simplesmente deixada de fora. Só entra de
    fato uma conta cujo usuário é realmente novo e não colide com nada.

O arquivo de backup é criptografado (AES-256-GCM) com uma chave derivada da
senha que você escolhe — sem a senha, o arquivo não abre em lugar nenhum. O
mesmo arquivo `.estoquebkp` serve para os dois modos; a escolha é feita na
hora de importar, não na hora de exportar.

## Onde ficam os dados e como são protegidos

Tudo (itens, fotos, usuários, histórico, a senha do admin e as contas de
login do Default) fica em **um único arquivo criptografado** na pasta de
dados do app no seu usuário do Windows (por exemplo
`C:\Users\<voce>\AppData\Roaming\Controle de Estoque\ControleEstoqueDados\`):

- `dados.criptografado` — todos os dados do app, cifrados com AES-256-GCM
  (inclui os cadastros de login: tanto o do Admin quanto as contas de login
  do Default — nenhum fica em texto puro, e nenhuma senha é salva como tal,
  só um hash scrypt dela, ver abaixo).
- `chave.protegida` — a chave de criptografia, protegida pelo cofre de
  credenciais do próprio Windows (DPAPI), via `safeStorage` do Electron.
  Ou seja, mesmo copiando esses arquivos para outro computador, eles não
  conseguem ser abertos sem a chave protegida pelo Windows daquela mesma
  conta de usuário.
- A senha do admin (e a de cada conta de login do Default) nunca é salva em
  texto puro — só um hash (scrypt) dela, com um salt próprio por conta.

Nada é enviado para a internet: é tudo local.

## Como gerar o instalador — sem digitar nada no prompt

Extraia este zip numa pasta e **dê duplo clique em `GERAR_INSTALADOR.bat`**.
Não precisa abrir Prompt de Comando nem digitar comandos:

- Se o Node.js não estiver instalado, o script abre a página oficial para
  você instalar (uma instalação "avançar, avançar, concluir" comum) — depois
  é só clicar de novo no `.bat`.
- Na primeira vez, ele baixa sozinho o que o projeto precisa (Electron etc.)
  — isso pode demorar alguns minutos. Nas próximas vezes (por exemplo depois
  de eu te mandar uma atualização), essa etapa já sai pulando direto para
  gerar o instalador.
- No final, ele abre automaticamente a pasta `dist_installer` com o
  instalador pronto (`...Setup....exe`). É só dar duplo clique nele para
  instalar o programa normalmente, como qualquer outro programa do Windows.

Esse instalador final (`...Setup....exe`) **não depende de Node nem de
npm** — ele já embute tudo o que precisa para rodar em qualquer PC Windows,
inclusive para instalar em outros computadores que nunca tiveram Node.js.
A única etapa que ainda usa `npm` é a de *gerar* esse instalador aqui na sua
máquina (por causa de uma restrição de rede do ambiente onde eu trabalho —
detalhes mais abaixo) — e essa etapa agora é só um duplo clique.

Se quiser só testar uma mudança rapidamente sem gerar instalador, dê duplo
clique em `TESTAR_SEM_INSTALAR.bat` — abre o app na hora.

Seus dados já cadastrados (itens, usuários, histórico) **não são apagados**
ao atualizar — eles ficam salvos fora da pasta do projeto, na pasta de dados
do Windows, e o app faz uma pequena migração automática na primeira vez que
abrir (por exemplo, usuários antigos cadastrados sem telefone continuam
aparecendo, só com o campo telefone em branco).

### Por que ainda existe uma etapa de `npm` nos bastidores

O ambiente onde eu (Claude) construo esse projeto tem uma restrição de rede
que bloqueia o download do Electron — por isso não consigo gerar o
`...Setup....exe` final diretamente e te entregar pronto. Os arquivos
`.bat` acima escondem essa etapa atrás de um duplo clique, então no seu dia
a dia você não precisa mais abrir prompt nem digitar `npm` nada — só clicar
no `.bat` quando eu mandar uma atualização de código.

## Testes automatizados incluídos

Toda a lógica de negócio (autenticação do admin — incluindo a criação do
login no primeiro acesso, sem credencial padrão, e a troca do usuário/senha
do Admin depois (exigindo a senha atual) —, adicionar/remover/editar itens,
cadastro, edição e bloqueio de usuários com telefone obrigatório, regras de
movimentação de estoque — incluindo a exigência de usuário para o perfil
Default, Entrega/Retirada obrigatória, status Pendente/Concluído e a troca
pelo admin, permissão de foto sem usuário só para admin, a exigência de
preço no fluxo de registro em lote —, consultas por usuário/item com
período, lançamentos avulsos, pagamentos (incluindo a criação pelo perfil
Default e o bloqueio de usuários específicos para ele) e o cálculo de
pendências por usuário — incluindo editar e excluir um lançamento avulso,
editar e excluir um pagamento, excluir todo o histórico de lançamentos/
pagamentos de uma vez, a preservação de quantidade/valor de uma pendência
depois que o item é removido do catálogo, e a quitação em uma tacada só de
um usuário (`quitarPendenciaUsuario`) junto com a lista dos já quitados
(`listarUsuariosQuitados`) —, a seleção de pedidos por período para o
relatório de pedidos em PDF, a seleção de itens com quantidade > 0 para o
relatório de quantidades em PDF, o gerenciador de login das contas do
Default (criar exigindo usuário único e senha com 6+ caracteres, listar,
excluir, resetar senha voltando a exigir troca, `verificarLogin`
reconhecendo tanto o admin quanto uma conta, e a troca de senha do primeiro
acesso, e `precisaConfigurarLoginInicial` nunca voltando a `true` depois do
primeiro acesso, nem quando uma importação total zera o Admin), backup/
restauração (incluindo as contas de login entrando no arquivo — exceto o
login do próprio Admin —, a mesclagem reconhecendo pelo id o que já existe
dos dois lados — sem duplicar, sem alterar quantidade à toa — e aplicando
só a diferença real de movimentações novas, a mesclagem de contas de login
reconhecendo pelo usuário, sem sobrescrever a senha local, o Admin local
sendo zerado por uma importação "substituir tudo" mesmo quando uma conta do
arquivo colide com o usuário do Admin local — e essa mesma conta passando a
autenticar normalmente depois —, e o caso correspondente na mesclagem,
avisado separadamente sem mexer no Admin), o resumo geral de pendências
somando todos os usuários (`totalizarPendencias`, batendo com a soma manual
de `listarUsuariosPendentes`/`listarUsuariosQuitados`), precificação e a
criptografia) tem 107 testes automatizados que rodam com Node puro, sem
precisar do Electron instalado — inclusive a recusa de recriar o Admin
chamando a ação direto depois de uma importação total.

Além deles:

- `test/desktop-smoke.js` carrega o `main.js` de verdade com um Electron "de
  mentira" e percorre 50 ações da interface na ordem em que a tela as faz
  (login, catálogo, PDFs, backup, conta do Default, desfazer, importação…).
- `test/web-tests.js` sobe o servidor web e testa 25 cenários: proteção
  CSRF, limites de tamanho, fotos (gravadas à parte, criptografadas,
  servidas só pra quem está logado, SVG/links recusados), sessões
  (sobrevivem ao servidor reiniciar, caem quando a senha muda, cookie
  adulterado não vale), bloqueio por senha errada, importação pelo Default
  (só "substituir tudo") pelo envio grande, o link com token do
  Admin, a recusa de subir com a `CHAVE_DADOS` errada, e o armazenamento no
  Supabase contra um Supabase falso local.
- `test/web-e2e.py` abre a versão web num **navegador de verdade**
  (Chromium), no tamanho de computador e de um iPhone, e usa a interface
  como uma pessoa usaria (precisa de Python + Playwright).

O GitHub roda tudo isso sozinho a cada envio (aba **Actions**).
A geração dos arquivos PDF em si (feita com o
`printToPDF` do Electron, em `main.js`) não entra nesses testes — só os dados
que alimentam os relatórios (`listarPedidosParaRelatorio`,
`listarQuantidadesAtuaisParaRelatorio`, `detalharPendenciasUsuario` e
`consultarPorUsuario`/`consultarPorItem`, todos em `src/logic.js`) são
cobertos, já que os testes rodam sem o Electron:

```
npm test                  (lógica + desktop + servidor web)
python3 test/web-e2e.py   (navegador)
```

## Estrutura do projeto

```
GERAR_INSTALADOR.bat    duplo clique para gerar o instalador do Windows (sem prompt)
TESTAR_SEM_INSTALAR.bat duplo clique para rodar o app direto, sem instalar
PUBLICAR_NO_GITHUB.bat  duplo clique para enviar o código ao seu repositório no GitHub
main.js                 app desktop: janela, diálogos nativos, PDF do Electron
preload.js              ponte segura entre a interface e o processo principal (desktop)
src/handlers.js         todas as ações da interface + permissões (desktop E web)
src/logic.js            regras de negócio (puro, sem I/O)
src/relatorios-html.js  HTML dos relatórios (desktop vira PDF; web imprime)
src/crypto-utils.js     hashing de senha e criptografia AES-256-GCM (puro)
src/migracao.js         atualiza dados de versões antigas (puro)
src/store.js            leitura/escrita do arquivo criptografado local (desktop)
renderer/               interface (HTML/CSS/JS) — a mesma no desktop e na web
web/server.js           servidor da versão web (Node puro, sem dependências)
web/repositorio.js      criptografia + fotos à parte + fila de gravação (web)
web/armazenamento.js    Supabase (produção) ou pasta local (testes)
web/sessao-cookie.js    sessão de login em cookie criptografado (web)
web/public/             "preload" da web (api-web.js), CSS de celular, ícones
render.yaml             configuração do Render (plano gratuito)
supabase/schema.sql     tabela + bucket do Supabase (rodar uma vez)
.github/workflows/      testes automáticos e o "manter ativo" do Supabase
test/                   testes automatizados (lógica, desktop, web, navegador)
```

## Observações de design (caso queira ajustar)

- Os botões `+`/`−` de cada item só **selecionam** a direção do movimento
  (somar ou subtrair a quantidade escrita no campo ao lado — não é "definir
  quantidade igual a X"); nada é aplicado até clicar em **"Confirmar"**,
  logo abaixo, que fica desabilitado até uma direção ser escolhida. Isso
  evita alterar o estoque sem querer com um clique acidental no + ou no −.
  O perfil Default nem vê o botão `+` — só o `−` aparece pra ele, já que
  ele nunca pode adicionar quantidade.
- Remover um item do catálogo ou um usuário **não apaga o histórico** já
  registrado — o nome do item/usuário fica gravado na movimentação mesmo
  depois de removido do cadastro. Removendo um item, ele desaparece por
  completo do **Catálogo** e da **Precificação** (não dá mais pra definir/ver
  preço dele ali), mas a movimentação continua na aba **Histórico** e em
  **Consultar**, com o nome, a quantidade retirada e o valor de qualquer
  pendência em aberto todos preservados — inclusive se essa saída ainda
  estiver **pendente** e mesmo que o usuário tenha várias pendências de itens
  diferentes: nenhuma delas some da aba **Pendências** por causa da remoção.
  Enquanto o item ainda está no catálogo, uma pendência em aberto usa sempre
  o preço **atual** dele (assim, corrigir o preço na Precificação antes do
  pagamento também corrige a pendência). No instante em que o item é
  removido, esse último preço conhecido fica "carimbado" em todas as
  movimentações dele — é esse valor que passa a sustentar qualquer pendência
  em aberto dali pra frente, já que não existe mais um preço atual pra
  consultar. Isso vale mesmo se o preço só tiver sido definido na
  Precificação bem depois da saída original (fluxo comum: registrar a saída
  primeiro, precificar depois) — o que conta é o último preço que o item
  teve antes de sair do catálogo, nunca R$ 0,00.
- Não é possível registrar uma **saída** que deixaria o estoque negativo — a
  única exceção é a mesclagem de backup, que pode deixar um item negativo de
  propósito (ver seção "Backup"); uma **entrada** consegue recuperar
  normalmente um item nesse estado, mesmo que o resultado ainda fique
  negativo.
- Fotos são redimensionadas automaticamente no navegador antes de salvar
  (para não deixar o arquivo de dados gigante).
- Os valores da aba Precificação (valor em estoque, saído e pendente) são
  sempre calculados na hora a partir do valor unitário e das movimentações —
  nunca ficam "prontos" guardados em disco, então nunca desatualizam.
- Na importação "Mesclar", itens são casados pelo **nome** (não pelo id
  interno, que é sempre diferente entre instalações) — dois itens com nomes
  digitados de forma diferente (ex.: "Papel A4" e "papel a4 ") são tratados
  como o mesmo, ignorando maiúsculas/minúsculas e espaços nas pontas; nomes
  realmente diferentes viram itens separados.

Qualquer uma dessas regras pode ser mudada — é só pedir.
