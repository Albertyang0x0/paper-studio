"""Real GUI regression. The small vector scene is an interchange fixture, not AI output.
No paid calls: experiment candidate uses the deterministic missing-evidence adapter.
"""
import json
import uuid
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from browser_runtime import launch_browser

ROOT = Path(__file__).resolve().parents[2]
QA = Path(os.environ.get('PAPER_TEST_ROOT', str(ROOT / 'outputs' / 'test'))) / 'qa'
QA.mkdir(parents=True, exist_ok=True)
BASE = os.environ.get('PAPER_TEST_BASE_URL', 'http://localhost:8788')

def fixture(title):
    return {
        'schema': 'paper-atelier/1', 'id': str(uuid.uuid4()), 'title': title,
        'width': 800, 'height': 300,
        'style': {'font': 'Arial', 'ink': '#24352b', 'muted': '#666666', 'accent': '#227455',
                  'palette': ['#eef5ef'], 'lineWidth': 1.5, 'bodySize': 22, 'titleSize': 26, 'illustrationStyle': 'QA fixture'},
        'regions': [], 'connectors': [], 'annotations': [],
        'modules': [{'id': 'qa-module', 'title': 'Editable fixture', 'role': 'structure', 'brief': 'Interchange test only',
                     'componentIds': [], 'labels': ['QA'], 'sourceRefs': [], 'x': 30, 'y': 40, 'width': 740, 'height': 210,
                     'ports': [], 'method': 'vector-agent', 'status': 'ready',
                     'elements': [{'id': 'qa-box', 'type': 'rect', 'x': 10, 'y': 10, 'width': 700, 'height': 180, 'radius': 12,
                                   'fill': '#eef5ef', 'stroke': '#227455', 'strokeWidth': 2},
                                  {'id': 'qa-text', 'type': 'text', 'x': 40, 'y': 75, 'width': 600,
                                   'text': title, 'fontSize': 24, 'fill': '#24352b'}]}],
    }

with sync_playwright() as p:
    browser = launch_browser(p)
    page = browser.new_page(viewport={'width': 1600, 'height': 1000}, device_scale_factor=1)
    errors, checks, mutations = [], [], []
    def mutation_response(response):
        if response.request.method == 'POST' and '/api/papers' in response.url:
            try:
                result = response.json()
                mutations.append({'url': response.url, 'status': response.status, 'id': result.get('id'),
                                  'revision': result.get('revision'), 'error': result.get('error'), 'configuration': response.request.post_data_json if response.url.endswith('/method') else None, 'introMethod': result.get('modules', {}).get('introduction', {}).get('methodId')})
            except Exception:
                pass
    page.on('response', mutation_response)
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('dialog', lambda d: d.accept())
    assert page.request.get(BASE + '/api/workbench/status').json().get('dataScope') == 'test', 'Refusing to write test fixtures to a live server'
    page.goto(BASE, wait_until='networkidle')
    # Reconnaissance of the rendered page, before interaction.
    assert any('新建研究' in text for text in page.get_by_role('button').all_text_contents())
    page.get_by_role('button', name='新建研究', exact=True).click()
    dialog = page.get_by_role('dialog', name='研究材料设置')
    dialog.get_by_label('项目名称', exact=True).fill('QA Workbench - GUI integration fixture')
    dialog.get_by_label('Idea spark', exact=True).fill('Test module editing and asset interchange. This project has no experimental evidence.')
    dialog.get_by_role('button', name='载入演示材料').click()
    expect(dialog.get_by_text('experimental_log.md', exact=True)).to_be_visible()
    expect(dialog.get_by_text('idea.md', exact=True)).to_be_visible()
    expect(dialog.get_by_text('Synthetic demo · article', exact=True)).to_be_visible()
    assert dialog.locator('input[type=file]').count() == 3
    dialog.get_by_label('移除 experiment').click()
    dialog.get_by_role('button', name='保存研究项目').click()
    expect(dialog).not_to_be_visible()
    project_id = page.get_by_label('选择论文项目').input_value()
    expect(page).to_have_url(BASE + '/?project=' + project_id)
    def project():
        r = page.request.get(BASE + '/api/papers/' + project_id)
        assert r.ok, r.text()
        return r.json()
    def section(module_id):
        page.locator('[data-module="' + module_id + '"]').click()
        page.get_by_role('button', name='章节编辑', exact=True).click()
    def manual(text):
        page.get_by_label('当前模块内容', exact=True).fill(text)
        page.get_by_role('button', name='保存到主稿', exact=True).click()
        expect(page.get_by_role('button', name='保存到主稿', exact=True)).to_be_disabled()
    section('introduction')
    intro = '# Introduction\n\nHuman-authored baseline.\n\nInline math $p_t=(x,y_{<t})$ stays editable.'
    manual(intro)
    page.get_by_label('模块方法', exact=True).select_option('evidence-first')
    page.wait_for_function('(id)=>fetch("/api/papers/"+id).then(r=>r.json()).then(p=>p.modules.introduction.methodId==="evidence-first")', arg=project_id)
    expect(page.get_by_role('button', name='保存配置', exact=True)).to_be_enabled()
    page.reload(wait_until='networkidle')
    try:
        expect(page.get_by_label('模块方法', exact=True)).to_have_value('evidence-first')
    except AssertionError:
        debug = {'url': page.url, 'requestedProject': project_id, 'selector': page.get_by_label('选择论文项目').input_value(),
                 'module': page.locator('.pw-modules button.active').all_text_contents(), 'persistedMethod': project()['modules']['introduction']['methodId'],
                 'projectRevision': project()['revision'], 'mutations': mutations, 'localStorage': page.evaluate('Object.fromEntries(Object.entries(localStorage).filter(([k])=>k.startsWith("paper-workbench")))')}
        (QA / 'method-persistence-debug.json').write_text(json.dumps(debug, ensure_ascii=True), encoding='utf-8')
        print(json.dumps(debug, ensure_ascii=True))
        raise
    page.get_by_role('button', name='锁定模块', exact=True).click()
    expect(page.get_by_role('button', name='生成当前模块候选')).to_be_disabled()
    manual(intro + '\n\nManual edit while locked.')
    assert project()['modules']['introduction']['methodId'] == 'evidence-first'
    page.get_by_role('button', name='版本历史', exact=True).click()
    page.locator('.pw-version').filter(has_text='v1').get_by_role('button', name='恢复此版本').click()
    page.get_by_role('button', name='章节编辑', exact=True).click()
    expect(page.get_by_label('当前模块内容')).to_have_value(intro)
    page.get_by_role('button', name='解锁模块', exact=True).click()
    checks.extend(['source roles and GUI import', 'manual save', 'per-module method persistence', 'locks allow manual edits but block generation', 'version restore'])
    section('method')
    method = 'Human-authored method. This text must survive experiment and figure updates.'
    manual(method)
    section('experiments')
    page.get_by_role('button', name='生成当前模块候选', exact=True).click()
    expect(page.locator('.pw-candidate')).to_be_visible(timeout=30000)
    assert project()['modules']['experiments']['content'] == ''
    assert page.locator('.pw-diff .add').count() > 0
    previous_candidate = project()['candidates'][-1]
    page.get_by_role('button', name='编辑候选', exact=True).click()
    candidate_editor = page.get_by_role('dialog', name='编辑章节候选')
    amended = previous_candidate['content'] + '\n\n[TODO: Researcher-edited evidence requirement.]'
    candidate_editor.get_by_label('候选内容', exact=True).fill(amended)
    candidate_editor.get_by_role('button', name='保存候选', exact=True).click()
    expect(candidate_editor).not_to_be_visible()
    updated = project()
    assert updated['modules']['experiments']['content'] == ''
    assert updated['candidates'][-1]['content'] == amended
    assert updated['candidates'][-1]['runId'] == previous_candidate['runId']
    assert next(c for c in updated['candidates'] if c['id'] == previous_candidate['id'])['status'] == 'rejected'
    page.get_by_role('button', name='接受并替换此模块', exact=True).click()
    expect(page.locator('.pw-candidate')).not_to_be_visible(timeout=15000)
    page.wait_for_function('(id)=>fetch("/api/papers/"+id).then(r=>r.json()).then(p=>p.modules.experiments.revision===1)', arg=project_id)
    assert '[TODO' in project()['modules']['experiments']['content']
    assert project()['modules']['method']['content'] == method
    assert project()['modules']['introduction']['content'] == intro
    checks.extend(['candidate diff', 'editable candidate preserves batch and main manuscript', 'no auto-overwrite', 'idea-only experiment TODO', 'accept updates only selected module'])
    section('figures')
    page.get_by_role('button', name='矢量画板', exact=True).click()
    child = page.frame_locator('iframe')
    expect(child.get_by_role('button', name='打开项目', exact=True)).to_be_visible(timeout=20000)
    expect(child.get_by_text('idea.md', exact=True)).to_be_visible()
    def submit_vector(title, caption):
        child.get_by_role('button', name='打开项目', exact=True).click()
        # The native figure editor's import control accepts JSON and has no multiple attribute.
        child.locator('input[type=file][accept=".json"]').set_input_files({
            'name': 'qa-scene.json', 'mimeType': 'application/json', 'buffer': json.dumps(fixture(title)).encode('utf-8')})
        expect(child.get_by_role('button', name='提交到论文', exact=True)).to_be_enabled()
        child.get_by_role('button', name='提交到论文', exact=True).click()
        caption_dialog = page.get_by_role('dialog', name='提交图表候选')
        caption_dialog.get_by_label('图表图注').fill(caption)
        caption_dialog.get_by_role('button', name='提交候选', exact=True).click()
        expect(caption_dialog).not_to_be_visible()
        page.get_by_role('button', name='章节编辑', exact=True).click()
        expect(page.locator('.pw-candidate')).to_be_visible()
    submit_vector('First editable QA figure', 'QA caption v1. This is a test fixture, not a scientific figure.')
    assert not project()['modules']['figures']['assetIds']
    page.get_by_role('button', name='接受并替换此模块', exact=True).click()
    expect(page.locator('.pw-candidate')).not_to_be_visible(timeout=15000)
    page.wait_for_function('(id)=>fetch("/api/papers/"+id).then(r=>r.json()).then(p=>p.modules.figures.assetIds.length===1)', arg=project_id)
    first = project()['modules']['figures']['assetIds'][0]
    page.get_by_role('button', name='修改这张图的图注', exact=True).click()
    caption_dialog = page.get_by_role('dialog', name='提交图表候选')
    caption_dialog.get_by_label('图表图注').fill('Edited caption v2')
    caption_dialog.get_by_role('button', name='提交候选', exact=True).click()
    expect(caption_dialog).not_to_be_visible()
    page.get_by_role('button', name='接受并替换此模块', exact=True).click()
    expect(page.locator('.pw-candidate')).not_to_be_visible(timeout=15000)
    page.wait_for_function('(id)=>fetch("/api/papers/"+id).then(r=>r.json()).then(p=>p.modules.figures.revision===2)', arg=project_id)
    assert first != project()['modules']['figures']['assetIds'][0]
    assert len(project()['modules']['figures']['assetIds']) == 1
    page.get_by_role('button', name='矢量画板', exact=True).click()
    expect(child.get_by_role('button', name='打开项目', exact=True)).to_be_visible()
    page.get_by_label('选择画板中的图').select_option('new')
    submit_vector('Second editable QA figure', 'Second QA fixture.')
    page.get_by_role('button', name='接受并替换此模块', exact=True).click()
    expect(page.locator('.pw-candidate')).not_to_be_visible(timeout=15000)
    page.wait_for_function('(id)=>fetch("/api/papers/"+id).then(r=>r.json()).then(p=>p.modules.figures.assetIds.length===2)', arg=project_id)
    asset = project()['assets'][-1]
    svg = page.request.get(BASE + f'/api/papers/{project_id}/assets/{asset["id"]}.svg').text()
    assert '<text' in svg and '<image' not in svg
    assert project()['modules']['method']['content'] == method
    checks.extend(['iframe source handoff', 'vector scene submission', 'immutable figure revision', 'independent multi-figure updates', 'native SVG without bitmap', 'figures do not overwrite method'])
    page.get_by_role('button', name='全文预览', exact=True).click()
    expect(page.locator('.pw-pdf-sheet[data-page="1"][data-rendered="true"]')).to_be_visible(timeout=90000)
    expect(page.locator('.pw-pdf-text').first).to_contain_text('Human-authored baseline')
    assert not page.locator('article.pw-manuscript').count()
    page.screenshot(path=str(QA / 'workbench-preview.png'), full_page=True)
    section('references')
    page.get_by_role('button', name='手动登记文献', exact=True).click()
    citation = page.get_by_role('dialog', name='手动登记文献')
    citation.get_by_label('文献标题', exact=True).fill('QA bibliographic record (not a real publication)')
    citation.get_by_label('作者（逗号分隔）', exact=True).fill('QA Author')
    citation.get_by_label('年份', exact=True).fill('2026')
    citation.get_by_role('button', name='保存文献', exact=True).click()
    expect(citation).not_to_be_visible()
    assert project()['citations'][0]['verification'] == 'user-provided'
    key = project()['citations'][0]['key']
    page.get_by_role('button', name='修改文献信息', exact=True).click()
    citation.get_by_label('文献标题', exact=True).fill('Updated QA bibliographic record')
    citation.get_by_role('button', name='保存文献', exact=True).click()
    expect(citation).not_to_be_visible()
    assert project()['citations'][0]['key'] == key
    page.get_by_role('button', name='导出项目', exact=True).click()
    with page.expect_download() as download_info:
        page.get_by_role('button', name='可移植项目 · JSON', exact=True).click()
    exported_path = QA / 'workbench-project.json'
    download_info.value.save_as(str(exported_path))
    export = json.loads(exported_path.read_text(encoding='utf-8'))
    assert export['modules']['introduction']['content'] == intro
    assert len(export['modules']['figures']['assetIds']) == 2
    with page.expect_file_chooser() as chooser_info:
        page.get_by_role('button', name='导入项目', exact=True).click()
    chooser_info.value.set_files(str(exported_path))
    expect(page.get_by_label('选择论文项目')).not_to_have_value(project_id)
    imported_id = page.get_by_label('选择论文项目').input_value()
    imported = page.request.get(BASE + '/api/papers/' + imported_id).json()
    assert imported['modules']['method']['content'] == method
    assert len(imported['modules']['figures']['assetIds']) == 2
    assert imported['materials'] == export['materials']
    assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
    checks.extend(['math and figure preview', 'editable shared citation metadata', 'JSON export/import with editable assets', 'desktop layout no horizontal overflow'])
    assert not errors, errors
    report = {'passed': True, 'projectId': project_id, 'importedProjectId': imported_id, 'checks': checks,
              'runtimeErrors': errors, 'figureFixtures': 'Explicit synthetic interchange fixtures; no figure quality claim', 'modelCalls': 0}
    (QA / 'workbench-browser.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps(report))
    browser.close()
