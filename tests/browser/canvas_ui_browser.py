"""Canvas layout and editing regressions, using only isolated fixtures and mocked runs."""
import json
import os
import uuid
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from browser_runtime import launch_browser

BASE = os.environ.get('PAPER_TEST_BASE_URL', 'http://localhost:8788')
QA = Path(os.environ['PAPER_TEST_ROOT']) / 'qa'
QA.mkdir(parents=True, exist_ok=True)
scene = {
    'schema': 'paper-atelier/1', 'id': str(uuid.uuid4()), 'title': 'Canvas UI fixture',
    'width': 800, 'height': 300, 'figureType': 'Method overview',
    'style': {'font': 'Arial', 'ink': '#222222', 'muted': '#666666', 'accent': '#333333',
              'palette': ['#eeeeee'], 'lineWidth': 1.5, 'bodySize': 22, 'titleSize': 26, 'illustrationStyle': 'QA fixture'},
    'regions': [], 'connectors': [], 'annotations': [],
    'materials': [{'id': 'qa-material', 'name': 'idea.md', 'content': 'Interchange fixture, not research evidence.'}],
    'review': {'status': 'needs-revision', 'summary': 'Fixture review', 'issues': [
        {'moduleId': 'qa-module', 'elementId': 'qa-text', 'severity': 'low', 'message': 'Fixture issue'}]},
    'modules': [{'id': 'qa-module', 'title': 'Editable fixture', 'role': 'structure', 'brief': 'Interchange test only',
                 'componentIds': [], 'labels': ['QA'], 'sourceRefs': [], 'x': 30, 'y': 40, 'width': 740, 'height': 210,
                 'ports': [], 'method': 'vector-agent', 'status': 'ready',
                 'elements': [{'id': 'qa-box', 'type': 'rect', 'x': 10, 'y': 10, 'width': 700, 'height': 180,
                               'radius': 12, 'fill': '#eeeeee', 'stroke': '#333333', 'strokeWidth': 2},
                              {'id': 'qa-text', 'type': 'text', 'x': 40, 'y': 75, 'width': 600,
                               'text': 'Editable vector label', 'fontSize': 24, 'fill': '#222222'}]}],
}

with sync_playwright() as p:
    browser = launch_browser(p)
    page = browser.new_page(viewport={'width': 1600, 'height': 1000}, accept_downloads=True)
    errors, posts = [], []
    page.on('pageerror', lambda error: errors.append(str(error)))
    assert page.request.get(BASE + '/api/workbench/status').json().get('dataScope') == 'test', 'Refusing live writes'
    created = page.request.post(BASE + '/api/papers', data={
        'title': 'QA canvas layout', 'ideaSpark': 'Canvas UI fixture only.', 'materials': [], 'language': 'en'})
    assert created.ok, created.text()
    project = created.json()
    status = page.request.get(BASE + '/api/status').json()
    page.route('**/api/status', lambda route: route.fulfill(json={**status, 'configured': True}))
    page.route('**/api/models', lambda route: route.fulfill(json={'models': []}))
    run_id = str(uuid.uuid4())

    def runs(route):
        if route.request.method == 'POST':
            posts.append(route.request.post_data_json)
            route.fulfill(status=202, json={'id': run_id})
        else:
            route.fulfill(json={'id': run_id, 'status': 'complete', 'events': [], 'scene': scene})

    # Every model-generation request is intercepted, including unexpected ones.
    page.route('**/api/runs**', runs)
    page.goto(BASE + '/?project=' + project['id'], wait_until='networkidle')
    page.locator('[data-module="figures"]').click()
    page.get_by_role('button', name='矢量画板', exact=True).click()
    child = page.frame_locator('iframe[title="论文矢量画板"]')
    expect(child.get_by_role('button', name='打开项目', exact=True)).to_be_visible()
    assert page.locator('iframe').bounding_box()['y'] <= 50, 'Duplicate paper chrome consumes canvas height'
    expect(page.locator('.pw-header')).not_to_be_visible()
    expect(child.locator('.topbar')).to_have_count(0)
    expect(child.locator('.inspector')).to_be_visible()
    expect(child.get_by_role('button', name='属性', exact=True)).to_have_attribute('aria-expanded', 'true')
    child.locator('input[type=file][accept=".json"]').set_input_files({
        'name': 'canvas-fixture.json', 'mimeType': 'application/json', 'buffer': json.dumps(scene).encode()})
    expect(child.locator('.panel-tabs .active')).to_have_text('图层')
    expect(child.get_by_role('button', name='Editable fixture', exact=True)).to_be_visible()
    expect(child.locator('.inspector')).to_be_visible()
    assert not posts, 'Opening/importing a figure must not generate anything'

    # The inspector stays pinned through selection/clearing and preserves a user's zoom.
    # Wait for animation frames so a delayed effect/ResizeObserver cannot hide a jump.
    def canvas_layout():
        return child.locator('.board-area').evaluate('''async board => {
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const b=board.getBoundingClientRect(),c=board.querySelector('canvas').getBoundingClientRect();
            return {board:[b.x,b.y,b.width,b.height],canvas:[c.x,c.y,c.width,c.height],
                    zoom:board.querySelector('.canvas-zoom span').textContent};
        }''')

    child.get_by_title('放大', exact=True).click()
    pinned_layout = canvas_layout()
    for _ in range(3):
        child.get_by_role('button', name='Editable fixture', exact=True).click()
        expect(child.locator('.inspector-header strong')).to_have_text('模块属性')
        assert canvas_layout() == pinned_layout, 'Module selection moved/rescaled the canvas'
        child.locator('.layer-elements button').filter(has_text='Editable vector label').click()
        expect(child.locator('.inspector-header strong')).to_have_text('对象属性')
        assert canvas_layout() == pinned_layout, 'Object selection moved/rescaled the canvas'
        child.locator('canvas.upper-canvas').click(position={'x': 10, 'y': 50})
        expect(child.locator('.inspector-header strong')).to_have_text('图表属性')
        expect(child.locator('.inspector')).to_be_visible()
        assert canvas_layout() == pinned_layout, 'Clearing selection moved/rescaled the canvas'

    # Loading from the paper workbench also leaves pane visibility unchanged.
    def load_from_paper():
        page.evaluate('''scene => document.querySelector('iframe').contentWindow.postMessage(
            {type:'paper-workbench:load-figure',scene,materials:scene.materials},location.origin)''', scene)

    child.get_by_role('button', name='Editable fixture', exact=True).click()
    expect(child.locator('.inspector-header strong')).to_have_text('模块属性')
    load_from_paper()
    expect(child.locator('.inspector-header strong')).to_have_text('图表属性')
    expect(child.locator('.inspector')).to_be_visible()
    assert canvas_layout() == pinned_layout, 'Paper figure load toggled the inspector'

    # Manual collapse is respected even after selecting/importing/loading a figure.
    child.get_by_role('button', name='关闭属性', exact=True).click()
    expect(child.locator('.inspector')).not_to_be_visible()
    collapsed_layout = canvas_layout()
    child.get_by_role('button', name='Editable fixture', exact=True).click()
    expect(child.locator('[data-layer-module].selected')).to_have_count(1)
    expect(child.locator('.inspector')).not_to_be_visible()
    assert canvas_layout() == collapsed_layout, 'Selection reopened a manually closed pane'
    child.locator('canvas.upper-canvas').click(position={'x': 10, 'y': 50})
    expect(child.locator('[data-layer-module].selected')).to_have_count(0)
    expect(child.locator('.inspector')).not_to_be_visible()
    assert canvas_layout() == collapsed_layout, 'Clearing selection changed a closed pane'
    child.locator('input[type=file][accept=".json"]').set_input_files({
        'name': 'canvas-fixture.json', 'mimeType': 'application/json', 'buffer': json.dumps(scene).encode()})
    expect(child.locator('.inspector')).not_to_be_visible()
    load_from_paper()
    expect(child.locator('.inspector')).not_to_be_visible()
    child.get_by_role('button', name='属性', exact=True).click()
    expect(child.locator('.inspector')).to_be_visible()

    # The review is collapsed by default; property editing and undo/redo still work.
    expect(child.locator('.review-card button').filter(has_text='Fixture issue')).not_to_be_visible()
    child.locator('.review-card summary').click()
    expect(child.locator('.review-card button').filter(has_text='Fixture issue')).to_be_visible()
    child.get_by_role('button', name='Editable fixture', exact=True).click()
    expect(child.locator('.inspector')).to_be_visible()
    expect(child.locator('.module-regeneration')).not_to_have_attribute('open', '')
    child.locator('.layer-elements button').filter(has_text='Editable vector label').click()
    expect(child.get_by_label('文字', exact=True)).to_have_value('Editable vector label')
    child.get_by_label('文字', exact=True).fill('Researcher-edited label')
    child.get_by_title('撤销 Ctrl+Z', exact=True).click()
    expect(child.get_by_label('文字', exact=True)).to_have_value('Editable vector label')
    child.get_by_title('重做 Ctrl+Shift+Z', exact=True).click()
    expect(child.get_by_label('文字', exact=True)).to_have_value('Researcher-edited label')
    child.get_by_role('button', name='关闭属性', exact=True).click()
    child.get_by_role('button', name='收起侧栏', exact=True).click()
    expect(child.locator('.left-panel')).not_to_be_visible()
    child.get_by_role('button', name='展开侧栏', exact=True).click()
    expect(child.locator('.left-panel')).to_be_visible()

    # Native modal keeps configuration separate from editing; Escape restores focus.
    child.get_by_role('button', name='生成图表', exact=True).click()
    dialog = child.get_by_role('dialog', name='生成图表', exact=True)
    expect(dialog).to_be_visible()
    expect(dialog.get_by_label('图类型', exact=True)).to_have_value('Method overview')
    dialog.get_by_label('图类型', exact=True).select_option('architecture')
    dialog.get_by_role('tab', name='方法与模型', exact=True).click()
    expect(dialog.get_by_label('生成流程', exact=True)).to_have_value('visual-reconstruction')
    expect(dialog.get_by_label('图片设计模型', exact=True)).to_have_value('google/gemini-3-pro-image')
    dialog.get_by_label('生成流程', exact=True).select_option('vector-design')
    expect(dialog.get_by_text('模块方法', exact=True)).to_be_visible()
    dialog.locator('.model-field input').first.fill('test/model-config')
    dialog.locator('select').filter(has=page.locator('option[value="diagram-agent"]')).first.select_option('diagram-agent')
    dialog.get_by_role('tab', name='图形与参考', exact=True).click()
    expect(dialog.get_by_label('图类型', exact=True)).to_have_value('architecture')
    page.screenshot(path=str(QA / 'canvas-generation-dialog.png'))
    page.keyboard.press('Escape')
    expect(dialog).not_to_be_visible()
    expect(child.get_by_role('button', name='生成图表', exact=True)).to_be_focused()
    assert not posts, 'Changing configuration must not start paid calls'

    # Export and responsive layout retain native vector objects and paper navigation.
    child.get_by_role('button', name='导出', exact=True).click()
    with page.expect_download() as downloading:
        child.get_by_role('menuitem', name='SVG 矢量图', exact=True).click()
    svg = Path(downloading.value.path()).read_text(encoding='utf-8')
    assert '<svg' in svg and 'Researcher-edited label' in svg and '<text' in svg
    for width in [1600, 1280, 900, 768]:
        page.set_viewport_size({'width': width, 'height': 1000})
        page.wait_for_function('document.documentElement.scrollWidth <= innerWidth')
        frame = page.locator('iframe').element_handle().content_frame()
        frame.wait_for_function('document.documentElement.scrollWidth <= innerWidth')
        board = child.locator('.board-area').bounding_box()
        assert board['height'] >= 870, board
        assert board['width'] >= width - 250, board
    page.set_viewport_size({'width': 1600, 'height': 1000})
    page.screenshot(path=str(QA / 'canvas-clean-layout.png'))
    expect(child.get_by_role('button', name='提交到论文', exact=True)).to_be_enabled()

    # Generation still works through explicit confirmation, with all method config retained.
    child.get_by_role('button', name='生成图表', exact=True).click()
    dialog.get_by_role('button', name='重新生成整图', exact=True).click()
    expect(dialog).not_to_be_visible()
    expect(child.locator('.panel-tabs .active')).to_have_text('图层')
    assert len(posts) == 1 and posts[0]['figureType'] == 'architecture'
    assert posts[0]['config']['planner'] == 'test/model-config'
    assert posts[0]['config']['methods']['illustration'] == 'diagram-agent'
    page.get_by_role('button', name='章节编辑', exact=True).click()
    expect(page.locator('.pw-header')).to_be_visible()
    assert not errors, errors
    browser.close()
    print(json.dumps({'passed': True, 'checks': ['one paper navigation row', 'canvas-first layout',
        'layers by default', 'pinned properties and stable canvas/zoom', 'manual pane controls respected',
        'editable text and undo/redo', 'collapsed review',
        'generation modal and focus', 'method configuration', 'SVG export', 'responsive layout',
        'explicit generation only', 'paper navigation restored'], 'modelCalls': 0}))
