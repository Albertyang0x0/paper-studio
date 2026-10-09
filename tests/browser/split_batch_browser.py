"""Exercise real split-batch commits on an isolated store. Zero model calls."""
import json
import os
import uuid
from playwright.sync_api import sync_playwright, expect
from browser_runtime import launch_browser

BASE = os.environ.get('PAPER_TEST_BASE_URL', 'http://localhost:8788')
DEPENDENCIES = {
    'outline': [], 'references': ['outline'],
    'introduction': ['outline', 'method', 'references'],
    'related_work': ['outline', 'references'], 'method': ['outline'],
    'experiments': ['outline', 'method'], 'abstract': ['introduction', 'method', 'experiments'],
    'conclusion': ['method', 'experiments'], 'figures': ['method', 'experiments'],
}

with sync_playwright() as p:
    browser = launch_browser(p)
    page = browser.new_page(viewport={'width': 1600, 'height': 1000})
    errors = []
    generation = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.on('request', lambda request: generation.append(request.url)
            if request.method == 'POST' and '/api/paper-runs' in request.url else None)
    assert page.request.get(BASE + '/api/workbench/status').json().get('dataScope') == 'test'

    def post(path, body):
        result = page.request.post(BASE + path, data=body)
        assert result.ok, result.text()
        return result.json()

    seed = post('/api/papers', {'title': 'QA split batch acceptance', 'ideaSpark': 'Interchange fixture only.',
                              'materials': [], 'language': 'en'})
    run = str(uuid.uuid4())
    candidates = {}
    for ident, module in seed['modules'].items():
        candidate = {'id': str(uuid.uuid4()), 'moduleId': ident, 'runId': run,
                     'baseRevision': 0, 'sourceRevision': 0,
                     'dependencyVersions': {dep: 0 for dep in DEPENDENCIES[ident]},
                     'methodId': module['methodId'], 'model': 'test-no-api',
                     'content': 'Synthetic ' + ident + ' content.', 'warnings': [],
                     'status': 'pending', 'createdAt': '2026-10-05T13:39:06.742Z'}
        candidates[ident] = candidate
        seed['candidates'].append(candidate)
    imported = post('/api/papers/import', {'project': seed})
    ident = imported['id']
    for module in ['introduction', 'outline']:
        post('/api/papers/' + ident + '/candidates/accept', {'ids': [candidates[module]['id']]})

    page.goto(BASE + '/?project=' + ident, wait_until='networkidle')
    expect(page.get_by_text('7 个候选待确认', exact=True)).to_be_visible()
    button = page.get_by_role('button', name='接受整批候选', exact=True)
    expect(button).to_be_enabled()
    with page.expect_response(lambda response: response.url.endswith('/candidates/accept')) as committed:
        button.click()
    assert committed.value.ok, committed.value.text()
    expect(button).not_to_be_visible()
    saved = page.request.get(BASE + '/api/papers/' + ident).json()
    assert all(c['status'] == 'accepted' for c in saved['candidates'])
    assert all(m['revision'] == 1 and not m['needsSync'] for m in saved['modules'].values())
    assert saved['modules']['introduction']['content'] == candidates['introduction']['content']
    assert saved['modules']['outline']['content'] == candidates['outline']['content']
    assert not errors, errors
    assert not generation, generation
    browser.close()
    print(json.dumps({'passed': True, 'checks': ['individual intro acceptance', 'individual outline acceptance',
        'remaining seven accepted via GUI', 'already accepted modules preserved', 'no false sync flags'], 'modelCalls': 0}))
