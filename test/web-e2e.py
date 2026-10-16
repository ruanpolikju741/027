"""
Teste ponta a ponta da versão WEB num navegador de verdade (Chromium, via Playwright):
computador e celular (iPhone emulado). Sobe o servidor com armazenamento local numa pasta
temporária, usa a interface como uma pessoa usaria e confere o resultado.

Requisitos: Python 3 + `pip install playwright` + `playwright install chromium`.
Rode com:  python3 test/web-e2e.py   (opcional: pasta pra salvar capturas de tela como argumento)
"""

import base64
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

from playwright.sync_api import sync_playwright, expect

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PASTA_CAPTURAS = sys.argv[1] if len(sys.argv) > 1 else None
PNG = base64.b64decode(
    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR42mP8z8BQz0AEYBxVSF+FAP5FDvcfRYWgAAAAAElFTkSuQmCC'
)


def porta_livre():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def captura(pagina, nome):
    if PASTA_CAPTURAS:
        os.makedirs(PASTA_CAPTURAS, exist_ok=True)
        pagina.screenshot(path=os.path.join(PASTA_CAPTURAS, nome), full_page=False)


def passo(texto):
    print('  OK  -', texto)


def main():
    tmp = tempfile.mkdtemp(prefix='estoque-e2e-')
    porta = porta_livre()
    base = f'http://127.0.0.1:{porta}'
    env = dict(os.environ, PORT=str(porta), PASTA_DADOS_LOCAL=os.path.join(tmp, 'dados'))
    env.pop('SUPABASE_URL', None)
    servidor = subprocess.Popen(['node', 'web/server.js'], cwd=RAIZ, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    try:
        for _ in range(50):
            try:
                urllib.request.urlopen(base + '/api/vivo', timeout=1)
                break
            except Exception:
                time.sleep(0.2)
        foto = os.path.join(tmp, 'foto.png')
        with open(foto, 'wb') as f:
            f.write(PNG)

        with sync_playwright() as p:
            navegador = p.chromium.launch()
            erros_console = []

            # ------------------------------------------------------------- computador
            ctx = navegador.new_context(viewport={'width': 1280, 'height': 820}, accept_downloads=True, locale='pt-BR')
            pg = ctx.new_page()
            pg.on('console', lambda m: erros_console.append(m.text) if m.type == 'error' else None)
            pg.on('pageerror', lambda e: erros_console.append(str(e)))
            pg.goto(base + '/')
            expect(pg.locator('#modal-primeiro-acesso')).to_be_visible()
            pg.fill('#primeiro-acesso-usuario', 'dono')
            pg.fill('#primeiro-acesso-senha', 'senhaForte1')
            pg.fill('#primeiro-acesso-confirmar', 'senhaForte1')
            pg.click('#primeiro-acesso-confirmar-btn')
            expect(pg.locator('#modal-primeiro-acesso')).to_be_hidden()
            expect(pg.locator('#perfil-label')).to_contain_text('Admin')
            passo('primeiro acesso cria o Admin e entra')

            pg.click('#btn-add-item')
            pg.fill('#item-nome', 'Caixa de Água')
            pg.fill('#item-quantidade', '10')
            pg.set_input_files('#item-foto-input', foto)
            expect(pg.locator('#item-foto-preview img')).to_be_visible()
            pg.click('#item-salvar')
            card_img = pg.locator('#catalogo-grid .card-foto img').first
            expect(card_img).to_be_visible()
            expect(card_img).to_have_attribute('src', re.compile(r'^/api/midia/[0-9a-f]{64}$'))
            pg.wait_for_function("() => { const i = document.querySelector('#catalogo-grid .card-foto img'); return i && i.complete && i.naturalWidth > 0; }")
            passo('item com foto: a foto é gravada à parte e aparece no card')

            pg.click('.tab-btn[data-tab="usuarios"]')
            pg.fill('#novo-usuario-telefone', '27999990000')
            pg.fill('#novo-usuario-nome', 'Maria Souza')
            pg.click('#btn-add-usuario')
            expect(pg.locator('#tab-usuarios')).to_contain_text('Maria Souza')
            res = pg.evaluate("""async () => {
                const usuarios = await window.api.usuarios.list();
                const itens = await window.api.items.list();
                await window.api.items.definirPreco(itens[0].id, 7.5);
                return window.api.items.adjust({ itemId: itens[0].id, tipo: 'saida', quantidade: 2,
                  usuarioId: usuarios[0].id, tipoEntrega: 'entrega', pendente: true });
            }""")
            assert res['ok'], res
            passo('usuário cadastrado e movimentação registrada')

            pg.click('.tab-btn[data-tab="catalogo"]')
            with pg.expect_popup() as info:
                pg.click('#btn-exportar-quantidades-pdf')
            relatorio = info.value
            expect(relatorio.locator('h1')).to_contain_text('Quantidades do Catálogo')
            expect(relatorio.locator('.barra-relatorio button', has_text='Salvar PDF')).to_be_visible()
            expect(relatorio.locator('body')).to_contain_text('Caixa de Água')
            captura(relatorio, 'relatorio-web.png')
            relatorio.close()
            passo('relatório abre numa aba pronta pra "Salvar como PDF"')

            pg.click('.tab-btn[data-tab="pendencias"]')
            pg.evaluate('() => renderPendencias()')  # a movimentação acima foi feita direto pela API
            expect(pg.locator('#pendencias-geral-saldo')).to_have_text(re.compile(r'15,00'))
            pg.locator('#pendencias-table [data-pendencia-ver]').first.click()
            with pg.expect_popup() as info:
                pg.click('#pendencias-detalhe-exportar-pdf')
            expect(info.value.locator('h1')).to_contain_text('Maria Souza')
            info.value.close()
            passo('pendências: totais gerais e PDF do usuário')

            # "Marcar como recebido": resolve a pendência individual sem registrar pagamento algum
            # e sem devolver a quantidade ao item — diferente de "Excluir do histórico".
            item_antes = pg.evaluate("() => window.api.items.list().then(l => l[0].quantidade)")
            assert item_antes == 8, item_antes  # 10 iniciais - 2 da saída pendente
            pg.locator('#pendencias-detalhe-itens-table [data-pendencia-marcar-recebido]').first.click()
            expect(pg.locator('#pendencias-geral-saldo')).to_have_text(re.compile(r'0,00'))
            expect(pg.locator('#pendencias-detalhe-saldo')).to_have_text(re.compile(r'0,00'))
            expect(pg.locator('#pendencias-detalhe-itens-vazio')).to_be_visible()
            item_depois = pg.evaluate("() => window.api.items.list().then(l => l[0].quantidade)")
            assert item_depois == 8, item_depois  # quantidade do item não volta (diferente de excluir)
            passo('pendências: "Marcar como recebido" resolve sem mexer na quantidade do item')

            # "Pagamento geral": compara com a soma da coluna "✓ Já pago" (`pendencias.listarQuitados`),
            # NÃO com o total geral do sistema. "Beraht" fica quitado com R$15 (2un x R$7,50) — essa é
            # a base da comparação. "Ezio" tem uma pendência separada de R$7,50, ainda em aberto.
            setup_geral = pg.evaluate("""async () => {
                const itens = await window.api.items.list();
                const item = itens.find((i) => i.nome === 'Caixa de Água');
                const beraht = await window.api.usuarios.add('Beraht', '27900005555');
                const rB = await window.api.items.adjust({ itemId: item.id, tipo: 'saida', quantidade: 2,
                  usuarioId: beraht.usuario.id, tipoEntrega: 'retirada', pendente: true });
                await window.api.pagamentos.adicionar(beraht.usuario.id, 15, 'Pagou tudo');
                const ezio = await window.api.usuarios.add('Ezio', '27900001234');
                const rE = await window.api.items.adjust({ itemId: item.id, tipo: 'saida', quantidade: 1,
                  usuarioId: ezio.usuario.id, tipoEntrega: 'retirada', pendente: true });
                return { berahtId: beraht.usuario.id, ezioId: ezio.usuario.id, ok: rB.ok && rE.ok };
            }""")
            assert setup_geral['ok'], setup_geral
            beraht_id = setup_geral['berahtId']
            ezio_id = setup_geral['ezioId']
            quitados_antes = pg.evaluate(
                "(id) => window.api.pendencias.listarQuitados().then(l => l.some((u) => u.usuarioId === id))",
                beraht_id,
            )
            assert quitados_antes, 'Beraht deveria estar na coluna "✓ Já pago" antes do pagamento geral'
            pg.click('.tab-btn[data-tab="pendencias"]')
            pg.evaluate('() => renderPendencias()')
            pg.fill('#pendencias-pagamento-geral-valor', '20')  # base = 15 (Beraht) → excedente de 5
            pg.click('#btn-pendencias-pagamento-geral')
            pg.click('#confirm-ok')
            saldo_ezio = pg.evaluate(
                "(id) => window.api.pendencias.detalharUsuario(id).then(d => d.totalPendente)", ezio_id
            )
            assert saldo_ezio == 2.5, saldo_ezio  # 7.5 - 5 (excedente: 20 - 15)
            detalhe_beraht = pg.evaluate(
                "(id) => window.api.pendencias.detalharUsuario(id)", beraht_id
            )
            assert detalhe_beraht['totalPagamentos'] == 0, detalhe_beraht
            assert detalhe_beraht['totalPendencias'] == 0, detalhe_beraht
            assert detalhe_beraht['totalPendente'] == 0, detalhe_beraht  # removido por completo, não volta a dever
            quitados_depois = pg.evaluate(
                "(id) => window.api.pendencias.listarQuitados().then(l => l.some((u) => u.usuarioId === id))",
                beraht_id,
            )
            assert not quitados_depois, 'Beraht deveria ter saído de "✓ Já pago" (removido por completo)'
            pendentes_depois = pg.evaluate(
                "(id) => window.api.pendencias.listarUsuarios().then(l => l.some((u) => u.usuarioId === id))",
                beraht_id,
            )
            assert not pendentes_depois, 'Beraht não deveria voltar a aparecer em "Pendentes" (já foi recebido)'
            passo('pagamento geral: compara com a coluna "✓ Já pago", lança o excedente pro "Ezio" e remove o Beraht por completo')

            # Valor MENOR que a soma da coluna "✓ Já pago" — lança o valor informado INTEIRO pro
            # "Ezio" (não rejeita, não calcula excedente nenhum). Pra isso, precisa de alguém de
            # novo quitado (o Beraht saiu da coluna no passo anterior): "Fulano Geral" fica quitado com R$15.
            setup_menor = pg.evaluate("""async () => {
                const itens = await window.api.items.list();
                const item = itens.find((i) => i.nome === 'Caixa de Água');
                const fulano = await window.api.usuarios.add('Fulano Geral', '27900006666');
                const r = await window.api.items.adjust({ itemId: item.id, tipo: 'saida', quantidade: 2,
                  usuarioId: fulano.usuario.id, tipoEntrega: 'retirada', pendente: true });
                await window.api.pagamentos.adicionar(fulano.usuario.id, 15, 'Pagou tudo');
                return { fulanoId: fulano.usuario.id, ok: r.ok };
            }""")
            assert setup_menor['ok'], setup_menor
            fulano_id = setup_menor['fulanoId']
            pg.evaluate('() => renderPendencias()')
            saldo_ezio_antes = pg.evaluate(
                "(id) => window.api.pendencias.detalharUsuario(id).then(d => d.totalPendente)", ezio_id
            )
            assert saldo_ezio_antes == 2.5, saldo_ezio_antes
            pg.fill('#pendencias-pagamento-geral-valor', '2')  # base = 15 (Fulano) → valor inteiro (menor)
            pg.click('#btn-pendencias-pagamento-geral')
            pg.click('#confirm-ok')
            saldo_ezio_depois = pg.evaluate(
                "(id) => window.api.pendencias.detalharUsuario(id).then(d => d.totalPendente)", ezio_id
            )
            assert saldo_ezio_depois == 0.5, saldo_ezio_depois  # 2.5 - 2 (valor inteiro, sem excedente)
            detalhe_fulano = pg.evaluate(
                "(id) => window.api.pendencias.detalharUsuario(id)", fulano_id
            )
            assert detalhe_fulano['totalPagamentos'] == 0, detalhe_fulano
            assert detalhe_fulano['totalPendencias'] == 0, detalhe_fulano
            assert detalhe_fulano['totalPendente'] == 0, detalhe_fulano  # removido por completo também
            passo('pagamento geral: valor menor que a coluna "✓ Já pago" lança o valor inteiro pro "Ezio"')

            # Quantidade fracionária no catálogo (não só número inteiro).
            pg.click('.tab-btn[data-tab="catalogo"]')
            pg.click('#btn-add-item')
            pg.fill('#item-nome', 'Ração a granel')
            pg.fill('#item-quantidade', '2.5')
            pg.click('#item-salvar')
            expect(pg.locator('#catalogo-grid .card', has_text='Ração a granel')).to_contain_text('2.5')
            passo('quantidade fracionária: item criado com 2.5 unidades')

            pg.click('.tab-btn[data-tab="contas-login"]')
            pg.fill('#conta-login-usuario', 'joana')
            pg.fill('#conta-login-senha', 'temp123')
            pg.click('#btn-conta-login-criar')
            expect(pg.locator('#tab-contas-login')).to_contain_text('joana')

            # Conta com acesso de Admin: criada com a caixinha "Admin" (pede confirmação).
            pg.fill('#conta-login-usuario', 'gerente')
            pg.fill('#conta-login-senha', 'temp123')
            pg.check('#conta-login-admin')
            pg.click('#btn-conta-login-criar')
            expect(pg.locator('#confirm-mensagem')).to_contain_text('mesmos poderes')
            pg.click('#confirm-ok')
            linha = pg.locator('#contas-login-table tr', has_text='gerente')
            expect(linha.locator('.badge-status-admin')).to_be_visible()
            expect(pg.locator('#contas-login-table tr', has_text='joana').locator('[data-conta-login-admin]')).to_have_text('Tornar Admin')
            pg.click('#btn-sair')
            pg.click('#confirm-ok')
            pg.fill('#login-usuario', 'gerente')
            pg.fill('#login-senha', 'temp123')
            pg.click('#login-confirmar-btn')
            pg.fill('#login-nova-senha', 'gerente1')
            pg.fill('#login-nova-senha-confirmar', 'gerente1')
            pg.click('#login-trocar-senha-btn')
            expect(pg.locator('#modal-login')).to_be_hidden()
            expect(pg.locator('#perfil-label')).to_have_text('Perfil: Admin (gerente)')
            pg.click('.tab-btn[data-tab="contas-login"]')
            minha = pg.locator('#contas-login-table tr', has_text='gerente')
            expect(minha).to_contain_text('(você)')
            expect(minha.locator('[data-conta-login-excluir]')).to_have_count(0)
            captura(pg, 'contas-admin.png')
            passo('conta promovida a Admin: entra com o próprio nome e não pode se excluir')

            pg.click('.tab-btn[data-tab="backup"]')
            pg.fill('#backup-exportar-senha', 'backup123')
            with pg.expect_download() as dl:
                pg.click('#btn-backup-exportar')
            arquivo_backup = os.path.join(tmp, dl.value.suggested_filename)
            dl.value.save_as(arquivo_backup)
            assert arquivo_backup.endswith('.estoquebkp')
            assert os.path.getsize(arquivo_backup) > 500
            passo('backup exportado como download (' + os.path.basename(arquivo_backup) + ')')

            pg.click('#btn-sair')
            pg.click('#confirm-ok')
            expect(pg.locator('#modal-login')).to_be_visible()
            pg.fill('#login-usuario', 'joana')
            pg.fill('#login-senha', 'temp123')
            pg.click('#login-confirmar-btn')
            expect(pg.locator('#login-passo-trocar-senha')).to_be_visible()
            pg.fill('#login-nova-senha', 'joana123')
            pg.fill('#login-nova-senha-confirmar', 'joana123')
            pg.click('#login-trocar-senha-btn')
            expect(pg.locator('#modal-login')).to_be_hidden()
            expect(pg.locator('#perfil-label')).to_contain_text('Default')
            passo('conta do Default: senha temporária trocada no primeiro login')

            # Histórico: Default só pode selecionar/excluir uma movimentação que ele mesmo marcou
            # como "📝 Marcar como recebido" — nunca o histórico inteiro de uma vez.
            setup_mov = pg.evaluate("""async () => {
                const usuarios = await window.api.usuarios.list();
                const maria = usuarios.find((u) => u.nome === 'Maria Souza');
                const itens = await window.api.items.list();
                const item = itens.find((i) => i.nome === 'Caixa de Água');
                const antes = item.quantidade;
                const r = await window.api.items.adjust({ itemId: item.id, tipo: 'saida', quantidade: 1,
                  usuarioId: maria.id, tipoEntrega: 'retirada' });
                return { ok: r.ok, qtdAntes: antes, itemId: item.id };
            }""")
            assert setup_mov['ok'], setup_mov
            pg.click('.tab-btn[data-tab="historico"]')
            pg.evaluate('() => renderHistoricoDoDia()')
            expect(pg.locator('#btn-historico-excluir-tudo')).to_be_hidden()  # exclusivo do Admin
            linhas_antes = pg.locator('#historico-table tbody tr').count()
            primeira_linha = pg.locator('#historico-table tbody tr').first
            expect(primeira_linha.locator('.historico-check')).to_have_count(0)  # ainda não marcada
            primeira_linha.locator('.btn-marcar-recebido').click()
            expect(primeira_linha.locator('.historico-check')).to_have_count(1)  # marcada → aparece a caixinha
            primeira_linha.locator('.historico-check').check()
            pg.click('#btn-historico-excluir-selecionados')
            pg.click('#confirm-ok')
            expect(pg.locator('#historico-table tbody tr')).to_have_count(linhas_antes - 1)
            qtd_depois = pg.evaluate(
                "(id) => window.api.items.list().then(l => l.find((i) => i.id === id).quantidade)", setup_mov['itemId']
            )
            assert qtd_depois == setup_mov['qtdAntes'], qtd_depois  # quantidade devolvida (excluir reverte)
            passo('histórico: Default só exclui o que ele mesmo marcou como recebido, e a quantidade volta')

            # Backup é exclusivo do Admin agora — o Default (joana) nem vê a aba no menu.
            expect(pg.locator('.tab-btn[data-tab="backup"]')).to_be_hidden()
            passo('Default não vê a aba Backup no menu')

            pg.click('#btn-sair')
            pg.click('#confirm-ok')
            expect(pg.locator('#modal-login')).to_be_visible()
            pg.fill('#login-usuario', 'gerente')
            pg.fill('#login-senha', 'gerente1')
            pg.click('#login-confirmar-btn')
            expect(pg.locator('#modal-login')).to_be_hidden()

            pg.click('.tab-btn[data-tab="backup"]')
            expect(pg.locator('#btn-backup-exportar')).to_be_visible()
            expect(pg.locator('#btn-backup-importar')).to_be_visible()
            expect(pg.locator('input[name="modo-importar"][value="mesclar"]')).to_be_visible()  # Admin vê as duas opções
            pg.fill('#backup-importar-senha', 'backup123')
            pg.click('#btn-backup-importar')
            with pg.expect_file_chooser() as fc:
                pg.click('#confirm-ok')
            fc.value.set_files(arquivo_backup)
            expect(pg.locator('#modal-login')).to_be_visible(timeout=15000)
            pg.fill('#login-usuario', 'dono')
            pg.fill('#login-senha', 'senhaForte1')
            pg.click('#login-confirmar-btn')
            expect(pg.locator('#login-erro')).to_be_visible()
            passo('importação total pelo Admin: volta pro login e o Admin antigo não entra mais')

            # Sessão que perdeu a validade no meio do uso → volta pro login sozinha.
            pg.fill('#login-usuario', 'joana')
            pg.fill('#login-senha', 'temp123')
            pg.click('#login-confirmar-btn')
            pg.fill('#login-nova-senha', 'joana456')
            pg.fill('#login-nova-senha-confirmar', 'joana456')
            pg.click('#login-trocar-senha-btn')
            expect(pg.locator('#modal-login')).to_be_hidden()
            # Espera as chamadas do login terminarem (cada resposta renova o cookie) antes de apagá-lo.
            pg.wait_for_load_state('networkidle')
            ctx.clear_cookies()
            pg.click('.tab-btn[data-tab="usuarios"]')
            pg.click('#btn-add-usuario')  # qualquer ação
            pg.fill('#novo-usuario-telefone', '27911112222')
            pg.click('#btn-add-usuario')
            expect(pg.locator('#modal-login')).to_be_visible(timeout=10000)
            passo('sessão expirada: aviso e volta pra tela de login')
            ctx.close()

            # ------------------------------------------------------------- celular
            iphone = p.devices['iPhone 13']
            ctx = navegador.new_context(**iphone, locale='pt-BR')
            pg = ctx.new_page()
            pg.on('pageerror', lambda e: erros_console.append(str(e)))
            pg.goto(base + '/')
            expect(pg.locator('#modal-login')).to_be_visible()
            captura(pg, 'celular-login.png')
            pg.fill('#login-usuario', 'joana')
            pg.fill('#login-senha', 'joana456')
            pg.click('#login-confirmar-btn')
            expect(pg.locator('#modal-login')).to_be_hidden()
            expect(pg.locator('#catalogo-grid .card').first).to_be_visible()
            pg.wait_for_function("() => { const i = document.querySelector('#catalogo-grid .card-foto img'); return i && i.complete && i.naturalWidth > 0; }")
            largura = pg.evaluate('() => [document.documentElement.scrollWidth, window.innerWidth]')
            assert largura[0] <= largura[1], f'página mais larga que a tela no celular: {largura}'
            captura(pg, 'celular-catalogo.png')
            pg.click('.tab-btn[data-tab="pendencias"]')
            captura(pg, 'celular-pendencias.png')
            pg.click('.tab-btn[data-tab="historico"]')
            largura = pg.evaluate('() => [document.documentElement.scrollWidth, window.innerWidth]')
            assert largura[0] <= largura[1], f'histórico mais largo que a tela: {largura}'
            captura(pg, 'celular-historico.png')
            passo('celular (iPhone 13): login, catálogo com foto do backup, sem rolagem lateral da página')
            ctx.close()
            navegador.close()

            graves = [e for e in erros_console if 'Failed to load resource' not in e]
            assert not graves, 'erros no console do navegador: ' + ' | '.join(graves)
            passo('nenhum erro de JavaScript no console')
        print('Versão web no navegador: tudo certo.')
    finally:
        servidor.terminate()
        try:
            saida = servidor.communicate(timeout=5)[0].decode('utf-8', 'replace')
        except Exception:
            saida = ''
        if os.environ.get('MOSTRAR_LOG_SERVIDOR'):
            print(saida)
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == '__main__':
    main()
