import {readFileSync} from 'node:fs';
import {CodexAdapter, PROVIDER, idleTimeoutMs} from './bridge.mjs';

export const name = 'codex-chatgpt';
export const inject = ['llm'];
export function adapterConfig(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Codex ChatGPT 配置必须是对象。');
  if (Object.keys(value).some(key => key !== 'idleTimeoutMs')) throw new TypeError('Codex ChatGPT 只支持显式 idleTimeoutMs 等待配置。');
  return {idleTimeoutMs: idleTimeoutMs(value.idleTimeoutMs)};
}
// Cordis consumes the Standard Schema contract; no extra runtime dependency.
export const Config = {'~standard': {version: 1, vendor: 'dsh-codex-chatgpt', validate(value) {
  try { return {value: adapterConfig(value)}; } catch (error) { return {issues: [{message: error.message}]}; }
}}};

export function apply(ctx, config = {}) {
  const settings = adapterConfig(config);
  const adapter = new CodexAdapter({
    timeoutMs: settings.idleTimeoutMs,
    resolveImage(ref) {
      const attachments = ctx.get('attachments');
      const path = attachments?.imageHostPath(ref);
      if (!path) throw new Error('无法读取此图片附件，请重新附加图片。');
      return `data:${ref.mediaType ?? 'image/png'};base64,${readFileSync(path).toString('base64')}`;
    },
  });
  ctx.llm.registerAdapter([PROVIDER], adapter);
  ctx.effect(() => () => adapter.close(), 'codex-chatgpt: app-server processes');
}
