import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {existsSync, readFileSync, mkdirSync, appendFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join, delimiter} from 'node:path';
import {createHash, randomUUID} from 'node:crypto';

export const PROVIDER = 'codex-chatgpt';
const VERSION = '0.1.2';
export const DEFAULT_IDLE_TIMEOUT_MS = 180000;
export function idleTimeoutMs(value = DEFAULT_IDLE_TIMEOUT_MS, minimum = 1000) {
  if (!Number.isSafeInteger(value) || value < minimum || value > 3600000) throw new TypeError(`idleTimeoutMs 必须是 ${minimum}–3600000 的整数毫秒。`);
  return value;
}
// Native capability flags below are sent explicitly. Actual upstream tool
// admission is a separate contract; externalSandbox is not a read-only sandbox.
const HOST_SANDBOX = Object.freeze({type: 'externalSandbox', networkAccess: 'enabled'});
const RETRY_POLICY = Object.freeze({mode: 'normal', maxRetries: 0, retryableCodes: [], initialDelayMs: 1000, maxDelayMs: 1000, jitterRatio: 0});
const CONFIG = Object.freeze({
  'features.apps': false, 'features.plugins': false, 'features.code_mode': false,
  'features.code_mode_only': false, 'features.shell_tool': false,
  'features.unified_exec': false, 'features.apply_patch_freeform': false,
  'features.view_image': false, 'features.image_generation': false,
  'features.multi_agent': false, 'features.multi_agent_v2': false,
  'features.enable_fanout': false, 'features.memories': false,
  'features.hooks': false, 'features.request_permissions_tool': false,
  'features.context_management': false, 'features.tool_suggest': false,
  'cloud.skills.enabled': false, 'skills.include_instructions': false,
  'tools.experimental_request_user_input.enabled': false,
  'tools.update_plan.enabled': false, 'web_search': 'disabled',
  'project_doc_max_bytes': 0,
});

function aborted() { return new DOMException('操作已取消', 'AbortError'); }
function errorCode(error) {
  if (error?.name === 'AbortError') return 'ABORTED';
  const message = String(error?.message ?? error);
  if (/rate.?limit|usage.?limit|quota|limit reached/i.test(message)) return 'QUOTA';
  if (/auth|login|sign.?in|ChatGPT 登录|API Key/i.test(message)) return 'AUTH';
  if (/context.*(?:exceed|long)|too many tokens/i.test(message)) return 'CONTEXT_WINDOW_EXCEEDED';
  return 'CODEX_APP_SERVER';
}

/** One local child; credentials are read and refreshed by Codex itself. */
export class CodexWire {
  constructor({command, prefix = [], signal, timeoutMs = DEFAULT_IDLE_TIMEOUT_MS, onTelemetry} = {}) {
    this.pending = new Map(); this.events = []; this.waiter = null; this.sequence = 0;
    this.timeoutMs = idleTimeoutMs(timeoutMs, 1); this.onTelemetry = onTelemetry;
    this.started = performance.now(); this.startedAt = new Date().toISOString(); this.wireId = randomUUID();
    this.eventCount = 0; this.eventMethods = new Map(); this.matchingEventCount = 0; this.ignoredEventCount = 0;
    const env = {...process.env};
    for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'CODEX_ACCESS_TOKEN']) delete env[key];
    this.child = spawn(command ?? findCodex(), [...prefix, 'app-server', '--listen', 'stdio://',
      '-c', 'mcp_servers={}', '-c', 'forced_login_method="chatgpt"',
      '-c', 'features.plugins=false', '-c', 'cloud.skills.enabled=false'],
    {env, stdio: ['pipe', 'pipe', 'pipe']});
    // Drain stderr without logging prompts, account identifiers, or credentials.
    this.child.stderr.on('data', () => {});
    this.child.stdin.on('error', error => this.fail(error, 'connection_error'));
    this.child.on('error', error => this.fail(error, 'spawn_error'));
    this.child.on('exit', (code, signal) => { this.exit = {code, signal}; this.note('child_exit'); this.fail(new Error(`Codex app-server 已退出 (${signal ?? code})`), 'child_exit'); });
    this.lines = createInterface({input: this.child.stdout});
    this.lines.on('line', line => {
      try {
        const event = JSON.parse(line);
        if (event.id != null && !event.method) {
          const pending = this.pending.get(event.id);
          if (pending) {
            this.pending.delete(event.id); clearTimeout(pending.timer);
            this.note('rpc', {method: pending.method, phase: event.error ? 'rejected' : 'resolved', rpc_elapsed_ms: Math.round(performance.now() - pending.started)});
            if (event.error) pending.reject(new Error(event.error.message ?? JSON.stringify(event.error)));
            else pending.resolve(event.result);
          }
        } else this.push(event);
      } catch { this.fail(new Error('Codex app-server 返回了无效 JSON'), 'invalid_json'); }
    });
    this.onAbort = () => { this.fail(aborted(), 'aborted'); this.close(); };
    this.signal = signal;
    if (signal?.aborted) this.onAbort();
    else signal?.addEventListener('abort', this.onAbort, {once: true});
    this.note('wire_start');
  }
  method(value) { return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_./:-]{0,127}$/.test(value) ? value : 'invalid-method'; }
  metadata() {
    return {wire_id: this.wireId, child_pid: this.child.pid ?? null, started_at: this.startedAt, elapsed_ms: Math.round(performance.now() - this.started),
      effective_idle_timeout_ms: this.timeoutMs, event_count: this.eventCount, event_methods: Object.fromEntries(this.eventMethods),
      last_event_method: this.lastEventMethod ?? null, last_event_at: this.lastEventAt ?? null,
      matching_event_count: this.matchingEventCount, ignored_event_count: this.ignoredEventCount,
      last_matching_event_method: this.lastMatchingEventMethod ?? null, last_matching_event_at: this.lastMatchingEventAt ?? null,
      waiting_at: this.waitingAt ?? null, last_waiting_at: this.lastWaitingAt ?? null, last_waiting_monotonic_ms: this.lastWaitStarted ?? null,
      quiet_elapsed_ms: this.waitStarted == null ? this.lastWaitMs ?? 0 : Math.round(performance.now() - this.waitStarted),
      termination: this.termination ?? null, exit: this.exit ?? null, closed: Boolean(this.closed)};
  }
  note(kind, fields = {}) { try { this.onTelemetry?.({at: new Date().toISOString(), kind, ...this.metadata(), ...fields}); } catch { /* Metadata failures never retry a model request. */ } }
  matched(event, matches) {
    if (!matches) { this.ignoredEventCount++; return; }
    this.matchingEventCount++; this.lastMatchingEventMethod = this.method(event.method); this.lastMatchingEventAt = new Date().toISOString();
  }
  send(value) {
    if (this.failure) throw this.failure;
    this.child.stdin.write(JSON.stringify(value) + '\n');
  }
  request(method, params = {}, timeoutMs = 30000) {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const started = performance.now(), safeMethod = this.method(method);
      this.note('rpc', {method: safeMethod, phase: 'sent'});
      const timer = setTimeout(() => {
        this.pending.delete(id); this.termination ??= 'rpc_timeout'; this.note('rpc', {method: safeMethod, phase: 'timeout', rpc_elapsed_ms: Math.round(performance.now() - started)}); reject(new Error(`Codex app-server 请求超时: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {resolve, reject, timer, method: safeMethod, started});
      try { this.send({id, method, params}); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  async initialize() {
    await this.request('initialize', {clientInfo: {name: 'dsh_local_codex', title: 'DSH Local Codex', version: VERSION}, capabilities: {experimentalApi: true}});
    this.send({method: 'initialized', params: {}});
    const {account} = await this.request('account/read', {refreshToken: false});
    if (account?.type !== 'chatgpt') throw new Error('此提供方只使用 ChatGPT 登录的 Codex 额度；请先在本机 Codex 登录 ChatGPT。');
  }
  push(event) {
    this.eventCount++; this.lastEventMethod = this.method(event.method); this.lastEventAt = new Date().toISOString();
    const method = this.eventMethods.has(this.lastEventMethod) || this.eventMethods.size < 64 ? this.lastEventMethod : 'other-methods';
    this.eventMethods.set(method, (this.eventMethods.get(method) ?? 0) + 1);
    if (this.waiter) { const waiter = this.waiter; this.waiter = null; waiter.resolve(event); }
    else this.events.push(event);
  }
  next() {
    if (this.events.length) return Promise.resolve(this.events.shift());
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      this.waitStarted = performance.now(); this.waitingAt = new Date().toISOString();
      this.lastWaitStarted = this.waitStarted; this.lastWaitingAt = this.waitingAt;
      const settled = () => { this.lastWaitMs = Math.round(performance.now() - this.waitStarted); this.waitStarted = null; this.waitingAt = null; };
      const timer = setTimeout(() => { this.waiter = null; settled(); this.termination = 'idle_timeout'; this.note('idle_timeout'); reject(new Error('Codex app-server 长时间没有返回事件')); }, this.timeoutMs);
      this.waiter = {resolve: value => { clearTimeout(timer); settled(); resolve(value); }, reject: error => { clearTimeout(timer); settled(); reject(error); }};
    });
  }
  fail(error, category = 'connection_error') {
    if (this.failure) return;
    this.failure = error; this.termination ??= category;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); this.note('rpc', {method: pending.method, phase: 'interrupted', rpc_elapsed_ms: Math.round(performance.now() - pending.started)}); pending.reject(error); }
    this.pending.clear();
    this.waiter?.reject(error); this.waiter = null;
    this.note('wire_failure');
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.signal?.removeEventListener('abort', this.onAbort);
    this.fail(new Error('Codex app-server 连接已关闭'), 'closed');
    this.lines?.close();
    this.child.kill('SIGTERM');
    this.note('wire_close', {termination_signal_requested: 'SIGTERM'});
    const kill = setTimeout(() => { if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL'); }, 1500);
    kill.unref();
  }
}

function findCodex() {
  const candidates = [process.env.DSH_CODEX_BIN,
    '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
    '/Applications/Codex.app/Contents/Resources/codex',
    ...String(process.env.PATH ?? '').split(delimiter).map(path => join(path, 'codex'))];
  const path = candidates.find(path => path && existsSync(path));
  if (!path) throw new Error('未找到本机 Codex，请安装 Codex 并登录 ChatGPT。');
  return path;
}

function alias(name) {
  if (/^[a-zA-Z0-9_-]{1,64}$/.test(name)) return name;
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0,45) + '_' + createHash('sha256').update(name).digest('hex').slice(0,16);
}

export function projectTools(tools = []) {
  const names = new Map();
  const dynamicTools = tools.map(tool => {
    const name = alias(tool.name);
    if (names.has(name)) throw new Error(`工具名称重复: ${tool.name}`);
    names.set(name, tool.name);
    return {type: 'function', name, description: tool.description ?? '', inputSchema: tool.parameters ?? {type: 'object', properties: {}}};
  });
  return {dynamicTools, names};
}

function blocks(content) { return typeof content === 'string' ? [{type: 'text', text: content}] : content ?? []; }
function textOf(content) { return blocks(content).filter(block => block.type === 'text').map(block => block.text).join('\n'); }

/** Replay the DSH log as native Responses items, including real tool call/result pairs. */
export function projectHistory(messages, resolveImage) {
  const answered = new Set(messages.filter(message => message.role === 'tool').map(message => message.toolCallId ?? message.source?.callId));
  const retained = new Set(); const items = []; const instructions = [];
  function contentOf(content, assistant = false) {
    return blocks(content).flatMap(block => {
      if (block.type === 'text') return [{type: assistant ? 'output_text' : 'input_text', text: block.text}];
      if (block.type === 'image') {
        if (!resolveImage) throw new Error('当前无法读取图片附件，请重新附加图片。');
        return [{type: 'input_image', image_url: resolveImage(block.attachment)}];
      }
      if (block.type === 'reasoning' || block.type === 'tool-call') return [];
      throw new Error(`Codex 接入不支持此内容类型: ${block.type}`);
    });
  }
  for (const message of messages) {
    if (message.role === 'system') { instructions.push(textOf(message.content)); continue; }
    if (message.role === 'tool') {
      const callId = message.toolCallId ?? message.source?.callId;
      if (!retained.has(callId)) continue; // Interrupted calls never enter the next request.
      const output = contentOf(message.content);
      if (message.isError) output.unshift({type: 'input_text', text: 'The tool reported an error:'});
      items.push({type: 'function_call_output', call_id: callId, output});
      continue;
    }
    if (message.role === 'assistant') {
      // Preserve interleaved text/tool ordering from the durable DSH log.
      let text = [];
      const flush = () => { if (text.length) { items.push({type: 'message', role: 'assistant', content: contentOf(text, true)}); text = []; } };
      for (const block of blocks(message.content)) {
        if (block.type === 'tool-call') {
          flush();
          if (!answered.has(block.id)) continue;
          retained.add(block.id);
          items.push({type: 'function_call', name: alias(block.name), call_id: block.id,
            arguments: typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments ?? {})});
        } else if (block.type !== 'reasoning') text.push(block);
      }
      flush(); continue;
    }
    if (message.role !== 'user' && message.role !== 'developer') throw new Error(`不支持的消息角色: ${message.role}`);
    const content = contentOf(message.content);
    if (content.length) items.push({type: 'message', role: message.role, content});
  }
  return {items, baseInstructions: instructions.filter(Boolean).join('\n\n')};
}

function metadata(row, cache) {
  const contextWindow = cache?.context_window;
  const efforts = row.supportedReasoningEfforts ?? [];
  return {provider: PROVIDER, id: row.model, name: row.displayName ?? row.model,
    description: row.description ?? '', inputModalities: row.inputModalities ?? ['text', 'image'],
    ...(Number.isInteger(contextWindow) && contextWindow > 0 ? {context: {contextWindow}} : {}),
    ...(efforts.length ? {reasoning: {efforts: efforts.map(e => ({id: e.reasoningEffort, name: e.reasoningEffort === 'xhigh' ? 'Extra High' : e.reasoningEffort[0].toUpperCase() + e.reasoningEffort.slice(1), description: e.description})), defaultEffort: row.defaultReasoningEffort}} : {}),
  };
}

export class CodexAdapter {
  constructor(options = {}) { this.options = {...options, timeoutMs: idleTimeoutMs(options.timeoutMs, 1)}; this.active = new Set(); this.catalog = null; this.catalogAt = 0; }
  providerInfo(provider) { return {id: provider, name: 'Codex · ChatGPT 额度'}; }
  providerRetryPolicy() { return RETRY_POLICY; }
  wire(signal) {
    const wire = new CodexWire({...this.options, signal, onTelemetry: entry => { this.recordTransport(entry); this.options.onTelemetry?.(entry); }});
    this.active.add(wire); return wire;
  }
  release(wire) { wire.close(); this.active.delete(wire); }
  close() { for (const wire of this.active) wire.close(); this.active.clear(); }
  async listModels() {
    if (this.catalog && Date.now() - this.catalogAt < 300000) return this.catalog;
    if (this.loading) return this.loading;
    this.loading = this.fetchCatalog().finally(() => { this.loading = null; });
    return this.loading;
  }
  async fetchCatalog() {
    const wire = this.wire();
    try {
      await wire.initialize();
      const rows = []; let cursor;
      do {
        const result = await wire.request('model/list', {limit: 100, includeHidden: false, ...(cursor ? {cursor} : {})});
        rows.push(...result.data); cursor = result.nextCursor;
      } while (cursor);
      let cache = [];
      try { cache = JSON.parse(readFileSync(join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'models_cache.json'), 'utf8')).models ?? []; } catch {}
      this.catalog = rows.filter(row => !row.hidden).map(row => metadata(row, cache.find(m => m.slug === row.model)));
      this.catalogAt = Date.now();
      return this.catalog;
    } finally { this.release(wire); }
  }
  async resolveModel(_provider, model) {
    const result = (await this.listModels()).find(row => row.id === model);
    if (!result) throw new Error(`本机 Codex 未提供模型 ${model}，请重新选择。`);
    return result;
  }
  async prepareCall(provider, model) { return {model: await this.resolveModel(provider, model), stream: options => this.stream(options)}; }
  stream(options) {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener('abort', onAbort, {once: true});
    const iterator = this.generate({...options, signal: controller.signal});
    const clean = () => options.signal?.removeEventListener('abort', onAbort);
    const step = async (method, value) => { try { const result = await iterator[method](value); if (result.done) clean(); return result; } catch (e) { clean(); throw e; } };
    return {[Symbol.asyncIterator]() { return this; }, next: v => step('next', v), return: v => { controller.abort(); clean(); return step('return', v); }, throw: e => { controller.abort(); clean(); return step('throw', e); }};
  }
  record(entry) {
    if (this.options.audit === false) return;
    try {
      const directory = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'codex-chatgpt');
      mkdirSync(directory, {recursive: true, mode: 0o700});
      appendFileSync(join(directory, 'usage.jsonl'), JSON.stringify({at: new Date().toISOString(), version: VERSION, ...entry}) + '\n', {mode: 0o600});
    } catch { /* Audit failures must not cause a second billable inference request. */ }
  }
  recordTransport(entry) {
    if (this.options.audit === false) return;
    try {
      const directory = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'codex-chatgpt');
      mkdirSync(directory, {recursive: true, mode: 0o700});
      appendFileSync(join(directory, 'transport.jsonl'), JSON.stringify({version: VERSION, ...entry}) + '\n', {mode: 0o600});
    } catch { /* Transport metadata never causes retries or changes inference. */ }
  }
  async *generate(options) {
    let wire; let threadId; let turnId; let usage; let calls = 0; let status = 'error';
    let index = 0; const open = new Map();
    const closeBlocks = function* () {
      for (const block of open.values()) yield {type: 'block-end', index: block.index, block: {type: block.kind, text: block.text}};
      open.clear();
    };
    try {
      if (options.signal.aborted) throw aborted();
      const {dynamicTools, names} = projectTools(options.tools);
      const {items, baseInstructions} = projectHistory(options.messages ?? [], this.options.resolveImage);
      wire = this.wire(options.signal);
      await wire.initialize();
      const start = await wire.request('thread/start', {
        model: options.model, modelProvider: 'openai', allowProviderModelFallback: false,
        serviceTier: 'default', cwd: this.options.cwd ?? homedir(), ephemeral: true,
        approvalPolicy: 'never', config: CONFIG,
        baseInstructions: baseInstructions || 'You are a helpful assistant.',
        developerInstructions: 'The host application DSH owns the conversation log and all tool execution. Use the provided dynamic tools when needed. DSH executes them under its actual sandbox, permission mode and approval flow and returns real results. The external sandbox policy delegates enforcement to DSH; it does not grant authority beyond DSH permissions. Obey any read-only or workspace restrictions DSH supplies. Native Codex file, shell, MCP, browser and agent tools are disabled. Do not invent tool results.',
        dynamicTools, environments: [],
      });
      threadId = start.thread.id;
      if (start.model !== options.model || start.modelProvider !== 'openai') throw new Error('Codex 返回的模型或提供方与所选模型不一致，已停止调用。');
      await wire.request('thread/inject_items', {threadId, items});
      const turn = await wire.request('turn/start', {threadId, input: [], sandboxPolicy: HOST_SANDBOX, ...(options.reasoningEffort ? {effort: options.reasoningEffort} : {}), ...(options.outputSchema ? {outputSchema: options.outputSchema} : {})});
      turnId = turn.turn.id;
      let interrupt;
      for (;;) {
        const event = await wire.next();
        const p = event.params ?? {};
        const matches = !(p.threadId && p.threadId !== threadId || p.turnId && p.turnId !== turnId);
        wire.matched(event, matches);
        if (!matches) continue;
        if (event.method === 'item/tool/call' && event.id != null) {
          const name = names.get(p.tool);
          if (!name) throw new Error(`Codex 请求了未声明的工具: ${p.tool}`);
          yield* closeBlocks();
          const i = index++; const args = JSON.stringify(p.arguments ?? {});
          yield {type: 'block-start', index: i, blockType: 'tool-call'};
          yield {type: 'tool-call-delta', index: i, id: p.callId, name, argumentsDelta: args};
          yield {type: 'block-end', index: i, block: {type: 'tool-call', id: p.callId, name, arguments: args}};
          calls++;
          // Hand execution back to DSH. Never execute or approve a tool inside Codex.
          interrupt ??= wire.request('turn/interrupt', {threadId, turnId}).catch(error => wire.fail(error));
          continue;
        }
        if (event.id != null && event.method) {
          wire.send({id: event.id, error: {code: -32601, message: 'DSH owns tools and approvals; this request is not supported.'}});
          throw new Error(`Codex 请求了不支持的宿主操作: ${event.method}`);
        }
        const isText = event.method === 'item/agentMessage/delta';
        const isReasoning = ['item/reasoning/summaryTextDelta', 'item/reasoning/textDelta'].includes(event.method);
        if (isText || isReasoning) {
          const kind = isText ? 'text' : 'reasoning'; const key = `${p.itemId}:${kind}`;
          let block = open.get(key);
          if (!block) { block = {kind, index: index++, text: ''}; open.set(key, block); yield {type: 'block-start', index: block.index, blockType: kind}; }
          block.text += p.delta;
          yield {type: isText ? 'text-delta' : 'reasoning-delta', index: block.index, text: p.delta};
        }
        if (event.method === 'item/completed' && p.item?.type === 'agentMessage') {
          const key = `${p.item.id}:text`; const block = open.get(key);
          if (block) { yield {type: 'block-end', index: block.index, block: {type: 'text', text: block.text}}; open.delete(key); }
          else if (p.item.text) {
            const i = index++; yield {type: 'block-start', index: i, blockType: 'text'};
            yield {type: 'text-delta', index: i, text: p.item.text};
            yield {type: 'block-end', index: i, block: {type: 'text', text: p.item.text}};
          }
        }
        if (event.method === 'thread/tokenUsage/updated') usage = p.tokenUsage?.last;
        if (event.method === 'error' && !p.willRetry) throw new Error(p.error?.message ?? 'Codex 调用失败');
        if (event.method === 'turn/completed') {
          yield* closeBlocks();
          if (usage) yield {type: 'usage', usage: {inputTokens: Math.max(0, usage.inputTokens - usage.cachedInputTokens), cacheReadTokens: usage.cachedInputTokens, cacheWriteTokens: usage.cacheWriteInputTokens ?? 0, outputTokens: usage.outputTokens, reasoningTokens: usage.reasoningOutputTokens, totalTokens: usage.totalTokens}};
          if (options.signal.aborted) throw aborted();
          if (calls && p.turn.status === 'interrupted') {
            status = 'tool-calls'; yield {type: 'finish', reason: {kind: 'tool-calls'}};
          } else if (p.turn.status === 'completed') {
            status = 'completed'; yield {type: 'finish', reason: {kind: calls ? 'tool-calls' : 'stop'}};
          } else throw new Error(p.turn.error?.message ?? `Codex turn ${p.turn.status}`);
          break;
        }
      }
    } catch (error) {
      yield* closeBlocks();
      status = options.signal.aborted || error.name === 'AbortError' ? 'aborted' : 'error';
      yield {type: 'finish', reason: {kind: status, failure: {code: errorCode(error), message: String(error.message ?? error).slice(0,800)}}};
    } finally {
      if (wire) this.release(wire);
      this.record({model: options.model, effort: options.reasoningEffort ?? null, auth: 'chatgpt', status, toolCalls: calls, ...(usage ? {usage} : {}), ...(wire ? {transport: wire.metadata()} : {})});
    }
  }
}
