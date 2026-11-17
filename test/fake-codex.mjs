import {createInterface} from 'node:readline';
const mode = process.argv[2];
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const event = (method, params) => send({method, params});
let model,thread;
createInterface({input: process.stdin}).on('line', line => {
  const message = JSON.parse(line);
  if (!message.id) return;
  const {id, method, params: p} = message;
  const result = value => send({id, result: value});
  if (method === 'initialize') return result({});
  if (method === 'account/read') return result({account: {type: mode === 'auth' ? 'apikey' : 'chatgpt'}});
  if (method === 'model/list') return result({data: [{model: 'gpt-test', displayName: 'GPT Test', supportedReasoningEfforts: [{reasoningEffort: 'low', description: 'Fast'}], defaultReasoningEffort: 'low'}], nextCursor: null});
  if (method === 'thread/start') { thread=p;model = p.model; return result({thread: {id: 'thread-test'}, model: mode === 'fallback' ? 'different-model' : model, modelProvider: 'openai'}); }
  if (method === 'thread/inject_items') return result({});
  if (method === 'ping' && mode === 'rpc-only') return setTimeout(() => result({}), 5);
  if (method === 'turn/interrupt') {
    result({});
    event('thread/tokenUsage/updated', {threadId: 'thread-test', turnId: 'turn-test', tokenUsage: {last: {inputTokens: 20, cachedInputTokens: 5, outputTokens: 3, reasoningOutputTokens: 0, totalTokens: 23}}});
    event('turn/completed', {threadId: 'thread-test', turn: {id: 'turn-test', status: 'interrupted'}});
    return;
  }
  if (method === 'turn/start') {
    if(mode==='host-permission'){
      const safe=thread.sandbox===undefined&&p.sandboxPolicy?.type==='externalSandbox'&&p.sandboxPolicy?.networkAccess==='enabled'&&
        ['features.shell_tool','features.unified_exec','features.apply_patch_freeform','features.multi_agent'].every(k=>thread.config[k]===false)&&
        thread.developerInstructions.includes('beyond DSH permissions');
      if(!safe)return send({id,error:{message:'Host permission delegation or native-tool boundary was lost'}});
    }
    result({turn: {id: 'turn-test'}});
    const base = {threadId: 'thread-test', turnId: 'turn-test'};
    if (mode === 'unknown-reasoning') for (const delay of [90, 180, 270]) setTimeout(() => event('item/reasoning/opaquePartAdded', {...base, delta: 'PRIVATE_REASONING_SENTINEL'}), delay);
    setTimeout(() => {
      if (mode === 'hang' || mode === 'rpc-only') return;
      if (mode === 'tool') { send({id: 100, method: 'item/tool/call', params: {...base, callId: 'call-test', tool: 'lookup', arguments: {key: 'nonce'}}}); return; }
      if (mode === 'error') { event('turn/completed', {...base, turn: {status: 'failed', error: {message: 'usage limit reached'}}}); return; }
      event('item/agentMessage/delta', {...base, itemId: 'item-test', delta: 'bridge '});
      event('item/agentMessage/delta', {...base, itemId: 'item-test', delta: 'ok'});
      event('item/completed', {...base, item: {type: 'agentMessage', id: 'item-test', text: 'bridge ok', phase: 'final_answer'}});
      event('thread/tokenUsage/updated', {...base, tokenUsage: {last: {inputTokens: 20, cachedInputTokens: 5, cacheWriteInputTokens: 0, outputTokens: 3, reasoningOutputTokens: 1, totalTokens: 23}}});
      event('turn/completed', {...base, turn: {id: 'turn-test', status: 'completed'}});
    }, mode === 'delayed' ? 240 : mode === 'unknown-reasoning' ? 360 : 5);
    return;
  }
  send({id, error: {message: 'Unexpected method ' + method}});
});
