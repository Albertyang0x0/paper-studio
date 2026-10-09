"""Real template PDF rendering, dependency repair, cache and edit refresh. No AI calls."""
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from browser_runtime import launch_browser

ROOT = Path(__file__).resolve().parents[2]
STORE = Path(os.environ['PAPER_TEST_ROOT'])
QA = STORE / 'qa'
QA.mkdir(parents=True, exist_ok=True)
SOURCE = ROOT / 'examples' / 'demo' / 'template'
BASE = os.environ.get('PAPER_TEST_BASE_URL', 'http://localhost:8788')
template = {'name': 'template.tex', 'entry': 'template.tex', 'files': [
    {'name': 'template.tex', 'content': (SOURCE / 'template.tex').read_text(encoding='utf-8')}]}

with sync_playwright() as playwright:
    browser = launch_browser(playwright)
    page = browser.new_page(viewport={'width': 1600, 'height': 1000})
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    assert page.request.get(BASE + '/api/workbench/status').json().get('dataScope') == 'test'
    created = page.request.post(BASE + '/api/papers', data={'title': 'QA Template Preview', 'ideaSpark': 'Preview fixture only.',
        'language': 'en', 'guidelines': '', 'materials': [], 'template': template})
    assert created.ok, created.text()
    ident = created.json()['id']
    for module, content in [('abstract', 'This is a local preview validation.'), ('introduction', 'ORIGINAL PREVIEW CONTENT with inline math $x_t$.')]:
        saved = page.request.post(BASE + f'/api/papers/{ident}/modules/{module}', data={'expectedRevision': 0, 'content': content})
        assert saved.ok, saved.text()
    before = saved.json()
    page.goto(BASE + '/?project=' + ident, wait_until='networkidle')
    assert '全文预览' in page.get_by_role('button').all_text_contents()
    page.get_by_role('button', name='全文预览', exact=True).click()
    expect(page.get_by_role('alert')).to_contain_text('模板缺少 paperstudio_demo.sty', timeout=90000)
    assert not page.locator('.pw-manuscript').count(), 'Must not show generic Markdown instead of the template'
    # Complete the dependency using the SAME one of three upload slots.
    page.locator('.pw-source-card').click()
    dialog = page.get_by_role('dialog', name='研究材料设置')
    assert dialog.locator('input[type=file]').count() == 3
    dialog.get_by_label('上传论文模板').set_input_files(str(SOURCE / 'paperstudio_demo.sty'))
    expect(dialog.get_by_text('2 个模板文件', exact=True)).to_be_visible()
    dialog.get_by_role('button', name='保存研究项目', exact=True).click()
    expect(dialog).not_to_be_visible()
    first = page.locator('.pw-pdf-sheet[data-page="1"][data-rendered="true"]')
    expect(first).to_be_visible(timeout=90000)
    expect(page.locator('.pw-pdf-text').first).to_contain_text('ORIGINAL PREVIEW CONTENT')
    after = page.request.get(BASE + '/api/papers/' + ident).json()
    assert after['modules'] == before['modules'] and after['sourceRevision'] == before['sourceRevision']
    assert after['template']['files'][0] == template['files'][0]
    page.screenshot(path=str(QA / 'template-pdf-preview.png'))
    builds = STORE / 'papers' / ident / 'builds'
    count = len(list(builds.iterdir()))
    old_url = page.get_by_role('link', name='打开 PDF', exact=True).get_attribute('href')
    # Both requests use the actual PDF cache, not another LaTeX invocation.
    for _ in range(2):
        with page.expect_response(lambda response: response.url.endswith('/build') and response.request.method == 'POST') as result:
            page.get_by_role('button', name='刷新', exact=True).click()
        assert result.value.json()['cached'] is True
        expect(first).to_be_visible(timeout=30000)
    assert len(list(builds.iterdir())) == count
    assert page.get_by_role('link', name='打开 PDF', exact=True).get_attribute('href') == old_url
    page.get_by_label('PDF 缩放').select_option('1.5')
    expect(first).to_be_visible(timeout=30000)
    assert first.bounding_box()['width'] == 918
    page.get_by_label('PDF 缩放').select_option('fit')
    expect(first).to_be_visible(timeout=30000)
    page.get_by_role('button', name='章节编辑', exact=True).click()
    page.get_by_label('当前模块内容', exact=True).fill('UPDATED PREVIEW CONTENT with inline math $x_{t+1}$.')
    page.get_by_role('button', name='保存到主稿', exact=True).click()
    expect(page.get_by_role('button', name='保存到主稿', exact=True)).to_be_disabled()
    page.get_by_role('button', name='全文预览', exact=True).click()
    expect(first).to_be_visible(timeout=90000)
    expect(page.locator('.pw-pdf-text').first).to_contain_text('UPDATED PREVIEW CONTENT')
    assert page.get_by_role('link', name='打开 PDF', exact=True).get_attribute('href') != old_url
    download = page.request.get(BASE + page.get_by_role('link', name='下载', exact=True).get_attribute('href'))
    assert download.ok and download.body().startswith(b'%PDF')
    assert download.headers['content-disposition'].startswith('attachment;')
    page.reload(wait_until='networkidle')
    page.get_by_role('button', name='全文预览', exact=True).click()
    expect(first).to_be_visible(timeout=90000)
    expect(page.locator('.pw-pdf-text').first).to_contain_text('UPDATED PREVIEW CONTENT')
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    assert not errors, errors
    print(json.dumps({'passed': True, 'checks': ['missing dependency error', 'single slot style upload',
        'preserved evidence and chapters', 'real PDF pages', 'selectable PDF text', 'persistent PDF cache',
        'zoom', 'saved edit refresh', 'PDF download', 'reload'], 'modelCalls': 0}))
    browser.close()
