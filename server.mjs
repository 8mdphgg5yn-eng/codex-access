import http from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { Session, BUSY } from './lib/session.mjs';
import { cleanError } from './lib/codex.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/editor.mjs', ['editor.mjs', 'text/javascript; charset=utf-8']],
]);

export async function createServer({ port = 8782, sessionFactory = options => new Session(options) } = {}) {
  const workspace = await realpath(path.join(root, 'workspace'));
  const clients = new Map(); let origin; let closing = false;
  const server = http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    const json = (status, value) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(value)); };
    try {
      if (request.headers.host !== new URL(origin).host) return json(403, { error: '请通过本机 127.0.0.1 地址打开。' });
      if (request.headers.origin && request.headers.origin !== origin) return json(403, { error: '不接受其他网页发起的请求。' });
      const url = new URL(request.url, origin);
      if (request.method === 'GET' && url.pathname === '/health') return json(200, { app: 'codex-access-prototype', version: '0.1.0-alpha.1' });
      if (request.method === 'GET' && files.has(url.pathname)) {
        const [name, type] = files.get(url.pathname);
        response.writeHead(200, { 'Content-Type': type }); response.end(await readFile(path.join(root, 'public', name))); return;
      }
      if (request.method === 'POST' && request.headers.origin !== origin) return json(403, { error: '缺少当前页面来源。' });
      if (request.method === 'POST' && url.pathname === '/api/bootstrap') {
        if (clients.size >= 6) return json(429, { error: '打开的原型页面太多，请关闭旧页面后稍等。' });
        const token = randomBytes(32).toString('hex');
        const session = sessionFactory({ workspace });
        clients.set(token, { session, stream: null, lastUse: Date.now(), disconnectTimer: null, cleanupTimer: null });
        return json(200, { token, workspace, state: session.snapshot(), testedCodexVersion: '0.160.0' });
      }
      const token = String(request.headers['x-client-token'] || url.searchParams.get('client') || '');
      const entry = clients.get(token);
      if (!entry) return json(401, { error: '页面连接已失效，请刷新；草稿可先复制保存。' });
      entry.lastUse = Date.now();
      if (request.method === 'GET' && url.pathname === '/api/events') {
        if (entry.stream) return json(409, { error: '该页面已有状态连接。' });
        clearTimeout(entry.disconnectTimer);
        clearTimeout(entry.cleanupTimer);
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive' });
        response.flushHeaders(); entry.stream = response;
        const update = state => response.write(`data: ${JSON.stringify(state)}\n\n`);
        update(entry.session.snapshot()); entry.session.on('change', update);
        const heartbeat = setInterval(() => response.write(': alive\n\n'), 15000);
        response.on('close', () => {
          clearInterval(heartbeat); entry.session.off('change', update); entry.stream = null;
          if (closing) return;
          entry.disconnectTimer = setTimeout(() => {
            // A closed/reloaded page must not leave an unattended controller running.
            void entry.session.stop();
            entry.cleanupTimer = setTimeout(() => { entry.session.dispose(); clients.delete(token); }, 12000);
            entry.cleanupTimer.unref();
          }, 12000); entry.disconnectTimer.unref();
        }); return;
      }
      if (request.method === 'GET' && url.pathname === '/api/state') return json(200, entry.session.snapshot());
      if (request.method !== 'POST' || url.pathname !== '/api/action') return json(404, { error: '未找到此接口。' });
      if (!String(request.headers['content-type'] || '').startsWith('application/json')) return json(415, { error: '请求格式无效。' });
      const body = await readBody(request);
      const session = entry.session;
      switch (body.action) {
        case 'cancelPreview': session.tickets.clear(); return json(200, { canceled: true });
        case 'prepare': return json(200, session.prepare(body.prompt, body.mode));
        case 'send': {
          // Synchronous validation/phase transition happens before send's first await.
          if (BUSY.has(session.state.phase) || !session.tickets.has(body.ticket)) return json(409, { error: '发送确认已失效或已有任务在执行。' });
          void session.send(body.ticket).catch(error => session.failure(cleanError(error.message)));
          return json(202, { accepted: true, state: session.snapshot() });
        }
        case 'connect': await session.connect(); return json(200, session.snapshot());
        case 'decision': session.decide(body.id, body.decision); return json(200, { accepted: true, state: session.snapshot() });
        case 'stop': void session.stop(); return json(202, { requested: true });
        case 'disconnect': session.disconnect(); return json(200, session.snapshot());
        default: return json(400, { error: '未知操作。' });
      }
    } catch (error) { if (!response.headersSent) json(400, { error: cleanError(error.message) }); else response.end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  const expiry = setInterval(() => {
    for (const [token, entry] of clients) if (!entry.stream && Date.now() - entry.lastUse > 300_000) {
      clearTimeout(entry.disconnectTimer); entry.session.dispose(); clients.delete(token);
    }
  }, 60000); expiry.unref();
  const close = async () => {
    closing = true;
    clearInterval(expiry);
    for (const entry of clients.values()) { clearTimeout(entry.disconnectTimer); clearTimeout(entry.cleanupTimer); entry.session.dispose(); entry.stream?.end(); }
    clients.clear(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  };
  return { server, origin, workspace, close };
}

async function readBody(request) {
  let size = 0; const chunks = [];
  for await (const chunk of request) { size += chunk.length; if (size > 60000) throw new Error('请求过大。'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new Error('请求不是有效 JSON。'); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const port = Number(process.env.CODEX_ACCESS_PORT || 8782);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('端口应为 1024 至 65535。');
    const app = await createServer({ port });
    console.log(`开控本机原型：${app.origin}\n默认练习模式。按 Ctrl+C 关闭服务。`);
    let closing = false;
    const stop = async () => { if (closing) return; closing = true; await app.close(); process.exit(0); };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
  } catch (error) { console.error(error.code === 'EADDRINUSE' ? '端口已被占用。可设置 CODEX_ACCESS_PORT 后重试。' : cleanError(error.message)); process.exitCode = 1; }
}
