import { Draft, replaceFirst, deleteLastSentence } from './editor.mjs';
const $ = id => document.getElementById(id);
const draft = new Draft();
const busyPhases = new Set(['starting', 'running', 'awaitingApproval', 'stopping']);
const labels = { idle: '未开始', starting: '准备中', running: '处理中', awaitingApproval: '等待选择', stopping: '等待中断回执', completed: '已完成', interrupted: '已中断', failed: '需要处理' };
let token, workspace, state, preview, source, online = false, reviewBusy = false;
let shownApproval = null, scanTimer, scanIndex = -1, scanning = false, scanTarget;

function notice(text) { $('notice').textContent = text; }
async function api(action, extra = {}) {
  const response = await fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Client-Token': token }, body: JSON.stringify({ action, ...extra }) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '操作未完成。');
  return data;
}
function cancelPreview({ focus = false } = {}) {
  if (preview) void api('cancelPreview').catch(() => {});
  preview = null; $('review-panel').hidden = true;
  if (focus) $('draft').focus();
}
function draftChanged(text, message) {
  draft.update(text); $('draft').value = draft.text;
  $('char-count').textContent = `${draft.text.length} / 12000`;
  cancelPreview(); if (message) notice(message);
}
function controls() { return [...document.querySelectorAll('[data-nav]')].filter(element => !element.disabled && element.getClientRects().length); }
function nextControl() {
  const list = controls();
  const index = list.indexOf(document.activeElement);
  const next = list[(index + 1) % list.length]; next?.focus(); next?.scrollIntoView({ block: 'nearest' });
}
function scanCandidates() { return controls().filter(element => element.tagName === 'BUTTON'); }
function clearHighlight() { scanTarget?.classList.remove('scanning'); scanTarget = null; }
function tickScan() {
  if (['TEXTAREA', 'INPUT', 'SELECT'].includes(document.activeElement?.tagName)) {
    clearHighlight(); $('scan-status').textContent = '扫描暂停：完成编辑后，可选择“完成编辑，继续定位”。'; return;
  }
  const list = scanCandidates(); if (!list.length) return;
  clearHighlight(); scanIndex = (scanIndex + 1) % list.length; scanTarget = list[scanIndex];
  scanTarget.classList.add('scanning'); scanTarget.scrollIntoView({ block: 'nearest' });
  $('scan-status').textContent = `扫描：${scanTarget.textContent}。按空格执行；Esc 可停止任务。`;
}
function restartScan() {
  clearInterval(scanTimer); clearHighlight();
  if (scanning) { scanIndex = -1; tickScan(); scanTimer = setInterval(tickScan, Number($('scan-speed').value)); }
  else $('scan-status').textContent = '';
}
function render(next) {
  if (state && next.revision < state.revision) return;
  const previous = state;
  state = next;
  $('phase').textContent = labels[state.phase] || state.phase;
  $('progress').textContent = state.progress;
  $('error').hidden = !state.error; $('error').textContent = state.error;
  $('connection').textContent = state.connected ? `已连接本机 Codex${state.model ? `，本会话模型：${state.model}` : ''}。` : '尚未连接 Codex。练习模式不需要登录。';
  const busy = busyPhases.has(state.phase);
  $('review').disabled = busy || !online || reviewBusy;
  $('mode').disabled = busy;
  $('stop').disabled = !busy || state.phase === 'stopping';
  $('disconnect').disabled = !state.connected && !(busy && state.mode === 'codex');
  $('result').textContent = state.output || '暂无结果。草稿会保留在输入区。';
  $('result-source').textContent = state.runId ? (state.mode === 'practice' ? '练习回显，不是 AI 回答' : '来自本机 Codex 会话') : '暂无结果';
  $('trace').replaceChildren(...state.trace.map(entry => {
    const item = document.createElement('li');
    item.textContent = `${new Date(entry.time).toLocaleTimeString('zh-CN', { hour12: false })} ${entry.text}`; return item;
  }));
  const approval = state.approvals[0];
  $('approval-panel').hidden = !approval;
  if (approval) {
    $('approval-title').textContent = approval.title;
    $('approval-details').textContent = approval.details;
    $('accept').disabled = !online; $('decline').disabled = !online;
    if (shownApproval !== approval.id) {
      shownApproval = approval.id;
      cancelPreview(); $('decline').focus();
      clearHighlight(); scanIndex = Math.max(-1, scanCandidates().indexOf($('decline')) - 1);
    }
  } else shownApproval = null;
  if (busyPhases.has(previous?.phase) && !busy && !['TEXTAREA', 'INPUT', 'SELECT'].includes(document.activeElement?.tagName)) $('view-result').focus();
}

async function guarded(callback) {
  try { await callback(); } catch (error) { notice(error.message); }
}
$('draft').addEventListener('input', () => draftChanged($('draft').value));
$('example').onclick = () => draftChanged('请把测试标题改成今天的安排。\n这是一条练习草稿。', '已填入自编练习句，可继续修改。');
$('undo').onclick = () => {
  $('draft').value = draft.undo(); $('char-count').textContent = `${draft.text.length} / 12000`;
  cancelPreview(); notice('已撤销最近一次草稿修改。');
};
$('delete-last').onclick = () => draftChanged(deleteLastSentence(draft.text), '已删除上一句，可撤销。');
$('clear').onclick = () => draftChanged('', '已清空草稿，可撤销。');
$('replace').onclick = () => guarded(() => {
  const result = replaceFirst(draft.text, $('find').value, $('replacement').value);
  draftChanged(result.text, `找到 ${result.count} 处，已替换第一处。请再检查草稿。`);
});
$('edit-done').onclick = () => { $('review').focus(); if (scanning) restartScan(); notice('草稿已保留，尚未发送。'); };
$('mode').onchange = () => {
  cancelPreview(); const real = $('mode').value === 'codex';
  $('mode-badge').textContent = real ? '真实 Codex 模式' : '练习模式'; $('mode-badge').classList.toggle('real', real);
  $('mode-description').textContent = real
    ? '发送前会请你检查草稿。确认后，草稿交给本机已登录的 Codex 服务；任务固定使用自制测试目录。'
    : '练习只回显草稿并演练授权、停止和查看结果，不会执行你的要求。';
  notice('模式已切换，尚未发送任何任务。');
};
$('review').onclick = () => guarded(async () => {
  if (reviewBusy) return;
  reviewBusy = true; $('review').disabled = true;
  try {
    const value = draft.text, mode = $('mode').value;
    const result = await api('prepare', { prompt: value, mode });
    if (draft.text !== value || $('mode').value !== mode) { await api('cancelPreview'); notice('草稿已变化，请重新检查。'); return; }
    preview = result; $('review-text').textContent = result.prompt;
    $('review-scope').textContent = mode === 'practice'
      ? '本次为练习，不调用模型，不运行命令，不修改文件。确认后还会演练一次授权选择。'
      : `本次将发送以下草稿给 Codex，使用测试目录：${workspace}。目录内操作不一定逐次询问；额外授权请求会显示在本页。`;
    $('review-panel').hidden = false; $('back-edit').focus(); notice('请检查内容，尚未发送。');
  } finally { reviewBusy = false; $('review').disabled = busyPhases.has(state?.phase) || !online; }
});
$('back-edit').onclick = () => cancelPreview({ focus: true });
$('confirm-send').onclick = () => guarded(async () => {
  if (!preview || preview.prompt !== draft.text || preview.mode !== $('mode').value) throw new Error('草稿已变化，请重新检查。');
  const ticket = preview.ticket; preview = null;
  $('confirm-send').disabled = true;
    try { const reply = await api('send', { ticket }); render(reply.state); $('review-panel').hidden = true; (state.approvals[0] ? $('decline') : $('stop')).focus(); notice('本次任务已发送，草稿仍在输入区。'); }
  finally { $('confirm-send').disabled = false; }
});
for (const [id, decision] of [['decline', 'decline'], ['accept', 'accept']]) {
  $(id).onclick = () => guarded(async () => {
    const request = state.approvals[0]; if (!request) return;
    $('accept').disabled = true; $('decline').disabled = true;
    try { const reply = await api('decision', { id: request.id, decision }); render(reply.state);
      (state.approvals[0] ? $('decline') : busyPhases.has(state.phase) ? $('stop') : $('view-result')).focus(); }
    catch (error) { $('accept').disabled = !online; $('decline').disabled = !online; throw error; }
  });
}
$('stop').onclick = () => guarded(async () => { window.speechSynthesis?.cancel(); await api('stop'); });
$('connect').onclick = () => guarded(async () => {
  $('connect').disabled = true; notice('正在检查本机 Codex；这不会发送模型任务。');
  try { await api('connect'); notice('连接检查通过。只有授权并发送后才会开始模型任务。'); }
  finally { $('connect').disabled = false; }
});
$('disconnect').onclick = () => guarded(async () => { await api('disconnect'); notice('已关闭本机 Codex 连接。草稿仍在本页。'); });
$('view-result').onclick = () => { $('result').focus(); $('result').scrollIntoView({ block: 'center' }); };
$('back-input').onclick = () => { $('draft').focus(); $('draft').scrollIntoView({ block: 'center' }); };
$('scan-toggle').onclick = () => {
  scanning = !scanning; $('scan-toggle').setAttribute('aria-pressed', String(scanning));
  $('scan-toggle').textContent = scanning ? '关闭单键扫描' : '开启单键扫描'; restartScan();
};
$('scan-speed').onchange = restartScan;
$('read-result').onclick = () => {
  if (!window.speechSynthesis) return notice('当前浏览器不提供朗读，可使用系统读屏。');
  window.speechSynthesis.cancel();
  const speech = new SpeechSynthesisUtterance(state?.output || '当前暂无结果。'); speech.lang = 'zh-CN'; speech.rate = 0.9;
  window.speechSynthesis.speak(speech); notice('开始朗读。停止朗读不会停止 Codex 任务。');
};
$('stop-reading').onclick = () => { window.speechSynthesis?.cancel(); notice('朗读已停止，任务状态不受影响。'); };
document.addEventListener('keydown', event => {
  if (event.isComposing) return;
  if (event.repeat && ['Enter', ' ', 'F7'].includes(event.key)) { event.preventDefault(); return; }
  if (event.key === 'Escape') {
    event.preventDefault(); window.speechSynthesis?.cancel();
    if (busyPhases.has(state?.phase)) void guarded(() => api('stop'));
    else if (preview) cancelPreview({ focus: true });
    return;
  }
  if (event.key === 'F6') { event.preventDefault(); nextControl(); }
  if (event.key === 'F8') { event.preventDefault(); $('view-result').click(); }
  if (event.key === 'F9') { event.preventDefault(); $('back-input').click(); }
  if (event.key === 'F7') {
    event.preventDefault(); if (document.activeElement?.tagName === 'BUTTON') document.activeElement.click();
  }
  if (scanning && event.key === ' ' && !['TEXTAREA', 'INPUT', 'SELECT'].includes(document.activeElement?.tagName)) {
    event.preventDefault(); const target = scanTarget;
    if (target && !target.disabled && target.getClientRects().length) { target.focus(); target.click(); }
    clearHighlight();
  }
});

async function bootstrap() {
  const response = await fetch('/api/bootstrap', { method: 'POST' }); const data = await response.json();
  if (!response.ok) throw new Error(data.error);
  token = data.token; workspace = data.workspace;
  $('workspace').textContent = workspace; render(data.state);
  source = new EventSource(`/api/events?client=${encodeURIComponent(token)}`);
  source.onopen = () => { online = true; render(state); notice('本机页面已连接。可从练习开始。'); };
  source.onmessage = event => render(JSON.parse(event.data));
  source.onerror = () => {
    online = false; if (state) render(state);
    $('accept').disabled = true; $('decline').disabled = true;
    notice('状态连接中断，正在重连。草稿仍在本页；恢复后请检查实际任务状态。');
  };
  $('draft').focus();
}
window.addEventListener('pagehide', () => { source?.close(); clearInterval(scanTimer); window.speechSynthesis?.cancel(); });
bootstrap().catch(error => { $('error').hidden = false; $('error').textContent = error.message; $('review').disabled = true; });
