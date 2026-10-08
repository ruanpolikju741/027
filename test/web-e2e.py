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

            pg.click('.tab-btn[data-tab="backup"]')
            expect(pg.locator('#btn-backup-exportar')).to_be_visible()
            expect(pg.locator('#btn-backup-importar')).to_be_visible()
            expect(pg.locator('input[name="modo-importar"][value="mesclar"]')).to_be_hidden()
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
            passo('importação total pelo Default: volta pro login e o Admin antigo não entra mais')

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
