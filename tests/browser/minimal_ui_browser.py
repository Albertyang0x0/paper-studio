"""Dark UI, three input slots and real PDF compilation using synthetic fixtures only."""
import io
import json
import zipfile
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from browser_runtime import launch_browser

ROOT = Path(__file__).resolve().parents[2]
QA = Path(os.environ.get('PAPER_TEST_ROOT', str(ROOT / 'outputs' / 'test'))) / 'qa'
SOURCE = ROOT / 'examples' / 'demo'
BASE = os.environ.get('PAPER_TEST_BASE_URL', 'http://localhost:8788')
QA.mkdir(parents=True, exist_ok=True)

def rgb(value):
    return [int(channel) for channel in value.removeprefix('rgb(').removesuffix(')').split(',')]

def contrast(foreground, background):
    def luminance(channels):
        linear = [channel / 255 / 12.92 if channel / 255 <= 0.04045 else ((channel / 255 + 0.055) / 1.055) ** 2.4 for channel in channels]
        return sum(channel * weight for channel, weight in zip(linear, [0.2126, 0.7152, 0.0722]))
    a, b = sorted([luminance(foreground), luminance(background)])
    return (b + 0.05) / (a + 0.05)

def assert_desktop_font(locator, size=None):
    style = locator.evaluate('(e) => ({font:getComputedStyle(e).fontFamily, size:getComputedStyle(e).fontSize})')
    assert 'Segoe UI' in style['font'], style
    assert not any(font in style['font'] for font in ['Georgia', 'Consolas', 'serif,']), style
    if size:
        assert style['size'] == size, style

archive = io.BytesIO()
with zipfile.ZipFile(archive, 'w') as bundle:
    for name in ['template.tex', 'paperstudio_demo.sty']:
        bundle.write(SOURCE / 'template' / name, name)

with sync_playwright() as p:
    browser = launch_browser(p)
    page = browser.new_page(viewport={'width': 1600, 'height': 1000})
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    assert page.request.get(BASE + '/api/workbench/status').json().get('dataScope') == 'test', 'Refusing to write test fixtures to a live server'
    # Create a completely synthetic seed; never read a live manuscript or parent repository.
    seeded = page.request.post(BASE + '/api/papers', data={'title': 'QA Synthetic preview seed',
        'ideaSpark': (SOURCE / 'inputs' / 'idea.md').read_text(encoding='utf-8'), 'materials': [], 'language': 'en'})
    assert seeded.ok, seeded.text()
    ORIGINAL = seeded.json()['id']
    for module in ['abstract', 'introduction', 'related_work', 'method', 'experiments', 'conclusion']:
        content = f'Synthetic {module} fixture. This is a UI test, not a real research result. The hypothetical input $x$ is reviewed before a decision is saved.'
        if module == 'experiments':
            content += '\n\nNo experiments were run.\n\n| Planned measure | Status |\n| --- | --- |\n| Correctness | Not measured |\n| Review time | Not measured |'
        response = page.request.post(BASE + f'/api/papers/{ORIGINAL}/modules/{module}', data={'expectedRevision': 0, 'content': content})
        assert response.ok, response.text()
    page.goto(BASE + '/?project=' + ORIGINAL, wait_until='networkidle')
    expect(page.get_by_label('选择论文项目')).to_have_value(ORIGINAL)
    assert page.locator('html').evaluate('(e) => getComputedStyle(e).colorScheme') == 'dark'
    assert_desktop_font(page.locator('.pw-app'), '14px')
    assert_desktop_font(page.locator('.pw-editor'), '14px')
    page.screenshot(path=str(QA / 'workbench-minimal.png'), full_page=True)
    text = page.locator('body').inner_text()
    for banned in ['方法决定执行流程', '生成 ≠ 写入主稿', 'COMPOSABLE RESEARCH WRITING', 'A PAPER IS A LIVING PROJECT']:
        assert banned not in text, banned
    for selector in ['.pw-header', '.pw-sidebar', '.pw-method-panel', '.pw-main']:
        color = page.locator(selector).evaluate('(e) => getComputedStyle(e).backgroundColor')
        channels = rgb(color)
        assert max(channels) == min(channels) and max(channels) < 65, (selector, color)
    colors = page.locator('.pw-primary').first.evaluate('(e) => ({fg:getComputedStyle(e).color, bg:getComputedStyle(e).backgroundColor})')
    assert contrast(rgb(colors['fg']), rgb(colors['bg'])) >= 4.5, colors
    colors = page.locator('.pw-project-head p').evaluate('(e) => ({fg:getComputedStyle(e).color, bg:getComputedStyle(document.querySelector(".pw-main")).backgroundColor})')
    assert contrast(rgb(colors['fg']), rgb(colors['bg'])) >= 4.5, colors
    for width in [1600, 1280, 900, 768]:
        page.set_viewport_size({'width': width, 'height': 1000})
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), width
    page.set_viewport_size({'width': 1600, 'height': 1000})
    page.get_by_role('button', name='新建研究', exact=True).click()
    dialog = page.get_by_role('dialog', name='研究材料设置')
    assert_desktop_font(dialog.get_by_label('项目名称'))
    assert max(rgb(dialog.evaluate('(e) => getComputedStyle(e).backgroundColor'))) < 65
    assert dialog.locator('input[type=file]').count() == 3
    dialog.get_by_label('项目名称').fill('QA Minimal UI - synthetic template integration')
    dialog.get_by_label('上传论文模板').set_input_files({'name': 'demo-template.zip', 'mimeType': 'application/zip', 'buffer': archive.getvalue()})
    dialog.get_by_label('上传 idea', exact=True).set_input_files(str(SOURCE / 'inputs' / 'idea.md'))
    dialog.get_by_label('上传 experiment', exact=True).set_input_files(str(SOURCE / 'inputs' / 'experimental_log.md'))
    expect(dialog.get_by_text('demo-template.zip', exact=True)).to_be_visible()
    expect(dialog.get_by_text('idea.md', exact=True)).to_be_visible()
    expect(dialog.get_by_text('experimental_log.md', exact=True)).to_be_visible()
    page.screenshot(path=str(QA / 'workbench-three-inputs.png'), full_page=True)
    with page.expect_response(lambda r: r.url.endswith('/api/papers') and r.request.method == 'POST') as created:
        dialog.get_by_role('button', name='保存研究项目', exact=True).click()
    project = created.value.json()
    ident = project['id']
    expect(page.get_by_label('选择论文项目')).to_have_value(ident)
    original = page.request.get(BASE + '/api/papers/' + ORIGINAL).json()
    assert next(f for f in project['template']['files'] if f['name'] == 'paperstudio_demo.sty')['content'] == (SOURCE / 'template' / 'paperstudio_demo.sty').read_text(encoding='utf-8')
    assert [m['role'] for m in project['materials']] == ['idea', 'experiment']
    # Exercise the renderer with a synthetic manuscript; no AI or real paper is involved.
    for module in ['abstract', 'introduction', 'related_work', 'method', 'experiments', 'conclusion']:
        r = page.request.post(BASE + f'/api/papers/{ident}/modules/{module}', data={
            'expectedRevision': 0, 'content': original['modules'][module]['content']})
        assert r.ok, r.text()
    source = page.request.get(BASE + f'/api/papers/{ident}/export/tex').text()
    assert r'\usepackage{paperstudio_demo}' in source
    assert 'Research Manuscript' not in source and 'Research draft:' not in source
    zipped = page.request.get(BASE + f'/api/papers/{ident}/export/zip')
    assert zipped.ok, zipped.text()
    with zipfile.ZipFile(io.BytesIO(zipped.body())) as bundle:
        assert {'main.tex', 'paperstudio_demo.sty', 'references.bib'}.issubset(bundle.namelist())
        assert bundle.read('paperstudio_demo.sty').decode() == next(f for f in project['template']['files'] if f['name'] == 'paperstudio_demo.sty')['content']
    build = page.request.post(BASE + f'/api/papers/{ident}/build', data={}, timeout=90000)
    assert build.ok, build.text()
    compiled = build.json()
    pdf = page.request.get(BASE + compiled['url'])
    assert pdf.ok and pdf.body().startswith(b'%PDF')
    pdf_path = QA.parent / 'papers' / ident / 'builds' / compiled['id'] / 'main.pdf'
    # Confirm refresh preserves all three input types and no original manuscript was changed.
    page.reload(wait_until='networkidle')
    expect(page.get_by_label('选择论文项目')).to_have_value(ident)
    page.locator('.pw-source-card').click()
    expect(page.get_by_text('demo-template.zip', exact=True)).to_be_visible()
    page.get_by_label('关闭材料设置').click()
    assert page.request.get(BASE + '/api/papers/' + ORIGINAL).json() == original
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    # Drawboard chrome and slogan regression.
    page.goto(BASE + '/figure?paperEmbed=1', wait_until='networkidle')
    assert_desktop_font(page.locator('.app-shell'), '14px')
    for selector in ['.topbar', '.left-panel', '.inspector', '.board-area']:
        assert max(rgb(page.locator(selector).evaluate('(e) => getComputedStyle(e).backgroundColor'))) < 65
    assert '不是一张“生成完就结束”的图。' not in page.locator('body').inner_text()
    assert '不把整张位图' not in page.locator('body').inner_text()
    assert '图表是起点' not in page.locator('body').inner_text()
    page.screenshot(path=str(QA / 'canvas-minimal.png'), full_page=True)
    assert not errors, errors
    report = {'passed': True, 'projectId': ident, 'pdfPath': str(pdf_path), 'build': compiled,
              'checks': ['dark desktop chrome', 'shared Segoe UI font stack', 'readable text contrast', 'no overflow at four widths', 'slogans removed', 'exactly three upload slots', 'real ZIP and two Markdown uploads',
                         'template saved across refresh', 'synthetic style dependency used', 'source ZIP dependencies',
                         'actual PDF compilation', 'original manuscript preserved', 'canvas slogans removed'],
              'modelCalls': 0, 'contentSource': 'Synthetic fixtures only; no private research data or scientific quality claim', 'runtimeErrors': errors}
    (QA / 'minimal-ui-validation.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps(report))
    browser.close()
