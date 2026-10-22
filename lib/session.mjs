import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { CodexClient, cleanError } from './codex.mjs';

export const BUSY = new Set(['starting', 'running', 'awaitingApproval', 'stopping']);
const LIMIT = 100_000;

export class Session extends EventEmitter {
  constructor({ workspace, clientFactory = opts => new CodexClient(opts), practiceDelay = 700 } = {}) {
    super(); this.workspace = workspace; this.clientFactory = clientFactory; this.practiceDelay = practiceDelay;
    this.state = { revision: 0, phase: 'idle', mode: 'practice', prompt: '', output: '', progress: '先写下想做的事。',
      approvals: [], trace: [], connected: false, model: '', runId: null, error: '' };
    this.items = new Map(); this.messages = new Map(); this.timers = new Set(); this.tickets = new Map();
  }
  snapshot() { return structuredClone(this.state); }
  changed() { this.state.revision++; this.emit('change', this.snapshot()); }
  note(text) { this.state.trace.push({ time: new Date().toISOString(), text }); this.state.trace = this.state.trace.slice(-40); }
  set(phase, progress) { this.state.phase = phase; this.state.progress = progress; this.changed(); }
  prepare(prompt, mode) {
    if (BUSY.has(this.state.phase)) throw new Error('上一项任务尚未结束，请先停止或等待完成。');
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 12000) throw new Error('请输入 1 至 12000 个字符的草稿。');
    if (!['practice', 'codex'].includes(mode)) throw new Error('任务模式无效。');
    const ticket = randomUUID(); this.tickets.clear();
    const preview = { ticket, prompt, mode, workspace: this.workspace };
    this.tickets.set(ticket, preview); return preview;
  }
  async connect() {
    if (this.state.connected) return;
    if (!this.client) {
      this.client = this.clientFactory({ cwd: this.workspace });
      const ownedClient = this.client;
      this.client.on('notification', message => this.notification(message));
      this.client.on('request', message => this.nativeRequest(message));
      this.client.on('fault', message => {
        if (this.client !== ownedClient) return;
        ownedClient.removeAllListeners(); ownedClient.close(); this.client = null; this.threadId = null;
        this.state.connected = false;
        if (BUSY.has(this.state.phase) && this.state.mode === 'codex') this.failure(message);
        else this.changed();
      });
    }
    try { await this.client.connect(); this.state.connected = true; this.changed(); }
    catch (error) {
      const old = this.client; this.client = null; this.threadId = null;
      old?.removeAllListeners(); old?.close(); throw error;
    }
  }
  async send(ticket) {
    if (BUSY.has(this.state.phase)) throw new Error('任务正在进行，不能重复发送。');
    const preview = this.tickets.get(ticket);
    if (!preview) throw new Error('这份发送确认已失效，请重新检查草稿。');
    this.tickets.clear(); this.clearTimers(); this.messages.clear(); this.items.clear();
    const runId = randomUUID();
    this.state = { ...this.state, phase: 'starting', mode: preview.mode, prompt: preview.prompt,
      output: '', progress: '正在准备任务。', approvals: [], trace: [], runId, error: '' };
    this.turnId = null; this.stopRequested = false; this.note('使用者检查草稿后，授权发送本次任务。'); this.changed();
    this.turnDispatched = false;
    if (preview.mode === 'practice') {
      this.state.approvals.push({ id: randomUUID(), kind: 'practice', title: '练习授权',
        details: '允许在结果区显示固定练习结果吗？这不会运行命令、修改文件或调用模型。' });
      this.set('awaitingApproval', '练习正在等待你的选择。'); return;
    }
    try {
      await this.connect();
      if (this.cancelPreparation(runId)) return;
      if (!this.threadId) {
        const result = await this.client.request('thread/start', {
          cwd: this.workspace, sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'user',
          ephemeral: true,
          developerInstructions: '这是本机无障碍原型的测试会话。只操作 cwd 内的自制样本，不使用用户其他目录、账号、浏览器、应用或第三方服务。只按用户本次任务工作，不启动子代理。需要澄清时用简短中文说明。',
        });
        if (result.sandbox?.type !== 'workspaceWrite' || result.approvalPolicy !== 'on-request' || result.approvalsReviewer !== 'user') {
          throw new Error('Codex 没有采用原型要求的目录沙箱和人工授权策略，本次没有发送任务。');
        }
        this.threadId = result.thread.id; this.state.model = result.model;
      }
      if (this.cancelPreparation(runId)) return;
      this.turnDispatched = true;
      const result = await this.client.request('turn/start', { threadId: this.threadId,
        input: [{ type: 'text', text: preview.prompt }], approvalPolicy: 'on-request', approvalsReviewer: 'user',
        sandboxPolicy: { type: 'workspaceWrite', writableRoots: [this.workspace], networkAccess: false,
          excludeSlashTmp: true, excludeTmpdirEnvVar: true } });
      this.turnId = result.turn.id;
      if (this.stopRequested) await this.interrupt();
      else if (this.state.phase === 'starting') this.set('running', 'Codex 正在处理；可以随时请求停止。');
    } catch (error) {
      if (this.state.runId === runId && !this.cancelPreparation(runId)) this.failure(cleanError(error.message));
    }
  }
  cancelPreparation(runId) {
    if (this.state.runId !== runId) return true;
    if (this.stopRequested && !this.turnDispatched) {
      this.clearTimers(); this.set('interrupted', '已取消准备；本次尚未发送模型任务。'); return true;
    }
    return false;
  }
  nativeRequest(message) {
    const params = message.params || {};
    if (!BUSY.has(this.state.phase) || this.state.mode !== 'codex' ||
      (params.threadId && params.threadId !== this.threadId)) {
      this.client.unsupported(message.id); return;
    }
    if (this.stopRequested) { this.client.unsupported(message.id); return; }
    const command = message.method === 'item/commandExecution/requestApproval';
    const file = message.method === 'item/fileChange/requestApproval';
    if (!command && !file) {
      this.client.unsupported(message.id);
      this.note('收到原型尚不支持的交互请求，未同意；正在停止任务。');
      void this.stop(); return;
    }
    const item = this.items.get(params.itemId);
    if (!this.turnId && params.turnId) this.turnId = params.turnId;
    const details = command
      ? [params.reason, params.command && `命令：\n${params.command}`, params.cwd && `目录：${params.cwd}`,
        params.networkApprovalContext && `网络请求：${JSON.stringify(params.networkApprovalContext)}`].filter(Boolean).join('\n\n')
      : [params.reason, ...(item?.changes || []).map(change => `${change.path}\n${change.diff || ''}`),
        params.grantRoot && `申请写入目录：${params.grantRoot}`].filter(Boolean).join('\n\n');
    this.state.approvals.push({ id: randomUUID(), rpcId: message.id, kind: file ? 'file' : 'command',
      command: command ? params.command || '' : '',
      title: file ? 'Codex 申请修改文件' : 'Codex 申请执行命令',
      details: (details || '服务端未提供详细内容。建议拒绝本次。').slice(0, 24000),
      threadId: params.threadId, turnId: params.turnId });
    this.note('收到 Codex 的实际授权请求。'); this.set('awaitingApproval', 'Codex 正在等待你的选择。');
  }
  decide(id, decision) {
    if (!['accept', 'decline'].includes(decision)) throw new Error('授权选项无效。');
    const request = this.state.approvals[0];
    if (!request || request.id !== id || this.stopRequested) throw new Error('这条授权已失效，未发送选择。');
    this.state.approvals.shift(); this.note(decision === 'accept' ? '使用者允许本次请求。' : '使用者拒绝本次请求。');
    if (request.kind === 'practice') {
      if (decision === 'decline') {
        this.state.output = '你拒绝了练习授权，演练已结束。没有执行任何命令或修改文件。';
        this.set('completed', '练习已结束：你选择了拒绝。');
      } else this.practiceRun();
    } else {
      this.client.respond(request.rpcId, { decision });
      this.set(this.state.approvals.length ? 'awaitingApproval' : 'running',
        this.state.approvals.length ? '还有一条请求等待你的选择。' : '已发送本次选择，等待 Codex 继续。');
    }
  }
  practiceRun() {
    const runId = this.state.runId;
    this.set('running', '正在演练结果生成。现在可以按 Esc 停止。');
    for (let index = 1; index <= 8; index++) {
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        if (this.state.runId !== runId || this.state.phase !== 'running') return;
        if (index < 8) this.set('running', `练习处理中，${index}/8。可以停止。`);
        else {
          this.state.output = `练习完成\n\n你确认发送的草稿：\n${this.state.prompt}\n\n你允许了练习授权。\n这是固定流程的回显，不是 AI 回答。没有运行命令、修改文件或调用模型。`;
          this.set('completed', '练习已完成，可定位到结果区阅读。');
        }
      }, this.practiceDelay * index);
      this.timers.add(timer);
    }
  }
  notification({ method, params = {} }) {
    if (this.state.mode !== 'codex' || !BUSY.has(this.state.phase)) return;
    if (params.threadId && params.threadId !== this.threadId) return;
    if (this.turnId && params.turnId && params.turnId !== this.turnId) return;
    if (this.finishedTurnId && (params.turnId || params.turn?.id) === this.finishedTurnId) return;
    if (method === 'turn/started') {
      this.turnId = params.turn.id;
      if (this.stopRequested) void this.interrupt();
    } else if (method === 'item/started') {
      this.items.set(params.item.id, params.item);
      if (params.item.type === 'commandExecution') this.note('Codex 开始一个命令步骤。');
      if (params.item.type === 'fileChange') this.note('Codex 开始一个文件修改步骤。');
      this.changed();
    } else if (method === 'item/agentMessage/delta' && !this.stopRequested) {
      this.messages.set(params.itemId, (this.messages.get(params.itemId) || '') + params.delta);
      this.resultText();
    } else if (method === 'item/completed' && params.item?.type === 'agentMessage' && !this.stopRequested) {
      this.messages.set(params.item.id, params.item.text || ''); this.resultText();
    } else if (method === 'serverRequest/resolved') {
      this.state.approvals = this.state.approvals.filter(request => request.rpcId !== params.requestId);
      if (this.state.phase === 'awaitingApproval' && !this.state.approvals.length) this.set('running', '授权请求已结束，等待任务状态。');
      else this.changed();
    } else if (method === 'turn/completed') {
      this.finishedTurnId = params.turn.id;
      this.clearTimers(); this.state.approvals = [];
      const status = params.turn.status;
      if (status === 'interrupted') { this.note('收到 Codex 的任务中断回执。'); this.set('interrupted', 'Codex 已确认本轮中断；此前已完成的操作不会自动撤销。'); }
      else if (status === 'failed') this.failure(cleanError(params.turn.error?.message || 'Codex 任务失败。'));
      else { this.note('收到 Codex 的任务完成回执。'); this.set('completed', this.stopRequested ? '停止请求到达前，本轮已完成。请检查结果。' : 'Codex 已完成本轮任务。'); }
    } else if (method === 'error') {
      this.note('Codex 报告错误，等待本轮结束。');
      this.state.error = cleanError(params.error?.message || 'Codex 返回错误。'); this.changed();
    }
  }
  resultText() {
    this.state.output = [...this.messages.values()].join('\n\n').slice(0, LIMIT);
    this.changed();
  }
  async stop() {
    if (!BUSY.has(this.state.phase)) return;
    if (this.stopRequested) return;
    this.stopRequested = true; this.tickets.clear(); this.clearTimers();
    if (this.state.mode === 'practice') {
      this.state.approvals = []; this.note('练习任务已停止。'); this.set('interrupted', '练习已停止。草稿仍可修改和重新发送。'); return;
    }
    for (const request of this.state.approvals) {
      try { this.client.respond(request.rpcId, { decision: 'cancel' }); } catch {}
    }
    this.state.approvals = []; this.note('使用者请求中断本轮任务。'); this.set('stopping', '已请求停止，正在等待 Codex 确认。');
    if (this.turnId) await this.interrupt();
    // If preparation is still awaiting a reply, send() acknowledges cancellation
    // after that reply. A new run cannot race an unfinished preparation.
    // Do not claim termination when acknowledgement is missing.
    if (this.state.phase === 'stopping') {
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        if (this.state.phase === 'stopping') { this.state.progress = '仍未收到结束回执。可以关闭本机连接；已完成的操作不会撤销。'; this.changed(); }
      }, 8000); this.timers.add(timer);
    }
  }
  async interrupt() {
    if (!this.turnId || !this.client) return;
    try { await this.client.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId }, 8000); }
    catch { if (this.state.phase === 'stopping') { this.state.progress = '中断请求未得到确认。可关闭本机连接，随后检查测试目录。'; this.changed(); } }
  }
  disconnect() {
    this.clearTimers(); this.tickets.clear(); this.stopRequested = true;
    const old = this.client; this.client = null; this.threadId = null; this.turnId = null;
    old?.removeAllListeners(); old?.close(); this.state.connected = false; this.state.approvals = [];
    if (BUSY.has(this.state.phase)) { this.state.error = '连接已关闭，任务最终状态未确认。请检查测试目录；这不等于已撤销操作。'; this.set('failed', '连接已关闭，任务状态未确认。'); }
    else this.changed();
  }
  failure(message) { this.clearTimers(); this.state.approvals = []; this.state.error = message; this.set('failed', message); }
  clearTimers() { for (const timer of this.timers) clearTimeout(timer); this.timers.clear(); }
  dispose() { this.disconnect(); this.removeAllListeners(); }
}
