import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { storageConfig, assertProjectScope } from '../../server/storage';

test('live storage retains existing paper and drawing locations', () => {
  const config = storageConfig({}, process.cwd());
  assert.equal(config.root, resolve('outputs'));
  assert.equal(config.scope, 'live');
});

test('test storage defaults to a separate output namespace', () => {
  const config = storageConfig({ PAPER_TEST_MODE: '1' }, process.cwd());
  assert.equal(config.root, resolve('outputs/test'));
  assert.equal(config.scope, 'test');
});

test('test storage rejects live roots, ancestor roots, and existing artifact stores', () => {
  for (const root of ['outputs', '.', 'outputs/papers', 'outputs/papers/some-id', 'outputs/runs', 'outputs/qa', 'outputs/usage']) {
    assert.throws(() => storageConfig({ PAPER_TEST_MODE: '1', PAPER_TEST_ROOT: root }), /separate/);
  }
  assert.equal(storageConfig({ PAPER_TEST_MODE: '1', PAPER_TEST_ROOT: join('outputs', 'test', 'one-run') }).scope, 'test');
});

test('QA fixture creation is blocked on the live store', () => {
  assert.throws(() => assertProjectScope('QA Workbench - GUI integration fixture'), /独立测试/);
  assertProjectScope('Self-Agent: actual research');
});
