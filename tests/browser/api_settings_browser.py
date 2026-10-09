"""Global API configuration in an isolated store. Fake credentials, no provider/model calls."""
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from browser_runtime import launch_browser

BASE = os.environ.get('PAPER_TEST_BASE_URL', 'http://localhost:8788')
ROOT = Path(os.environ['PAPER_TEST_ROOT'])
KEY = 'sk-or-v1-' + 'gui-fixture-only'.replace('-', '') * 4
OTHER = 'sk-or-v1-' + 'replacement-only'.replace('-', '') * 4

with sync_playwright() as p:
    browser = launch_browser(p)
    context = browser.new_context(viewport={'width': 1600, 'height': 1000})
    page = context.new_page()
    errors, model_calls, connection_calls = [], [], []
    context.on('page', lambda opened: opened.on('pageerror', lambda error: errors.append(str(error))))
    page.on('pageerror', lambda error: errors.append(str(error)))
    status = page.request.get(BASE + '/api/workbench/status').json()
    assert status.get('dataScope') == 'test', 'Refusing live credential changes'
    baseline = page.request.get(BASE + '/api/settings').json()
    project = page.request.post(BASE + '/api/papers', data={
        'title': 'QA API configuration', 'ideaSpark': 'Isolated GUI setting trial.', 'materials': [], 'language': 'en'}).json()
    original_project = page.request.get(BASE + '/api/papers/' + project['id']).json()
    page.route('**/api/workbench/status', lambda route: route.fulfill(json={**status, 'configured': False}))
    figure_status = page.request.get(BASE + '/api/status').json()
    page.route('**/api/status', lambda route: route.fulfill(json={**figure_status, 'configured': False}))
    context.route('**/api/models', lambda route: route.fulfill(json={'models': []}))

    def forbidden_model(route):
        model_calls.append(route.request.url)
        route.fulfill(status=500, json={'error': 'No model calls in API settings regression'})
    context.route('**/api/runs**', forbidden_model)
    context.route('**/api/paper-runs**', forbidden_model)

    def test_connection(route):
        connection_calls.append(route.request.post_data_json)
        if len(connection_calls) == 1:
            route.fulfill(json={'ok': True, 'message': '已连接 OpenRouter。', 'limitRemaining': 4.25})
        else:
            route.fulfill(status=401, json={'error': 'API key 无效或已失效。'})
    context.route('**/api/settings/test', test_connection)

    page.goto(BASE + '/?project=' + project['id'], wait_until='networkidle')
    assert 'API 设置' in page.get_by_role('button').all_text_contents(), 'Missing discoverable global entry'
    expect(page.locator('.pw-connection')).to_have_text('API 未配置')
    page.get_by_role('button', name='API 设置', exact=True).click()
    dialog = page.get_by_role('dialog', name='API 设置', exact=True)
    expect(dialog).to_be_visible()
    field = dialog.get_by_label('API key', exact=True)
    expect(field).to_have_value('')
    expect(field).to_have_attribute('type', 'password')
    field.fill(KEY)
    dialog.get_by_role('button', name='显示 API key', exact=True).click()
    expect(field).to_have_attribute('type', 'text')
    dialog.get_by_role('button', name='隐藏 API key', exact=True).click()
    dialog.get_by_role('button', name='测试连接', exact=True).click()
    expect(dialog.get_by_role('status')).to_contain_text('$4.25')
    assert page.request.get(BASE + '/api/settings').json() == baseline, 'Testing must not save a key'
    dialog.get_by_role('button', name='保存配置', exact=True).click()
    expect(dialog.get_by_role('status')).to_contain_text('已保存')
    expect(field).to_have_value('')
    expect(page.locator('.pw-connection')).to_have_text('模型 API 已配置')
    saved = page.request.get(BASE + '/api/settings').json()
    assert saved['source'] == 'saved' and saved['configured'] and KEY not in json.dumps(saved)
    assert json.loads((ROOT / 'api-settings.json').read_text(encoding='utf-8'))['connections'][0]['apiKey'] == KEY
    assert KEY not in page.evaluate('JSON.stringify(localStorage) + JSON.stringify(sessionStorage)')
    page.keyboard.press('Escape')
    expect(dialog).not_to_be_visible()
    expect(page.get_by_role('button', name='API 设置', exact=True)).to_be_focused()

    # Another tab and the iframe must update without navigation or reloading the scene.
    second = context.new_page()
    second.route('**/api/workbench/status', lambda route: route.fulfill(json={**status, 'configured': False}))
    second.goto(BASE + '/?project=' + project['id'], wait_until='networkidle')
    expect(second.locator('.pw-connection')).to_have_text('API 未配置')
    page.locator('[data-module="figures"]').click()
    page.get_by_role('button', name='矢量画板', exact=True).click()
    child = page.frame_locator('iframe[title="论文矢量画板"]')
    child.get_by_role('button', name='生成图表', exact=True).first.click()
    generation = child.get_by_role('dialog', name='生成图表', exact=True)
    expect(generation.locator('.generation-status')).to_contain_text('API 未配置')
    page.keyboard.press('Escape')
    child.get_by_role('button', name='API 设置', exact=True).click()
    settings = child.get_by_role('dialog', name='API 设置', exact=True)
    expect(settings.get_by_label('API key', exact=True)).to_have_value('')
    settings.get_by_label('API key', exact=True).fill(OTHER)
    settings.get_by_role('button', name='保存配置', exact=True).click()
    expect(settings.get_by_role('status')).to_contain_text('已保存')
    expect(second.locator('.pw-connection')).to_have_text('模型 API 已配置')
    page.keyboard.press('Escape')
    child.get_by_role('button', name='生成图表', exact=True).first.click()
    expect(generation.locator('.generation-status')).to_contain_text('API 已配置')
    expect(generation.get_by_role('alert')).to_have_count(0)
    page.keyboard.press('Escape')
    assert not model_calls, model_calls

    # Failure/validation leave the saved configuration intact; dismissed keys are discarded.
    child.get_by_role('button', name='API 设置', exact=True).click()
    settings.get_by_label('API key', exact=True).fill(KEY)
    settings.get_by_role('button', name='测试连接', exact=True).click()
    expect(settings.get_by_role('alert')).to_contain_text('无效')
    assert page.request.get(BASE + '/api/settings').json()['keyHint'].endswith(OTHER[-4:])
    settings.get_by_label('API key', exact=True).fill('invalid-fixture')
    settings.get_by_role('button', name='保存配置', exact=True).click()
    expect(settings.get_by_role('alert')).to_contain_text('有效')
    assert json.loads((ROOT / 'api-settings.json').read_text(encoding='utf-8'))['connections'][0]['apiKey'] == OTHER
    page.keyboard.press('Escape')
    child.get_by_role('button', name='API 设置', exact=True).click()
    expect(settings.get_by_label('API key', exact=True)).to_have_value('')
    page.keyboard.press('Escape')
    page.get_by_role('button', name='章节编辑', exact=True).click()
    page.unroute('**/api/workbench/status')
    page.reload(wait_until='networkidle')
    expect(page.locator('.pw-connection')).to_have_text('模型 API 已配置')
    for width in [1600, 768]:
        page.set_viewport_size({'width': width, 'height': 1000})
        page.get_by_role('button', name='API 设置', exact=True).click()
        expect(dialog.get_by_label('API key', exact=True)).to_have_value('')
        expect(dialog.get_by_label('接口协议', exact=True)).to_have_value('openrouter')
        assert dialog.bounding_box()['width'] <= width - 30
        page.wait_for_function('document.documentElement.scrollWidth <= innerWidth')
        page.keyboard.press('Escape')
    assert original_project == page.request.get(BASE + '/api/papers/' + project['id']).json(), 'API settings changed a manuscript'
    assert KEY not in page.evaluate('JSON.stringify(localStorage) + JSON.stringify(sessionStorage)')
    assert OTHER not in page.evaluate('JSON.stringify(localStorage) + JSON.stringify(sessionStorage)')
    standalone = context.new_page()
    standalone.goto(BASE + '/figure', wait_until='networkidle')
    standalone.get_by_role('button', name='API 设置', exact=True).click()
    expect(standalone.get_by_role('dialog', name='API 设置', exact=True)).to_be_visible()
    expect(standalone.get_by_label('API key', exact=True)).to_have_value('')
    assert not errors and not model_calls, {'errors': errors, 'modelCalls': model_calls}
    assert len(connection_calls) == 2
    browser.close()
    print(json.dumps({'passed': True, 'checks': ['global setting entry', 'password input', 'non-saving connection test',
        'immediate server persistence', 'masked responses', 'no browser secret storage', 'iframe and cross-tab sync',
        'failed saves preserve current key', 'dismissed credentials cleared', 'refresh persistence',
        'responsive settings dialog', 'standalone canvas entry', 'manuscript unchanged'], 'modelCalls': 0, 'providerCalls': 0}))
