import { join, resolve, relative, isAbsolute } from 'node:path';

/** A test server must never share the live paper, drawing, or usage store. */
export function storageConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()) {
  const liveRoot = resolve(cwd, 'outputs');
  const testing = env.PAPER_TEST_MODE === '1';
  const root = testing ? resolve(cwd, env.PAPER_TEST_ROOT ?? 'outputs/test') : liveRoot;
  if (testing) {
    const inside = (parent: string, child: string) => {
      const part = relative(parent, child);
      return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')));
    };
    if (inside(root, liveRoot) || ['papers', 'runs', 'usage', 'qa'].some(name => inside(join(liveRoot, name), root))) {
      throw Error('Test storage must be separate from live outputs and its paper/drawing stores.');
    }
  }
  return { testing, root, scope: testing ? 'test' : 'live' } as const;
}

export function outputPath(...parts: string[]) {
  return join(storageConfig().root, ...parts);
}

export function assertProjectScope(title: string) {
  if (!storageConfig().testing && /^QA(?:\s|$)/i.test(title.trim())) {
    throw Error('测试项目只能在独立测试服务中创建，请运行 npm run test:ui。');
  }
}
