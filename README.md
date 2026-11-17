# DSH 本机 Codex 模型

**在 DSH 里直接选择由本机 Codex / ChatGPT 账号提供的 GPT 模型，不必另配 OpenAI API Key，也不必部署一层第三方模型网关。**

这个插件把本机 Codex 的模型能力接到 DSH 的模型菜单中。它适合已经安装并登录 Codex、希望在 DSH 对话中使用自己账号可用模型的人。

> **先说明：**插件不会显示 ChatGPT 订阅的剩余百分比或保证某个模型一定可用。模型列表来自 Codex 返回的可用模型信息；最终是否有权限、额度是否充足，以实际请求结果和你的 Codex / ChatGPT 账号为准。它也不会增加额度、绕过套餐限制，或让 ChatGPT 订阅变成通用 API 额度。

## 它解决什么问题？

DSH 默认通过配置好的模型服务商调用模型。若你已有本机 Codex 和 ChatGPT 登录，通常还需要为 DSH 单独设置 API Key 或连接另一个服务入口。此插件提供另一条接入方式：让 DSH 通过本机 Codex App Server 使用当前 ChatGPT 登录可用的模型，并读取其提供的模型及推理档位。

## 使用方式

1. 在 DSH 模型菜单中选择 **Codex · ChatGPT 登录** 分组下的模型。
2. 如果该模型支持推理档位，可在 DSH 中选择相应档位。
3. 像平常一样在 DSH 对话；工具和审批仍由 DSH 处理。

需要先在本机安装支持 `app-server` 的 Codex，并登录 ChatGPT。插件不包含 Codex，也不提供账号或模型额度。

## 工作原理

1. **查询模型：**插件在本机启动官方 `codex app-server`，通过标准输入输出接口请求 `model/list`，将 Codex 返回的模型名称、描述和支持的推理档位提供给 DSH。
2. **发送对话：**每次模型请求都会创建一个临时 Codex thread，并把 DSH 保存的结构化对话历史交给它。会话记录和工具结果仍以 DSH 为准。
3. **交还工具：**插件把 DSH 提供的工具作为动态工具交给 Codex。Codex 请求调用工具时，插件把请求交回 DSH 执行；实际执行与审批遵循 DSH 当前的权限和工作区限制，不由插件在 Codex 里另行执行。
4. **使用本机登录：**插件不读取或复制 Codex 登录令牌，不要求填写 API Key。认证和与模型服务的连接由 Codex 客户端按其自身机制处理。

## 安装与配置

将此仓库作为 DSH 插件安装并启用。插件需要 Node.js 22 或更高版本，以及本机可运行、已登录 ChatGPT 且支持 `app-server` 的 Codex。若 Codex 不在常见安装位置或 `PATH` 中，可通过环境变量 `DSH_CODEX_BIN` 指定可执行文件路径。

默认的事件静默等待时限为 **180 秒**。长推理任务可按需调整为 1 秒至 1 小时，例如：

```yaml
config:
  idleTimeoutMs: 600000
```

这是当前 profile 中此适配器的等待设置，会影响使用它的请求；不代表模型调用免费，也不会取消账号套餐、预算或 DSH 自身的执行上限。调整插件配置后需重新加载插件才能生效。

## 隐私与权限边界

- 插件通过本机 Codex App Server 通信，不直接连接第三方模型网关；但**对话内容仍会由 Codex 按其官方客户端机制发送给模型服务**。请按 Codex / ChatGPT 的数据处理规则使用。
- Codex 自己读取和刷新现有 ChatGPT 登录；插件会移除传给子进程的常见 OpenAI / Codex API Key 与自定义网关环境变量，避免意外用它们作为这条通道的凭据。
- DSH 继续保存对话、执行工具并控制审批。插件向 Codex App Server 显式发送关闭文件/命令执行、MCP、技能和子代理等原生能力的配置；模型使用的是 DSH 传入的动态工具，工具调用会交回 DSH。由于这些开关依赖 Codex 的实验性接口，不应把“未传入动态工具”单独当作所有 Codex 原生工具都已关闭的证明。
- 诊断文件位于 `~/.dsh/codex-chatgpt/`。`usage.jsonl` 保存所选模型、推理档位、结果、工具次数及服务返回的 token 用量（若有）；`transport.jsonl` 保存 RPC 阶段、耗时、事件计数、超时和进程退出等元数据。它们不保存提示词、对话正文、推理文本、工具参数、stderr 或凭据。token 用量不是 ChatGPT 额度百分比；服务未返回用量时保持未知。

## 已知限制

- 模型和推理档位取决于本机 Codex 登录及账号当前权限；列表出现不等于实际调用必然成功。
- 插件依赖 Codex App Server 的实验性接口。Codex 或 DSH 升级后可能需要适配。
- 每次模型请求都会启动本机 app-server 并建立临时 thread，可能比常驻连接多一些启动耗时；完整对话历史仍由 DSH 保留。
- 本机测试使用模拟 app-server，不会调用真实模型：`node --test test/*.test.mjs`。

已验证基线：macOS、DSH 0.2.1-rc.3、Codex 0.166.0-alpha.6。

English summary: This DSH bundle exposes models available to your locally signed-in Codex ChatGPT account in DSH's model picker. Codex handles authentication and model-service communication; DSH retains conversation history, tool execution, and approval control. It does not report remaining subscription quota or expand account entitlements.

官方协议：[Codex App Server](https://learn.chatgpt.com/docs/app-server)。
