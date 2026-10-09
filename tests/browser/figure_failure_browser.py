"""Failure and same-run resume UI fixtures. All generation requests are mocked.
Only a disposable project on the isolated test server is created; zero model calls.
"""
import json
import os
import uuid
from playwright.sync_api import sync_playwright, expect
from browser_runtime import launch_browser

BASE = os.environ.get('PAPER_TEST_BASE_URL', 'http://localhost:8788')

with sync_playwright() as p:
    browser = launch_browser(p)
    page = browser.new_page(viewport={'width': 1600, 'height': 1000})
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    status = page.request.get(BASE + '/api/workbench/status').json()
    assert status.get('dataScope') == 'test', 'Refusing live test writes'
    created = page.request.post(BASE + '/api/papers', data={
        'title': 'QA figure failure and resume', 'ideaSpark': 'UI failure fixture, not a generated paper.',
        'materials': [], 'language': 'en'})
    assert created.ok, created.text()
    project = created.json()
    run = {'id': str(uuid.uuid4()), 'projectId': project['id'], 'baseProjectRevision': project['revision'],
           'mode': 'draft', 'status': 'partial', 'createdAt': '2026-10-05T13:39:06.742Z',
           'candidateIds': [], 'events': [], 'moduleFailures': [
               {'moduleId': 'figures', 'message': '方法图排版未完成，已保存的正文不受影响。'}]}
    state = {'resumed': False, 'polls': 0, 'posts': []}

    def history(route):
        route.fulfill(json={'runs': [run]})

    def progress(route):
        if route.request.method == 'POST':
            request = route.request.post_data_json
            state['posts'].append(request)
            assert request['resumeRunId'] == run['id']
            assert request['mode'] == 'draft'
            state['resumed'] = True
            run['status'] = 'running'
        elif state['resumed']:
            state['polls'] += 1
            if state['polls'] >= 2:
                run['status'] = 'complete'
                run['moduleFailures'] = []
        route.fulfill(json=run, status=202 if route.request.method == 'POST' else 200)

    # No request from the generation controls can reach the real model adapter.
    page.route('**/api/paper-runs**', progress)
    page.route(BASE + '/api/papers/' + project['id'] + '/runs', history)
    page.route('**/api/workbench/status', lambda route: route.fulfill(json={**status, 'configured': True}))
    page.goto(BASE + '/?project=' + project['id'], wait_until='networkidle')
    expect(page.get_by_text('正文已生成 · 绘图待重试', exact=True)).to_be_visible()
    expect(page.get_by_role('button', name='重试未完成模块', exact=True)).to_be_visible()
    expect(page.get_by_text('图表与画板：方法图排版未完成，已保存的正文不受影响。', exact=True)).to_be_visible()
    page.get_by_role('button', name='重试未完成模块', exact=True).click()
    expect(page.get_by_text('执行完成 · 待确认', exact=True)).to_be_visible(timeout=15000)
    assert state['polls'] >= 2, 'Resuming the same run ID must restart polling'
    assert len(state['posts']) == 1
    expect(page.get_by_role('button', name='重试未完成模块', exact=True)).not_to_be_visible()

    # Legacy runs get a useful message without altering their stored metadata.
    state['resumed'] = False
    run['status'] = 'error'
    run['error'] = 'mod_diagnosis: Error: Label text_model does not fit container text_model_container'
    page.reload(wait_until='networkidle')
    expect(page.get_by_role('button', name='从已保存的候选继续', exact=True)).to_be_visible()
    assert '方法图的文字框空间不足' in page.locator('body').inner_text()
    assert 'text_model_container' not in page.locator('body').inner_text()
    assert not errors, errors
    browser.close()
    print(json.dumps({'passed': True, 'checks': ['partial status', 'separate figure failure',
        'retry request', 'same-run polling restarts', 'legacy error translation'], 'modelCalls': 0}))
