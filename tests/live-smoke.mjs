// Explicit opt-in. Sends one self-authored marker to the user's logged-in Codex.
import { Session } from '../lib/session.mjs';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
if (!process.argv.includes('--run')) { console.log('需显式 --run；会调用本机已登录的 Codex。'); process.exit(0); }
const session = new Session({ workspace: fileURLToPath(new URL('../workspace', import.meta.url)) });
const report = { time: new Date().toISOString(), kind: 'live-codex-self-authored-marker', accountRead: false,
  prompt: '这是无障碍原型连通性测试。不要调用工具，不要读取文件，不要联网查询，不要修改任何文件。只回复 CODEX_ACCESS_OK。',
  nativeApprovalsObserved: 0, result: '', phase: '', error: '' };
let done;
const ending = new Promise(resolve => { done = resolve; });
const deadline = setTimeout(() => { report.error = '90秒内未完成'; done(); }, 90000);
session.on('change', state => {
  report.accountRead ||= state.connected;
  if (state.approvals.length) { report.nativeApprovalsObserved++; session.decide(state.approvals[0].id, 'decline'); }
  if (['completed', 'failed', 'interrupted'].includes(state.phase)) done();
});
try {
  const preview = session.prepare(report.prompt, 'codex');
  await session.send(preview.ticket); await ending;
  report.result = session.state.output; report.phase = session.state.phase; report.error ||= session.state.error;
  report.model = session.state.model;
} catch (error) { report.error = error.message; }
finally { clearTimeout(deadline); session.dispose(); }
report.passed = report.phase === 'completed' && report.result.trim() === 'CODEX_ACCESS_OK';
await writeFile(new URL('../evidence/live-smoke.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.passed ? 0 : 1;
