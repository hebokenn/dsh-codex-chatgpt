import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {CodexAdapter, CodexWire, DEFAULT_IDLE_TIMEOUT_MS, projectHistory, projectTools} from '../bridge.mjs';
import {Config, adapterConfig, apply} from '../index.mjs';
const fixture = fileURLToPath(new URL('./fake-codex.mjs', import.meta.url));
const adapter = mode => new CodexAdapter({command: process.execPath, prefix: [fixture, mode], audit: false, timeoutMs: 2000});
const collect = async stream => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return chunks; };
const request = {model: 'gpt-test', messages: [{role: 'user', content: [{type: 'text', text: 'Verify'}]}]};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function transport(mode, timeoutMs) {
  const telemetry = []; let exited;
  const exit = new Promise(resolve => { exited = resolve; });
  const a = new CodexAdapter({command: process.execPath, prefix: [fixture, mode], audit: false, timeoutMs, onTelemetry: entry => { telemetry.push(entry); if (entry.kind === 'child_exit') exited(entry); }});
  return {a, telemetry, exit: () => Promise.race([exit, delay(1500).then(() => { throw Error('fake child did not exit'); })])};
}

test('explicit plugin idle configuration retains the 180s default and rejects invalid values before constructing a wire', () => {
  assert.equal(DEFAULT_IDLE_TIMEOUT_MS, 180000);assert.deepEqual(adapterConfig(), {idleTimeoutMs: 180000});
  assert.deepEqual(Config['~standard'].validate({idleTimeoutMs: 600000}).value, {idleTimeoutMs: 600000});
  for (const value of [null, false, 0, 999, 3600001, 1000.5, '600000', NaN, Infinity]) assert.ok(Config['~standard'].validate({idleTimeoutMs: value}).issues, String(value));
  let registered;
  apply({llm: {registerAdapter: (_names, a) => { registered = a; }}, effect: () => {}}, {idleTimeoutMs: 600000});
  assert.equal(registered.options.timeoutMs, 600000);assert.equal(registered.active.size, 0);registered.close();
  assert.throws(() => apply({}, {idleTimeoutMs: false}), /整数毫秒/);
});

test('an explicitly longer idle wait completes beyond the former threshold without any heartbeat (time scaled)', async () => {
  const old = transport('delayed', 180), extended = transport('delayed', 400);
  try {
    assert.match((await collect(old.a.stream(request))).at(-1).reason.failure.message, /长时间/);
    const chunks = await collect(extended.a.stream(request));assert.equal(chunks.at(-1).reason.kind, 'stop');
    const close = extended.telemetry.find(entry => entry.kind === 'wire_close');assert.equal(close.effective_idle_timeout_ms, 400);assert.ok(close.elapsed_ms >= 240);
    assert.equal(extended.telemetry.some(entry => entry.kind === 'heartbeat'), false);
    await old.exit();await extended.exit();
  } finally { old.a.close();extended.a.close(); }
});

test('unknown reasoning notifications refresh the actual event wait and stay metadata only', async () => {
  const {a, telemetry, exit} = transport('unknown-reasoning', 150);
  try {
    const chunks = await collect(a.stream(request));assert.equal(chunks.at(-1).reason.kind, 'stop');
    assert.equal(chunks.some(chunk => chunk.type === 'reasoning-delta'), false);
    const close = telemetry.find(entry => entry.kind === 'wire_close');assert.equal(close.event_methods['item/reasoning/opaquePartAdded'], 3);
    assert.doesNotMatch(JSON.stringify(telemetry), /PRIVATE_REASONING_SENTINEL|"params"|"delta"|"arguments"|"stderr"/);
    assert.ok(close.matching_event_count >= 3);await exit();
  } finally { a.close(); }
});

test('RPC responses complete their own requests without resetting an empty event wait', async () => {
  const telemetry = [], wire = new CodexWire({command: process.execPath, prefix: [fixture, 'rpc-only'], timeoutMs: 140, onTelemetry: entry => telemetry.push(entry)});
  try {
    await wire.initialize();const waiting = wire.next().then(() => null, error => error);
    for (let i = 0; i < 3; i++) { await delay(30);await wire.request('ping', {private: 'RPC_PRIVATE_SENTINEL'}); }
    assert.match((await waiting).message, /长时间/);
    const timeout = telemetry.find(entry => entry.kind === 'idle_timeout');assert.equal(timeout.event_count, 0);assert.ok(timeout.quiet_elapsed_ms >= 130);
    assert.equal(telemetry.filter(entry => entry.kind === 'rpc' && entry.method === 'ping' && entry.phase === 'resolved').length, 3);
    assert.doesNotMatch(JSON.stringify(telemetry), /RPC_PRIVATE_SENTINEL|"params"/);
  } finally { wire.close(); }
});

test('a truly quiet stream reaches the configured new threshold and records real child exit', async () => {
  const {a, telemetry, exit} = transport('hang', 220);
  try {
    assert.equal((await collect(a.stream(request))).at(-1).reason.kind, 'error');
    const timeout = telemetry.find(entry => entry.kind === 'idle_timeout');assert.equal(timeout.effective_idle_timeout_ms, 220);assert.ok(timeout.quiet_elapsed_ms >= 210);
    const requestResolved = telemetry.findLast(entry => entry.kind === 'rpc' && entry.method === 'turn/start' && entry.phase === 'resolved');
    assert.ok(timeout.last_waiting_at);assert.ok(Date.parse(timeout.last_waiting_at) >= Date.parse(requestResolved.at));assert.ok(Date.parse(timeout.last_waiting_at) <= Date.parse(timeout.at));
    assert.equal(typeof timeout.last_waiting_monotonic_ms, 'number');assert.ok(timeout.last_waiting_monotonic_ms >= 0 && timeout.last_waiting_monotonic_ms <= performance.now());
    const summary = telemetry.find(entry => entry.kind === 'wire_close');assert.equal(summary.last_waiting_at, timeout.last_waiting_at);assert.equal(summary.last_waiting_monotonic_ms, timeout.last_waiting_monotonic_ms);
    const ended = await exit();assert.ok(ended.child_pid > 0);assert.ok(ended.exit.signal || ended.exit.code !== null);assert.equal(ended.termination, 'idle_timeout');assert.equal(a.active.size, 0);
  } finally { a.close(); }
});

test('abort retains its own termination category and observes the actual child exit', async () => {
  const {a, telemetry, exit} = transport('hang', 2000), controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 80);
  try {
    assert.equal((await collect(a.stream({...request, signal: controller.signal}))).at(-1).reason.kind, 'aborted');
    const ended = await exit();assert.equal(ended.termination, 'aborted');assert.equal(telemetry.some(entry => entry.kind === 'idle_timeout'), false);assert.equal(a.active.size, 0);
  } finally { clearTimeout(timer);a.close(); }
});

test('replays paired tool results and keeps message order while omitting interrupted calls', () => {
  const history = projectHistory([
    {role: 'system', content: [{type: 'text', text: 'System instruction'}]},
    {role: 'user', content: [{type: 'text', text: 'Read'}]},
    {role: 'assistant', content: [{type: 'text', text: 'Checking'}, {type: 'tool-call', id: 'yes', name: 'read', arguments: '{}'}, {type: 'tool-call', id: 'aborted', name: 'read', arguments: '{}'}]},
    {role: 'tool', toolCallId: 'yes', content: [{type: 'text', text: 'nonce'}]},
    {role: 'tool', toolCallId: 'orphan', content: [{type: 'text', text: 'ignored'}]},
  ]);
  assert.equal(history.baseInstructions, 'System instruction');
  assert.deepEqual(history.items.map(i => i.type), ['message', 'message', 'function_call', 'function_call_output']);
  assert.equal(history.items.at(-1).output[0].text, 'nonce');
});
test('long tool aliases are stable and collisions are refused', () => {
  const a = projectTools([{name: 'x'.repeat(100), parameters: {type: 'object'}}]);
  assert.ok(a.dynamicTools[0].name.length <= 64);
  const history = projectHistory([{role: 'assistant', content: [{type: 'tool-call', id: 'c', name: 'x'.repeat(100), arguments: '{}'}]}, {role: 'tool', toolCallId: 'c', content: []}]);
  assert.equal(history.items[0].name, a.dynamicTools[0].name);
  assert.throws(() => projectTools([{name: 'same'}, {name: 'same'}]), /重复/);
});
test('images remain image inputs; missing image resolution fails visibly', () => {
  const messages = [{role: 'user', content: [{type: 'image', attachment: {attachmentId: 'image'}}]}];
  assert.equal(projectHistory(messages, () => 'data:image/png;base64,AA==').items[0].content[0].type, 'input_image');
  assert.throws(() => projectHistory(messages), /图片附件/);
});
test('streams text exactly once and reports disjoint cached input usage', async () => {
  const a = adapter('text'); try {
    assert.equal((await a.listModels())[0].name, 'GPT Test');
    const chunks = await collect(a.stream(request));
    assert.equal(chunks.filter(c => c.type === 'text-delta').map(c => c.text).join(''), 'bridge ok');
    assert.equal(chunks.filter(c => c.type === 'finish').length, 1);
    assert.equal(chunks.at(-1).reason.kind, 'stop');
    assert.equal(chunks.find(c => c.type === 'usage').usage.inputTokens, 15);
    assert.equal(a.active.size, 0);
  } finally { a.close(); }
});
test('hands a native dynamic tool to DSH and stops the native turn', async () => {
  const a = adapter('tool'); try {
    const chunks = await collect(a.stream({...request, tools: [{name: 'lookup', parameters: {type: 'object'}}]}));
    assert.equal(chunks.at(-1).reason.kind, 'tool-calls');
    const call = chunks.find(c => c.type === 'block-end').block;
    assert.deepEqual(call, {type: 'tool-call', id: 'call-test', name: 'lookup', arguments: '{"key":"nonce"}'});
    assert.equal(a.active.size, 0);
  } finally { a.close(); }
});
test('delegates tool authority to DSH without a false read-only ceiling or native execution tools', async () => {
  const a=adapter('host-permission');try{
    const chunks=await collect(a.stream(request));
    assert.equal(chunks.at(-1).reason.kind,'stop');
    assert.equal(chunks.filter(c=>c.type==='text-delta').map(c=>c.text).join(''),'bridge ok');
    assert.equal(a.active.size,0);
  }finally{a.close();}
});
for (const [mode, pattern] of [['auth', /ChatGPT/], ['fallback', /不一致/], ['error', /usage limit/]]) {
  test(`refuses ${mode} without provider/model fallback`, async () => {
    const a = adapter(mode); try {
      const chunks = await collect(a.stream(request));
      assert.equal(chunks.at(-1).reason.kind, 'error');
      assert.match(chunks.at(-1).reason.failure.message, pattern);
      assert.equal(a.active.size, 0);
    } finally { a.close(); }
  });
}
test('cancellation settles a blocked stream and closes its process', async () => {
  const a = adapter('hang'); const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 150);
  try {
    const chunks = await collect(a.stream({...request, signal: controller.signal}));
    assert.equal(chunks.at(-1).reason.kind, 'aborted');
    assert.equal(a.active.size, 0);
  } finally { clearTimeout(timer); a.close(); }
});
