"""Portable headless browser selection; no dependency on a developer's home path."""
import os
import sys
from pathlib import Path


def launch_browser(playwright):
    specified = os.environ.get('PAPER_TEST_BROWSER')
    if specified:
        if not Path(specified).is_file():
            raise RuntimeError('PAPER_TEST_BROWSER must point to an installed browser executable')
        return playwright.chromium.launch(executable_path=specified, headless=True)
    if sys.platform == 'win32':
        edge = Path(os.environ.get('PROGRAMFILES(X86)', r'C:\Program Files (x86)')) / 'Microsoft' / 'Edge' / 'Application' / 'msedge.exe'
        if edge.is_file():
            return playwright.chromium.launch(executable_path=str(edge), headless=True)
    return playwright.chromium.launch(headless=True)
