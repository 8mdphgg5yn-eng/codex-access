// Explicit, bounded live checks: one fixed print command and one 20-second sleep.
import { Session } from '../lib/session.mjs';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
if (!process.argv.includes('--run')) { console.log('需显式 --run；会向已登录 Codex 发送两项自制测试任务。'); process.exit(0); }
const workspace = fileURLToPath(new URL('../workspace', import.meta.url));
const allowedCommands = new Set([`python3 -c "print('CODEX_ACCESS_APPROVAL_OK')"`, `python3 -c 'print("CODEX_ACCESS_APPROVAL_OK")'`]);
for (const command of [...allowedCommands]) allowedCommands.add('/bin/zsh -lc ' + JSON.stringify(command));
const report = { time: new Date().toISOString(), kind: 'live-bounded-control-checks', checks: [] };
for (const kind of (process.argv.includes('--approval-only') ? ['approval'] : ['approval', 'stop'])) {
  const session = new Session({ workspace });
  const check = { kind, approvals: 0, commandsRequested: [], allowedFixedPrint: false, rejectedUnexpectedRequest: false, commandStarted: false, phase: '', output: '', error: '' };
  let done; const completion = new Promise(resolve => { done = resolve; });
  const deadline = setTimeout(() => { check.error = '60秒内未完成'; done(); }, 60000);
  const stoppingTimers = [];
  session.on('change', state => {
    const approval = state.approvals[0];
    if (approval && !check.lastApprovalId?.includes(approval.id)) {
      check.lastApprovalId = [...(check.lastApprovalId || []), approval.id]; check.approvals++;
      check.commandsRequested.push(approval.command);
      const allowed = kind === 'approval' && approval.kind === 'command' && allowedCommands.has(approval.command.trim());
      check.allowedFixedPrint ||= allowed; check.rejectedUnexpectedRequest ||= !allowed;
      session.decide(approval.id, allowed ? 'accept' : 'decline');
    }
    if (kind === 'stop' && !check.commandStarted && state.trace.some(entry => entry.text === 'Codex 开始一个命令步骤。')) {
      check.commandStarted = true;
      stoppingTimers.push(setTimeout(() => { void session.stop(); }, 500));
    }
    if (['completed', 'failed', 'interrupted'].includes(state.phase)) done();
  });
  try {
    const prompt = kind === 'approval'
      ? `这是自制的原型人工授权测试。只执行一次命令 python3 -c "print('CODEX_ACCESS_APPROVAL_OK')"。请在 exec_command 调用中设置 sandbox_permissions="require_escalated"，通过人工授权界面请求仅本次运行，justification 写“原型固定打印授权测试”。不要添加 prefix_rule 或更改规则。不要读写文件，不联网，不启动其他工具或代理。若授权拒绝就停止，不绕过。完成后仅回复该标记。`
      : '这是自制的任务中断测试。只用 exec_command 执行 sleep 20，不读取或修改文件，不联网，不启动其他工具或代理。不要申请提升权限。等待命令完成后只回复 SLEEP_FINISHED。';
    await session.send(session.prepare(prompt, 'codex').ticket); await completion;
    check.phase = session.state.phase; check.output = session.state.output; check.error ||= session.state.error;
    check.passed = kind === 'approval' ? check.allowedFixedPrint && check.phase === 'completed' && check.output.includes('CODEX_ACCESS_APPROVAL_OK')
      : check.commandStarted && check.phase === 'interrupted';
  } catch (error) { check.error = error.message; check.passed = false; }
  finally { clearTimeout(deadline); stoppingTimers.forEach(clearTimeout); session.dispose(); }
  delete check.lastApprovalId; report.checks.push(check);
}
await writeFile(new URL(process.argv.includes('--approval-only') ? '../evidence/live-approval.json' : '../evidence/live-control.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2)); process.exitCode = report.checks.every(check => check.passed) ? 0 : 1;
