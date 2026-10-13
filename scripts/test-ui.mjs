// Runs GUI regressions on their own server and removes their temporary data.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const cwd = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (process.argv.includes('--help')) {
  console.log('Usage: npm run test:ui [-- --svg-only | --svg-compat-only | --svg-scientific-only | --close-only | --canvas-navigation-only | --manual-grouping-only]\nRuns GUI tests on port 8788 with isolated temporary storage and automatic cleanup.\n--svg-only runs direct SVG import/edit/export; --svg-compat-only checks all SVG samples, fidelity, assets, and effects; --svg-scientific-only checks scientific styles, units, text spacing, static conversion, and input safety; --close-only runs close-project checks; --canvas-navigation-only checks keyboard viewport navigation; --manual-grouping-only checks reviewed box selection and manual grouping.\nOptional: PAPER_TEST_PYTHON specifies a Python executable with Playwright; PAPER_TEST_NODE_MODULES specifies a node_modules directory containing Node Playwright; PAPER_TEST_SVG_COMPAT_FILES selects compatibility samples; PAPER_TEST_SVG_CORPUS_DIR selects an additional SVG corpus.');
  process.exit(0);
}
const temporaryParent = resolve(tmpdir());
const root = await mkdtemp(join(temporaryParent, 'paper-studio-ui-'));
const base = 'http://localhost:8788';
const env = { ...process.env, PORT: '8788', PAPER_TEST_MODE: '1', PAPER_TEST_ROOT: root, PAPER_TEST_BASE_URL: base,
  OPENROUTER_API_KEY: 'sk-or-v1-' + 'isolated-ui-fixture-only'.repeat(3), SEMANTIC_SCHOLAR_API_KEY: '' };
let server, serverDone;
const command = (program, args) => new Promise((done, fail) => {
  const child = spawn(program, args, { cwd, env, stdio: 'inherit', windowsHide: true });
  child.once('error', fail);
  child.once('exit', code => code === 0 ? done() : fail(Error(`${args[0]} exited with ${code}`)));
});
try {
  try {
    await fetch(base + '/api/status', { signal: AbortSignal.timeout(1000) });
    throw Error('Port 8788 is occupied; the GUI tests will not reuse an existing server.');
  } catch (error) {
    if (error.message?.includes('occupied')) throw error;
  }
  server = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { cwd, env, stdio: 'inherit', windowsHide: true });
  serverDone = new Promise(done => server.once('exit', done));
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (server.exitCode !== null || server.signalCode !== null) throw Error('Isolated test server exited during startup');
    const status = await fetch(base + '/api/status', { signal: AbortSignal.timeout(1000) }).then(r => r.json()).catch(() => undefined);
    if (status?.dataScope === 'test') { ready = true; break; }
    await delay(300);
  }
  if (!ready) throw Error('Isolated test server did not become ready');
  console.log('GUI tests are isolated from the live system; no paid model calls.');
  const svgOnly = process.argv.includes('--svg-only'), compatibilityOnly = process.argv.includes('--svg-compat-only'), scientificOnly = process.argv.includes('--svg-scientific-only'), closeOnly = process.argv.includes('--close-only'), navigationOnly = process.argv.includes('--canvas-navigation-only'), groupingOnly = process.argv.includes('--manual-grouping-only');
  if (!closeOnly && !compatibilityOnly && !scientificOnly && !navigationOnly && !groupingOnly) await command(process.execPath, ['tests/browser/svg_import_browser.mjs']);
  if (!svgOnly && !closeOnly && !scientificOnly && !navigationOnly && !groupingOnly) await command(process.execPath, ['tests/browser/svg_compatibility_browser.mjs']);
  if (!svgOnly && !closeOnly && !compatibilityOnly && !navigationOnly && !groupingOnly) await command(process.execPath, ['tests/browser/svg_scientific_browser.mjs']);
  if (!svgOnly && !compatibilityOnly && !scientificOnly && !navigationOnly && !groupingOnly) await command(process.execPath, ['tests/browser/close_project_browser.mjs']);
  if (!svgOnly && !compatibilityOnly && !scientificOnly && !closeOnly && !groupingOnly) await command(process.execPath, ['tests/browser/canvas_navigation_browser.mjs']);
  if (!svgOnly && !compatibilityOnly && !scientificOnly && !closeOnly && !navigationOnly) await command(process.execPath, ['tests/browser/manual_grouping_browser.mjs']);
  if (!svgOnly && !compatibilityOnly && !scientificOnly && !closeOnly && !navigationOnly && !groupingOnly) {
    const python = process.env.PAPER_TEST_PYTHON ?? 'python';
    await command(python, ['tests/browser/workbench_browser.py']);
    await command(python, ['tests/browser/split_batch_browser.py']);
    await command(python, ['tests/browser/figure_failure_browser.py']);
    await command(python, ['tests/browser/canvas_ui_browser.py']);
    await command(python, ['tests/browser/reconstruction_edit_browser.py']);
    if (process.env.PAPER_TEST_SKIP_PDF === '1') console.log('Explicitly skipping TWO PDF/template GUI suites; PDF compilation was not verified.');
    else {
      await command(python, ['tests/browser/minimal_ui_browser.py']);
      await command(python, ['tests/browser/pdf_preview_browser.py']);
    }
    await command(process.execPath, ['--import', 'tsx', 'tests/browser/pending_figure_edit.ts']);
    await command(python, ['tests/browser/api_settings_browser.py']);
    await command(python, ['tests/browser/provider_connections_browser.py']);
  }
  server.kill();
  await serverDone;
  console.log('GUI regression checks passed.');
} finally {
  if (server && server.exitCode === null && server.signalCode === null) {
    server.kill();
  }
  if (serverDone) await serverDone;
  // Only the exact mkdtemp directory owned by this run can be removed.
  if (dirname(resolve(root)) !== temporaryParent || !root.startsWith(join(temporaryParent, 'paper-studio-ui-'))) {
    throw Error('Refusing cleanup outside this test run\'s temporary directory');
  }
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  console.log('Temporary test projects and outputs removed.');
}
