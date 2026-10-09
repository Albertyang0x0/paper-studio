"""Read-only browser inspection of an already saved paper; no AI or content edits."""
import argparse
import json
import os
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

parser = argparse.ArgumentParser()
parser.add_argument('--url', required=True)
parser.add_argument('--screenshot', required=True)
parser.add_argument('--browser', help='Optional Chromium/Edge executable; defaults to Windows Edge or Playwright Chromium')
args = parser.parse_args()
with sync_playwright() as playwright:
    executable = args.browser or os.environ.get('PAPER_TEST_BROWSER')
    edge = Path(os.environ.get('PROGRAMFILES(X86)', r'C:\Program Files (x86)')) / 'Microsoft' / 'Edge' / 'Application' / 'msedge.exe'
    if not executable and sys.platform == 'win32' and edge.is_file():
        executable = str(edge)
    browser = playwright.chromium.launch(executable_path=executable, headless=True)
    page = browser.new_page(viewport={'width': 1600, 'height': 1000})
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(args.url, wait_until='networkidle')
    assert '全文预览' in page.get_by_role('button').all_text_contents()
    page.get_by_role('button', name='全文预览', exact=True).click()
    expect(page.locator('.pw-pdf-sheet[data-page="1"][data-rendered="true"]')).to_be_visible(timeout=90000)
    Path(args.screenshot).parent.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=args.screenshot)
    count = page.locator('.pw-pdf-sheet').count()
    for number in range(1, count + 1):
        sheet = page.locator(f'.pw-pdf-sheet[data-page="{number}"]')
        sheet.scroll_into_view_if_needed()
        expect(sheet).to_have_attribute('data-rendered', 'true', timeout=30000)
    assert not errors, errors
    print(json.dumps({'pages': count, 'revision': page.get_by_label('模板 PDF 预览').get_attribute('data-revision'),
        'pdfUrl': page.get_by_role('link', name='打开 PDF', exact=True).get_attribute('href'), 'runtimeErrors': errors}))
    browser.close()
