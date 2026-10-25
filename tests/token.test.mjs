import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../server.mjs';

test('合法令牌可访问状态，错误或缺失令牌被拒绝', async () => {
  const app = await createServer({ port: 0 });
  try {
    const boot = await (await fetch(app.origin + '/api/bootstrap', { method: 'POST', headers: { Origin: app.origin } })).json();
    assert.match(boot.token, /^[0-9a-f]{64}$/);
    const state = token => fetch(app.origin + '/api/state', token === undefined ? {} : { headers: { 'X-Client-Token': token } });
    assert.equal((await state(boot.token)).status, 200);
    assert.equal((await fetch(app.origin + '/api/state?client=' + boot.token)).status, 200);
    assert.equal((await state()).status, 401);
    assert.equal((await state('')).status, 401);
    assert.equal((await state('0'.repeat(64))).status, 401);
    assert.equal((await state(boot.token.slice(0, -1))).status, 401);
    assert.equal((await state(boot.token + '0')).status, 401);
    const action = await fetch(app.origin + '/api/action', { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json', 'X-Client-Token': 'f'.repeat(64) }, body: '{"action":"disconnect"}' });
    assert.equal(action.status, 401);
  } finally { await app.close(); }
});
