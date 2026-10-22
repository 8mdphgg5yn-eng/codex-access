import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';

// These are process-local overrides. Never rewrite the user's Codex config.
export const CODEX_ARGS = [
  'app-server', '--stdio',
  '-c', 'approval_policy="on-request"', '-c', 'approvals_reviewer="user"',
  '-c', 'sandbox_mode="workspace-write"',
  '-c', 'sandbox_workspace_write.network_access=false',
  '-c', 'mcp_servers={}', '-c', 'web_search="disabled"',
  ...['apps', 'plugins', 'hooks', 'memories', 'chronicle', 'browser_use',
    'computer_use', 'multi_agent', 'multi_agent_v2', 'shell_snapshot']
    .flatMap(name => ['--disable', name]),
];

export class CodexClient extends EventEmitter {
  constructor({ cwd, binary = process.env.CODEX_ACCESS_BIN || 'codex', spawnFn = spawn } = {}) {
    super();
    this.cwd = cwd; this.binary = binary; this.spawnFn = spawnFn;
    this.pending = new Map(); this.sequence = 0; this.closed = false;
  }
  async connect() {
    if (this.ready) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.initialize();
    try { await this.connecting; } finally { this.connecting = null; }
  }
  async initialize() {
    if (this.closed) throw new Error('连接已关闭，请刷新页面重新连接。');
    const env = {};
    for (const key of ['PATH', 'HOME', 'TMPDIR', 'CODEX_HOME', 'LANG', 'LC_ALL',
      'SSL_CERT_FILE', 'SSL_CERT_DIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY',
      'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']) {
      if (process.env[key]) env[key] = process.env[key];
    }
    this.child = this.spawnFn(this.binary, CODEX_ARGS, { cwd: this.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.on('error', () => this.fail('无法启动本机 Codex。请确认已安装并在原客户端登录。'));
    this.child.on('exit', () => this.fail('Codex 连接已结束。草稿仍在本页，可重新连接。'));
    // Do not forward process stderr, which may include user data or local configuration.
    this.child.stderr.on('data', () => {});
    this.child.stdin.on('error', () => this.fail('Codex 输入连接已断开。'));
    const lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    lines.on('line', line => {
      if (line.length > 2_000_000) return this.fail('Codex 返回的数据过大，连接已停止。');
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.method) this.emit(message.id === undefined ? 'notification' : 'request', message);
      else if (this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id); clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(cleanError(message.error.message)));
        else pending.resolve(message.result);
      }
    });
    await this.request('initialize', { clientInfo: { name: 'codex_access_prototype', title: '开控本机原型', version: '0.1.0-alpha.1' } });
    this.write({ method: 'initialized', params: {} });
    const account = await this.request('account/read', { refreshToken: false });
    if (!account.account) throw new Error('本机 Codex 尚未登录，请先在原客户端完成登录。');
    this.ready = true;
  }
  request(method, params, timeout = 30_000) {
    if (this.closed || !this.child || this.child.killed || this.child.exitCode !== null) return Promise.reject(new Error('Codex 连接不可用。'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Codex 响应超时。可停止连接后重试。')); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); }
      catch { this.pending.delete(id); clearTimeout(timer); reject(new Error('向 Codex 发送请求失败。')); }
    });
  }
  write(message) { this.child.stdin.write(JSON.stringify(message) + '\n'); }
  respond(id, result) { this.write({ id, result }); }
  unsupported(id) { this.write({ id, error: { code: -32601, message: 'This prototype cannot display this request safely.' } }); }
  fail(message) {
    this.ready = false;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error(message)); }
    this.pending.clear();
    this.emit('fault', message);
  }
  close() {
    if (this.closed) return;
    this.closed = true; this.ready = false;
    this.fail('本机连接已关闭。');
    if (this.child && this.child.exitCode === null) {
      this.child.stdin.end();
      const child = this.child;
      const timer = setTimeout(() => { if (child.exitCode === null) child.kill('SIGTERM'); }, 800);
      timer.unref();
    }
  }
}

export function cleanError(value) {
  return String(value || 'Codex 请求失败。')
    .replace(/(?:sk-[\w-]+|Bearer\s+\S+|access_token["\s:=]+\S+)/gi, '[已隐藏凭证]')
    .slice(0, 600);
}
