"""Multi-provider UI and real server routing against a local mock API; no paid calls."""
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from browser_runtime import launch_browser

BASE = os.environ.get('PAPER_TEST_BASE_URL', 'http://localhost:8788')
ROOT = Path(os.environ['PAPER_TEST_ROOT'])
calls = []
KEY_A, KEY_B, KEY_G = 'provider-A-fixture-secret', 'provider-B-fixture-secret', 'gemini-fixture-secret'

class Provider(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def respond(self, value):
        body = json.dumps(value).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        calls.append({'path': self.path, 'authorization': self.headers.get('Authorization'), 'method': 'GET'})
        self.respond({'data': [{'id': 'same-model-id', 'name': 'Local mock model'}]})

    def do_POST(self):
        data = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        calls.append({'path': self.path, 'authorization': self.headers.get('Authorization'), 'method': 'POST', 'body': data})
        label = 'A' if '/first/' in self.path else 'B'
        output = {'content': 'Isolated mock provider ' + label + ' section. No scientific result is claimed.', 'warnings': []}
        self.respond({'model': data['model'], 'choices': [{'message': {'content': json.dumps(output)}, 'finish_reason': 'stop'}], 'usage': {'prompt_tokens': 3, 'completion_tokens': 4}})

provider = ThreadingHTTPServer(('127.0.0.1', 0), Provider)
thread = threading.Thread(target=provider.serve_forever, daemon=True)
thread.start()
upstream = 'http://127.0.0.1:' + str(provider.server_port)

try:
    with sync_playwright() as p:
        browser = launch_browser(p)
        page = browser.new_page(viewport={'width': 1600, 'height': 1000})
        errors, captured_figures = [], []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.on('dialog', lambda dialog: dialog.accept())
        assert page.request.get(BASE + '/api/workbench/status').json().get('dataScope') == 'test', 'Refusing live changes'
        created = page.request.post(BASE + '/api/papers', data={
            'title': 'QA provider routing', 'ideaSpark': 'Synthetic input for API routing only, not research evidence.', 'materials': [], 'language': 'en'})
        assert created.ok, created.text()
        project_id = created.json()['id']
        page.route('**/api/models**', lambda route: route.fulfill(json={'models': []}))
        page.goto(BASE + '/?project=' + project_id, wait_until='networkidle')
        assert page.get_by_role('button', name='API 设置', exact=True).is_visible()
        page.get_by_role('button', name='API 设置', exact=True).click()
        settings = page.get_by_role('dialog', name='API 设置', exact=True)

        def add(name, protocol, base, key, image_model=''):
            settings.get_by_role('button', name='新增连接', exact=True).click()
            settings.get_by_label('接口协议', exact=True).select_option(protocol)
            settings.get_by_label('连接名称', exact=True).fill(name)
            settings.get_by_label('Base URL', exact=True).fill(base)
            settings.get_by_label('API key', exact=True).fill(key)
            settings.get_by_label('默认文本模型', exact=True).fill('same-model-id')
            if protocol != 'anthropic':
                settings.get_by_label('默认图片模型', exact=True).fill(image_model)
            settings.get_by_role('button', name='保存配置', exact=True).click()
            expect(settings.get_by_role('status')).to_contain_text('已保存')
            expect(settings.get_by_label('API key', exact=True)).to_have_value('')
            return next(c for c in page.request.get(BASE + '/api/settings').json()['connections'] if c['name'] == name)['id']

        first = add('Local provider A', 'openai-compatible', upstream + '/first/v1', KEY_A)
        settings.get_by_role('button', name='测试连接', exact=True).click()
        expect(settings.get_by_role('status')).to_contain_text('读取到 1 个模型')
        second = add('Local provider B', 'openai-compatible', upstream + '/second/v1', KEY_B)
        gemini = add('Gemini artwork', 'gemini', upstream + '/gemini/v1beta', KEY_G, 'mock-image-model')
        settings.get_by_label('默认文本连接', exact=True).select_option(first)
        settings.get_by_label('默认图片连接', exact=True).select_option(gemini)
        settings.get_by_role('button', name='保存默认连接', exact=True).click()
        expect(settings.get_by_role('status')).to_contain_text('默认连接')
        # A changed address must not reuse a key; restoring it allows metadata-only save.
        settings.get_by_label('选择 API 连接', exact=True).select_option(first)
        settings.get_by_label('Base URL', exact=True).fill(upstream + '/different/v1')
        expect(settings.get_by_role('button', name='保存配置', exact=True)).to_be_disabled()
        expect(settings.get_by_label('API key', exact=True)).to_have_value('')
        page.keyboard.press('Escape')

        def project():
            return page.request.get(BASE + '/api/papers/' + project_id).json()

        def configure(module, connection):
            page.locator('[data-module="' + module + '"]').click()
            page.get_by_role('button', name='章节编辑', exact=True).click()
            page.get_by_label('模块方法', exact=True).select_option('orchestra-section')
            page.get_by_label('模块 API 连接', exact=True).select_option(connection)
            expect(page.get_by_label('写作模型', exact=True)).to_have_value('same-model-id')
            page.get_by_role('button', name='保存配置', exact=True).click()
            page.wait_for_function('args => fetch("/api/papers/"+args.id).then(r=>r.json()).then(p=>p.modules[args.module].connectionId===args.connection)',
                                   arg={'id': project_id, 'module': module, 'connection': connection})

        def generate(module):
            page.get_by_role('button', name='生成当前模块候选', exact=True).click()
            page.wait_for_function('args => fetch("/api/papers/"+args.id).then(r=>r.json()).then(p=>p.candidates.some(c=>c.moduleId===args.module))',
                                   arg={'id': project_id, 'module': module})
            expect(page.get_by_role('button', name='生成当前模块候选', exact=True)).to_be_enabled(timeout=20000)

        configure('introduction', first)
        generate('introduction')
        configure('method', second)
        generate('method')
        current = project()
        assert current['modules']['introduction']['content'] == '' and current['modules']['method']['content'] == '', 'Candidates must not overwrite the manuscript'
        assert 'provider A' in next(c for c in current['candidates'] if c['moduleId'] == 'introduction')['content']
        assert 'provider B' in next(c for c in current['candidates'] if c['moduleId'] == 'method')['content']
        posts = [c for c in calls if c['method'] == 'POST']
        assert len(posts) == 2
        assert posts[0]['path'] == '/first/v1/chat/completions' and posts[0]['authorization'] == 'Bearer ' + KEY_A
        assert posts[1]['path'] == '/second/v1/chat/completions' and posts[1]['authorization'] == 'Bearer ' + KEY_B
        assert all('reasoning' not in c['body'] and 'image_config' not in c['body'] for c in posts)
        page.reload(wait_until='networkidle')
        page.locator('[data-module="method"]').click()
        expect(page.get_by_label('模块 API 连接', exact=True)).to_have_value(second)

        # Capture the canvas request instead of performing any image generation.
        def figures(route):
            if route.request.method == 'POST':
                captured_figures.append(route.request.post_data_json)
                route.fulfill(status=202, json={'id': '00000000-0000-4000-8000-000000000099'})
            else:
                route.fulfill(json={'id': '00000000-0000-4000-8000-000000000099', 'status': 'error', 'error': 'Isolated request capture', 'events': []})
        page.route('**/api/runs**', figures)
        page.locator('[data-module="figures"]').click()
        page.get_by_role('button', name='矢量画板', exact=True).click()
        child = page.frame_locator('iframe[title="论文矢量画板"]')
        child.get_by_role('button', name='生成图表', exact=True).first.click()
        generation = child.get_by_role('dialog', name='生成图表', exact=True)
        generation.get_by_role('tab', name='方法与模型', exact=True).click()
        generation.get_by_label('科学内容分析 API 连接', exact=True).select_option(first)
        generation.get_by_label('视觉设计总监 API 连接', exact=True).select_option(second)
        generation.get_by_label('图片设计 API 连接', exact=True).select_option(gemini)
        expect(generation.get_by_label('图片设计模型', exact=True)).to_have_value('mock-image-model')
        expect(generation.get_by_role('button', name='Gemma 经济版', exact=True)).to_be_disabled()
        generation.get_by_role('button', name='质量优先', exact=True).click()
        expect(generation.get_by_label('科学内容分析 API 连接', exact=True)).to_have_value(first)
        expect(generation.get_by_label('视觉设计总监 API 连接', exact=True)).to_have_value(second)
        expect(generation.get_by_label('图片设计模型', exact=True)).to_have_value('mock-image-model')
        generation.get_by_role('button', name='使用连接默认模型', exact=True).click()
        expect(generation.get_by_label('科学内容分析模型 ID', exact=True)).to_have_value('same-model-id')
        generation.get_by_role('button', name='开始生成', exact=True).click()
        page.wait_for_function('true')
        assert len(captured_figures) == 1
        config = captured_figures[0]['config']
        assert config['connections']['planner'] == first and config['connections']['director'] == second and config['connections']['image'] == gemini
        assert config['planner'] == config['director'] == 'same-model-id'
        page.get_by_role('button', name='章节编辑', exact=True).click()

        # Removing a bound connection leaves its manuscript and candidates intact.
        page.locator('[data-module="method"]').click()
        page.get_by_role('button', name='API 设置', exact=True).click()
        settings.get_by_label('选择 API 连接', exact=True).select_option(second)
        settings.get_by_role('button', name='删除连接', exact=True).click()
        expect(settings.get_by_role('status')).to_contain_text('已删除')
        page.keyboard.press('Escape')
        expect(page.get_by_label('模块 API 连接', exact=True)).to_have_value(second)
        expect(page.get_by_label('模块 API 连接', exact=True).locator('option:checked')).to_contain_text('已移除')
        assert project() == current
        exported = page.request.get(BASE + '/api/papers/' + project_id + '/export/json').text()
        storage = page.evaluate('JSON.stringify(localStorage)+JSON.stringify(sessionStorage)')
        status_json = page.request.get(BASE + '/api/settings').text()
        for key in [KEY_A, KEY_B, KEY_G]:
            assert key not in exported and key not in storage and key not in status_json
        assert not errors, errors
        browser.close()
        print(json.dumps({'passed': True, 'checks': ['multi-connection CRUD', 'default text/image routing', 'custom key formats',
            'no key reuse after URL change', 'module binding persistence', 'actual server uses separate URLs/keys',
            'provider-neutral request fields', 'per-stage canvas bindings', 'presets retain selected connections', 'deleted connections visible',
            'candidates preserved', 'no credentials in exports/browser'], 'localMockGenerationCalls': 2, 'paidModelCalls': 0}))
finally:
    provider.shutdown()
    provider.server_close()
    thread.join(timeout=5)
