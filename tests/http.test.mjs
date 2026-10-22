import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer } from '../server.mjs';
test('本机接口拒绝跨来源、无凭证、目录穿越和已撤回确认', async () => {
  const app = await createServer({ port: 0 });
  try {
    assert.equal((await fetch(app.origin + '/api/bootstrap', { method: 'POST', headers: { Origin: 'https://example.org' } })).status, 403);
    assert.equal((await fetch(app.origin + '/api/state')).status, 401);
    const boot = await (await fetch(app.origin + '/api/bootstrap', { method: 'POST', headers: { Origin: app.origin } })).json();
    const headers = { Origin: app.origin, 'Content-Type': 'application/json', 'X-Client-Token': boot.token };
    const action = async body => fetch(app.origin + '/api/action', { method: 'POST', headers, body: JSON.stringify(body) });
    const preview = await (await action({ action: 'prepare', prompt: '练习', mode: 'practice' })).json();
    assert.equal((await action({ action: 'cancelPreview' })).status, 200);
    assert.equal((await action({ action: 'send', ticket: preview.ticket })).status, 409);
    for (const route of ['/server.mjs', '/workspace/sample.txt', '/..%2fserver.mjs', '/.env']) assert.equal((await fetch(app.origin + route, { headers: { 'X-Client-Token': boot.token } })).status, 404);
    const html = await (await fetch(app.origin)).text(); assert.match(html, /lang="zh-CN"/);
    const wrongHostStatus = await new Promise((resolve, reject) => {
      const request = http.get(app.origin, { headers: { Host: 'malicious.example' } }, response => { response.resume(); resolve(response.statusCode); });
      request.on('error', reject);
    });
    assert.equal(wrongHostStatus, 403);
  } finally { await app.close(); }
});
