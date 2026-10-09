import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);

export async function configureNetwork() {
  let proxy = process.env.PAPER_PROXY_URL ?? process.env.HTTPS_PROXY ?? process.env.https_proxy
    ?? process.env.HTTP_PROXY ?? process.env.http_proxy;
  let mode = proxy ? 'environment-proxy' : 'direct';
  if (!proxy && process.platform === 'win32' && process.env.PAPER_SYSTEM_PROXY !== '0') {
    try {
      const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
      const [enabled, server] = await Promise.all(['ProxyEnable', 'ProxyServer'].map(name =>
        run('reg.exe', ['query', key, '/v', name], { windowsHide: true, timeout: 3000 })));
      if (/ProxyEnable\s+REG_DWORD\s+0x1\b/.test(enabled.stdout)) {
        const setting = /ProxyServer\s+REG_SZ\s+(.+)/.exec(server.stdout)?.[1].trim();
        const address = setting?.includes('=') ? /(?:^|;)https=([^;]+)/.exec(setting)?.[1] : setting;
        // Auto-discovery is restricted to the local VPN/proxy configured by the user.
        if (address && /^(?:http:\/\/)?(?:127\.0\.0\.1|localhost):\d+$/.test(address)) {
          proxy = address.startsWith('http://') ? address : `http://${address}`;
          mode = 'system-proxy';
        }
      }
    } catch { /* Registry access is optional on non-desktop deployments. */ }
  }
  if (!proxy) return { mode };
  if (typeof http.setGlobalProxyFromEnv !== 'function') throw Error('代理接入需要 Node.js 24.14 或更高版本。');
  const url = new URL(proxy);
  if (!['http:', 'https:'].includes(url.protocol)) throw Error('PAPER_PROXY_URL 需要 HTTP(S) 代理地址。');
  http.setGlobalProxyFromEnv({ HTTP_PROXY: proxy, HTTPS_PROXY: proxy,
    NO_PROXY: ['localhost', '127.0.0.1', '::1', process.env.NO_PROXY ?? ''].join(',') });
  return { mode, proxyHost: url.host };
}
