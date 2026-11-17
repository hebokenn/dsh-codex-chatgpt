# DSH 本机 Codex 模型

在 DSH 输入框的模型菜单中选择 **Codex · ChatGPT 额度** 分组下的 GPT 模型。模型和思考档位从已登录的本机 Codex `model/list` 获取；列表不代表每个模型都已完成推理验证，实际权限以调用结果为准。

使用官方 `codex app-server` 的本机标准输入输出接口。Codex 自行读取、刷新现有 ChatGPT 登录；插件不读取或复制登录令牌，不接收 API Key，不连接第三方模型网关，不自动切换模型。此接入仅用于本机个人使用。

DSH 负责保存对话、执行工具和显示审批。每次模型请求在新的临时 Codex thread 中回放 DSH 的结构化历史；工具请求交回 DSH 执行，后续请求回放真实工具结果。Codex 的独立文件、命令、MCP、技能、子代理和外部环境工具关闭，避免绕过 DSH 的权限流程。取消请求会停止本次 app-server 进程。

模型轮次使用 `externalSandbox`，实际读写与审批继续由 DSH 执行器约束。原先硬编码的 Codex `read-only` 会让模型误以为 DSH 已批准的写入也被禁止；现不再叠加这个错误限制。空 `dynamicTools` 本身不是上游全部原生工具关闭的证明；应按实际 Codex 版本和发送的完整配置验证真正的上游工具清单。

长推理任务可以显式延长等待下一条 app-server 事件的时限，避免仅因较长静默间隙而提前结束。默认仍为 **180000 毫秒**；插件配置 `idleTimeoutMs` 接受 **1000–3600000** 的整数毫秒，错误值在加载时拒绝。例如在已有 `codex-chatgpt` 插件条目中设置：

```yaml
config:
  idleTimeoutMs: 600000
```

这是当前 profile 中该适配器的等待配置，会影响使用它的请求；不是按课程自动变化，也不代表调用免费或取消预算。临时任务结束可恢复 180000。RPC 请求仍为原来的 30 秒上限，课程宿主的总执行上限、暂停和取消独立生效。普通 RPC 响应不刷新事件等待；未知通知会刷新等待，但不会被伪造成可见推理或心跳。当前 Adapter 在插件加载时创建，安全节点冷启动后再核对实际生效值。

安装为普通 DSH profile 插件；无需修改应用包或新增常驻网关。安装位置：`~/.dsh/profiles/desktop/node_modules/dsh-codex-chatgpt`。停用或移除可在 DSH 插件页操作。

诊断记录：`~/.dsh/codex-chatgpt/usage.jsonl` 保存所选模型、思考档位、结果、工具次数、实际返回的官方 token 用量和传输元数据摘要。`transport.jsonl` 只记录 RPC 方法与阶段、时间与耗时、最后通知方法与数量、静默等待、有效时限、wire/子进程标识和实际退出/取消类别；不保存参数、正文、推理 delta、stderr 或凭据。子进程退出单独记录，不把发送终止信号冒充已退出。诊断写入失败不会发起第二次模型调用。未返回用量继续保持未知，不能填成零；token 数量不等于 ChatGPT 额度百分比。

0.1.2 增加显式静默等待配置和上述元数据；0.1.1 的宿主权限行为保持。开发回归使用本地假 app-server：`node --test test/*.test.mjs`，不调用真实模型。

基线：macOS / DSH 0.2.1-rc.3 / Codex 0.166.0-alpha.6。App-server 的动态工具和历史注入接口属于实验接口；未来 Codex 或 DSH 升级可能需要适配。每次模型请求重建临时 thread 会产生启动开销，DSH 保持完整对话和工具记录。

官方协议：[Codex App Server](https://learn.chatgpt.com/docs/app-server)。
