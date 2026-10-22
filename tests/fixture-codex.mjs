// Test-only JSONL process. Never selected by the application launcher.
import { createInterface } from 'node:readline';
const write = value => process.stdout.write(JSON.stringify(value) + '\n');
let turn = 0, current, waiting;
const done = status => write({ method: 'turn/completed', params: { threadId: 'test-thread', turn: { id: current, status } } });
createInterface({ input: process.stdin }).on('line', line => {
  const value = JSON.parse(line);
  const reply = result => write({ id: value.id, result });
  if (!value.method && value.id === 'fixture-approval') {
    if (value.result.decision === 'cancel') done('interrupted');
    else { write({ method: 'item/completed', params: { threadId: 'test-thread', turnId: current, item: { id: 'message', type: 'agentMessage', text: `fixture ${value.result.decision}`, phase: 'final_answer' } } }); done('completed'); }
    waiting = false; return;
  }
  switch (value.method) {
    case 'initialize': reply({ userAgent: 'fixture-only' }); break;
    case 'account/read': reply({ account: { type: 'chatgpt' } }); break;
    case 'thread/start': reply({ thread: { id: 'test-thread' }, model: 'fixture-model', cwd: process.cwd(), approvalPolicy: value.params.approvalPolicy, approvalsReviewer: 'user', sandbox: { type: process.env.FIXTURE_UNSAFE ? 'dangerFullAccess' : 'workspaceWrite' } }); break;
    case 'turn/start': {
      current = `test-turn-${++turn}`; reply({ turn: { id: current, status: 'inProgress' } });
      write({ method: 'turn/started', params: { threadId: 'test-thread', turn: { id: current, status: 'inProgress' } } });
      const prompt = value.params.input[0].text;
      if (prompt === 'APPROVAL' || prompt === 'FILE') {
        waiting = true;
        const file = prompt === 'FILE';
        write({ method: 'item/started', params: { threadId: 'test-thread', turnId: current, item: file ? { id: 'command', type: 'fileChange', changes: [{ path: 'sample.txt', diff: '-old\n+new' }] } : { id: 'command', type: 'commandExecution', command: 'echo fixture' } } });
        write({ id: 'fixture-approval', method: file ? 'item/fileChange/requestApproval' : 'item/commandExecution/requestApproval', params: { threadId: 'test-thread', turnId: current, itemId: 'command', command: file ? undefined : 'echo fixture', cwd: process.cwd(), reason: 'Synthetic authorization test' } });
      } else if (prompt !== 'WAIT') {
        write({ method: 'item/agentMessage/delta', params: { threadId: 'test-thread', turnId: current, itemId: 'message', delta: 'fixture result' } }); done('completed');
      } break;
    }
    case 'turn/interrupt': reply({}); done('interrupted');
      write({ method: 'item/agentMessage/delta', params: { threadId: 'test-thread', turnId: current, itemId: 'late', delta: 'LATE MUST NOT APPEAR' } }); break;
    case 'initialized': break;
    default: if (value.id !== undefined) write({ id: value.id, error: { code: -32601, message: 'fixture unknown method' } });
  }
});
