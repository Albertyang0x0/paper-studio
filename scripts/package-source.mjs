import { readdir, readFile, lstat, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parse } from 'dotenv';
import { zipSync, unzipSync } from 'fflate';

const roots = new Set(['src', 'server', 'shared', 'tests', 'docs', 'scripts', 'vendor', 'public', 'examples', '.github']);
const rootFiles = new Set(['package.json', 'package-lock.json', 'index.html', 'tsconfig.json', 'vite.config.ts', 'README.md',
  'CONTRIBUTING.md', 'LICENSE', 'LICENSE.md', '.gitignore', '.gitattributes', '.node-version', '.env.example']);
const privateFiles = new Set(['docs/VALIDATION.md', 'docs/WORKBENCH_VALIDATION.md', 'scripts/iterate-visual.ts']);
const privateDirectories = new Set(['.git', '.local', 'outputs', 'archives', 'node_modules', 'dist', 'releases', 'test-artifacts', '__pycache__', '.idea']);
const textExtension = /\.(?:ts|tsx|mts|mjs|css|md|json|py|yml|yaml|html|tex|sty|txt)$/i;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const run = promisify(execFile);

export function isPrivatePath(path) {
  const normalized = path.replaceAll('\\', '/');
  const parts = normalized.split('/');
  return parts.some(part => privateDirectories.has(part) || /^\.env(?:\.|$)/.test(part) && normalized !== '.env.example')
    || privateFiles.has(normalized) || /\.(?:pyc|pyo|log|tmp|pem|key)$/i.test(normalized)
    || /^public\/references\/.*\.(?:png|jpe?g|webp)$/i.test(normalized);
}
export function isSourcePath(path) {
  const normalized = path.replaceAll('\\', '/');
  if (normalized.startsWith('/') || normalized.split('/').some(part => !part || part === '.' || part === '..') || isPrivatePath(normalized)) return false;
  if (!normalized.includes('/')) return rootFiles.has(normalized);
  return roots.has(normalized.split('/')[0]) && (textExtension.test(normalized) || /(?:^|\/)LICENSE$/.test(normalized));
}
export async function collectSourceFiles(root) {
  const files = [];
  async function visit(path) {
    const info = await lstat(join(root, path));
    if (info.isSymbolicLink()) throw Error(`拒绝打包符号链接：${path}`);
    if (info.isDirectory()) {
      if (isPrivatePath(path)) return;
      for (const entry of (await readdir(join(root, path))).sort()) await visit(path + '/' + entry);
    } else if (info.isFile() && isSourcePath(path)) {
      if (info.size > 5_000_000) throw Error(`源码文件过大，需要人工确认：${path}`);
      const bytes = await readFile(join(root, path));
      if (!Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes)) throw Error(`源码包只接受 UTF-8 文本：${path}`);
      files.push({ path, bytes });
    }
  }
  for (const entry of (await readdir(root)).sort()) {
    if (rootFiles.has(entry) || roots.has(entry)) await visit(entry);
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
export function scanForCredentials(files, knownSecrets = []) {
  const patterns = [
    /\bsk-or-v1-[a-f\d]{64}\b/i,
    /\bsk-(?:proj-|ant-)[A-Za-z\d_-]{30,}/,
    /\bsk-[A-Za-z\d]{48,}\b/,
    /\bAIza[A-Za-z\d_-]{35}\b/,
    /\bgh[pousr]_[A-Za-z\d]{30,}\b/,
    /\bgithub_pat_[A-Za-z\d_]{40,}/,
    /\bAKIA[A-Z\d]{16}\b/,
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  ];
  const secrets = knownSecrets.filter(secret => typeof secret === 'string' && secret.trim().length >= 8);
  const unsafe = files.filter(file => {
    const text = file.bytes.toString('utf8');
    return patterns.some(pattern => pattern.test(text)) || secrets.some(secret => text.includes(secret));
  });
  if (unsafe.length) throw Error(`凭据检查失败，仅显示文件名（不显示密钥）：${unsafe.map(file => file.path).join(', ')}`);
}
async function knownLocalSecrets(root) {
  const secrets = [];
  const add = (key, value) => { if (/key|token|secret|password/i.test(key) && typeof value === 'string' && value.trim().length >= 8) secrets.push(value.trim()); };
  for (const [key, value] of Object.entries(process.env)) add(key, value);
  for (const name of ['.env', '.env.local']) {
    try { for (const [key, value] of Object.entries(parse(await readFile(join(root, name))))) add(key, value); }
    catch (error) { if (error.code !== 'ENOENT') throw Error(`无法完成本机凭据检查：${name}`); }
  }
  try {
    const data = JSON.parse(await readFile(join(root, '.local', 'api-settings.json'), 'utf8'));
    if (typeof data.apiKey === 'string') add('apiKey', data.apiKey);
    for (const connection of data.connections ?? []) add('apiKey', connection.apiKey);
  } catch (error) { if (error.code !== 'ENOENT') throw Error('本机 API 设置不可读取，拒绝跳过凭据检查。'); }
  return [...new Set(secrets)];
}
async function checkTrackedFiles(root) {
  try {
    const { stdout: top } = await run('git', ['rev-parse', '--show-toplevel'], { cwd: root, windowsHide: true });
    if (resolve(top.trim()) !== resolve(root)) return;
    const { stdout } = await run('git', ['ls-files', '-z'], { cwd: root, windowsHide: true, maxBuffer: 4_000_000 });
    const unsafe = stdout.split('\0').filter(path => path && isPrivatePath(path));
    if (unsafe.length) throw Error(`Git 已跟踪不应发布的文件，请先从索引移除：${unsafe.join(', ')}`);
  } catch (error) { if (error.message.startsWith('Git 已跟踪')) throw error; if (error.code !== 128 && error.code !== 'ENOENT') throw Error('无法检查 Git 跟踪文件。'); }
}
async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('Usage: npm run package:source -- [--check] [--name NAME] [--stage]\nCreates a credential-checked source ZIP in releases/. --stage also creates a clean source folder. Existing targets are never overwritten.');
    return;
  }
  let name = 'paper-studio-source-' + new Date().toISOString().toLowerCase().replaceAll(':', '-').replaceAll('.', '-');
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--name') name = args[++index];
    else if (!['--stage', '--check'].includes(args[index])) throw Error('未知打包参数，请使用 --help。');
  }
  if (typeof name !== 'string' || !/^[a-z\d][a-z\d_.-]{2,95}$/.test(name)) throw Error('包名只能包含小写字母、数字、点、横线和下划线。');
  const files = await collectSourceFiles(root);
  for (const required of ['package.json', 'package-lock.json', 'README.md', '.gitignore', 'server/index.ts', 'src/main.tsx', 'vendor/paper-orchestra/LICENSE', 'examples/demo/inputs/idea.md'])
    if (!files.some(file => file.path === required)) throw Error(`源码包缺少必要文件：${required}`);
  scanForCredentials(files, await knownLocalSecrets(root));
  await checkTrackedFiles(root);
  if (args.includes('--check')) {
    console.log(JSON.stringify({ passed: true, sourceFiles: files.length, credentialsDetected: false, privateDataExcluded: true }));
    return;
  }
  const packageInfo = JSON.parse(files.find(file => file.path === 'package.json').bytes.toString('utf8'));
  const manifest = { schema: 'paper-studio-source/1', name: packageInfo.name, version: packageInfo.version,
    createdAt: new Date().toISOString(), sourceFiles: files.length,
    excluded: ['credentials and local settings', 'paper projects and research records', 'outputs and archives', 'dependencies and builds', 'unlicensed reference images'],
    files: files.map(file => ({ path: file.path, bytes: file.bytes.length, sha256: hash(file.bytes) })) };
  const entries = Object.fromEntries(files.map(file => ['paper-studio/' + file.path, file.bytes]));
  entries['paper-studio/PACKAGE_MANIFEST.json'] = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  const zip = zipSync(entries, { level: 9 }), verified = unzipSync(zip);
  if (Object.keys(verified).length !== files.length + 1 || files.some(file => hash(verified['paper-studio/' + file.path]) !== hash(file.bytes))) throw Error('ZIP 还原校验失败。');
  const destination = join(root, 'releases'), archive = join(destination, name + '.zip');
  const stage = args.includes('--stage') ? join(destination, name, 'paper-studio') : undefined;
  await mkdir(destination, { recursive: true });
  for (const path of [archive, archive + '.manifest.json', stage].filter(Boolean)) {
    try { await lstat(path); throw Error(`目标已存在，不会覆盖：${relative(root, path)}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await writeFile(archive, zip, { flag: 'wx' });
  if (stage) {
    await mkdir(stage, { recursive: true });
    for (const [entry, bytes] of Object.entries(verified)) {
      const path = resolve(stage, entry.slice('paper-studio/'.length)), part = relative(stage, path);
      if (!part || isAbsolute(part) || part.startsWith('..')) throw Error('非法解压目标。');
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes, { flag: 'wx' });
    }
  }
  const receipt = { ...manifest, archive: name + '.zip', archiveBytes: zip.length, archiveSha256: hash(zip),
    stagedFolder: stage ? relative(root, stage).replaceAll('\\', '/') : undefined };
  await writeFile(archive + '.manifest.json', JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ archive, stagedFolder: stage, sourceFiles: files.length, archiveBytes: zip.length, archiveSha256: receipt.archiveSha256, credentialsDetected: false }));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
