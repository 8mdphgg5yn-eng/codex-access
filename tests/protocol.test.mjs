import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { Session } from '../lib/session.mjs';
import { CodexClient, CODEX_ARGS } from '../lib/codex.mjs';
import { Draft, replaceFirst, deleteLastSentence } from '../public/editor.mjs';

const fixture = fileURLToPath(new URL('./fixture-codex.mjs', import.meta.url));
const workspace = fileURLToPath(new URL('../workspace', import.meta.url));
function makeSession(unsafe = false) {
  return new Session({ workspace, practiceDelay: 5, clientFactory: opts => new CodexClient({ ...opts,
    spawnFn: (_bin, args, options) => {
      assert.deepEqual(args, CODEX_ARGS);
      return spawn(process.execPath, [fixture], { ...options, env: { ...options.env, ...(unsafe ? { FIXTURE_UNSAFE: '1' } : {}) } });
    } }) });
}
async function until(session, predicate) {
  if (predicate(session.state)) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { session.off('change', changed); reject(new Error(`timeout: ${session.state.phase}`)); }, 2500);
    function changed(state) { if (predicate(state)) { clearTimeout(timer); session.off('change', changed); resolve(); } }
    session.on('change', changed);
  });
}
async function run(session, text, mode = 'codex') { const preview = session.prepare(text, mode); await session.send(preview.ticket); }

test('纠错只替换首处，删除与清空均可撤销', () => {
  const draft = new Draft(); draft.update('第一句。测试标题，测试标题。');
  const next = replaceFirst(draft.text, '测试标题', '今天的计划');
  assert.equal(next.count, 2); draft.update(next.text);
  assert.equal(draft.text, '第一句。今天的计划，测试标题。');
  draft.update(deleteLastSentence(draft.text)); assert.equal(draft.text, '第一句。');
  draft.undo(); assert.equal(draft.text, next.text); draft.update(''); draft.undo(); assert.equal(draft.text, next.text);
  assert.throws(() => replaceFirst('原文', '不存在', '替换'));
});
test('发送确认是一次性的，不能重复发送或修改其已绑定内容', async () => {
  const session = makeSession();
  try {
    const preview = session.prepare('原始草稿', 'practice'); await session.send(preview.ticket);
    assert.equal(session.state.prompt, '原始草稿');
    await assert.rejects(session.send(preview.ticket));
    assert.throws(() => session.prepare('另一份', 'practice'));
  } finally { session.dispose(); }
});
test('练习拒绝及停止后，迟到计时器不能改成已完成', async () => {
  const session = makeSession();
  try {
    await run(session, '练习', 'practice'); const old = session.state.approvals[0].id;
    session.decide(old, 'decline'); assert.equal(session.state.phase, 'completed');
    assert.throws(() => session.decide(old, 'accept'));
    await run(session, '练习2', 'practice'); session.decide(session.state.approvals[0].id, 'accept');
    await session.stop(); await new Promise(resolve => setTimeout(resolve, 65));
    assert.equal(session.state.phase, 'interrupted'); assert.equal(session.state.output, '');
  } finally { session.dispose(); }
});
for (const decision of ['accept', 'decline']) test(`JSONL 原生授权 ${decision} 只答复当前请求`, async () => {
  const session = makeSession();
  try {
    await run(session, 'APPROVAL'); await until(session, state => state.approvals.length === 1);
    const approval = session.state.approvals[0]; assert.match(approval.details, /echo fixture/);
    assert.throws(() => session.decide('stale-id', 'accept'));
    session.decide(approval.id, decision); assert.throws(() => session.decide(approval.id, decision));
    await until(session, state => state.phase === 'completed'); assert.equal(session.state.output, `fixture ${decision}`);
  } finally { session.dispose(); }
});
test('JSONL 中断需完成回执；回执后拒收迟到结果', async () => {
  const session = makeSession();
  try {
    await run(session, 'WAIT'); assert.equal(session.state.phase, 'running');
    const phases = []; session.on('change', state => phases.push(state.phase));
    await session.stop(); await until(session, state => state.phase === 'interrupted');
    assert.ok(phases.includes('stopping')); assert.equal(session.state.output, '');
    await run(session, 'NEXT'); await until(session, state => state.phase === 'completed');
    assert.equal(session.state.output, 'fixture result');
  } finally { session.dispose(); }
});
test('JSONL 文件授权展示路径与差异，允许后只答复本次', async () => {
  const session = makeSession();
  try {
    await run(session, 'FILE'); await until(session, state => state.approvals.length === 1);
    const approval = session.state.approvals[0];
    assert.equal(approval.kind, 'file'); assert.match(approval.details, /sample\.txt/); assert.match(approval.details, /-old\n\+new/);
    session.decide(approval.id, 'accept'); await until(session, state => state.phase === 'completed');
    assert.equal(session.state.output, 'fixture accept');
  } finally { session.dispose(); }
});
test('服务端未采用目录沙箱时，不发送模型任务', async () => {
  const session = makeSession(true);
  try { await run(session, '禁止发送'); assert.equal(session.state.phase, 'failed'); assert.match(session.state.error, /没有采用/); assert.equal(session.turnDispatched, false); }
  finally { session.dispose(); }
});
test('准备连接期间停止，恢复连接后不补发任务', async () => {
  let release; const connecting = new Promise(resolve => { release = resolve; });
  class Delayed extends EventEmitter { async connect() { await connecting; } close() {} request() { throw new Error('must not dispatch'); } }
  const session = new Session({ workspace, clientFactory: () => new Delayed() });
  try {
    const ticket = session.prepare('不得补发', 'codex').ticket;
    const sending = session.send(ticket); await session.stop();
    assert.equal(session.state.phase, 'stopping'); release(); await sending;
    assert.equal(session.state.phase, 'interrupted'); assert.equal(session.turnDispatched, false);
  } finally { session.dispose(); }
});
