# MyCopilot Agent

`agent/` 放和前端解耦的 agent 能力。

当前分层：

```text
agent/
├── rust/                         # Agent runtime：模型请求、协议适配、后续工具执行
└── typescript/                   # 前端可见的 Agent 输入 / 输出 / 状态接口
```

边界规则：

- React 前端只调用 TypeScript agent bridge，不直接请求模型 API。
- Tauri 后端只做系统桥接，不承载 agent 业务逻辑。
- Rust agent crate 不依赖 Tauri / React，可以被桌面端、CLI 或未来服务端复用。
- Agent 输入、输出、状态通过专用协议类型传递，避免组件之间传临时对象。

当前最小闭环：

```text
React ChatComposer
→ agent/typescript bridge
→ Tauri command
→ agent/rust runtime
→ LLM API
→ AgentChatOutput
→ React chat page
```

## Runtime boundary

`agent/rust` 的公共入口是 `send_chat(input)` / `AgentRuntime::send_chat(input)`。
它负责：

- 校验和规整聊天输入
- 注入后端 agent 安全系统提示
- 生成 `runId`、状态事件和非流式 `message_delta`
- 调用 `llm` 模块访问 OpenAI-compatible 或 Anthropic-compatible API，并使用对应的原生 tool/function calling
- 通过只读 `ToolRegistry` 执行工具并把 observation 回灌到下一轮模型调用
- 返回兼容当前前端的 `AgentChatOutput.content`

当前只读工具：

- `workspace_map`: 梳理已选择 workspace 的文件树摘要、语言统计、关键文件和入口/测试/文档候选
- `search_files`: 按 workspace 相对路径或文件名查找文件/目录
- `search_code`: 在 UTF-8 文本文件中搜索内容
- `read_file`: 读取 workspace 内的 UTF-8 文本文件片段，并返回可用于安全编辑的内容 revision
- `read_pdf`: 提取 workspace 内 `.pdf` 文本
- `read_word`: 提取 workspace 内 `.docx` / `.doc` 文本
- `read_presentation`: 提取 workspace 内 `.pptx` / `.ppt` 文本
- `read_spreadsheet`: 提取 workspace 内 `.xlsx` / `.xls` / `.csv` / `.tsv` 文本
- `web_search`: 使用 Tavily 搜索公开网页
- `web_fetch`: 使用 Tavily Extract 抽取公开 HTTP(S) URL 的可读内容
- `git_diff`: 读取当前 workspace 的 Git diff
- `apply_patch`: 以单个待审批 tool call 创建、编辑或删除文本/代码/配置文件；模型提交完整内容或结构化编辑，Rust 生成 unified diff，并在批准、应用失败或拒绝后返回同一 callId 的 tool result
- `run_command`: 请求用户审批后运行 workspace 内命令；agent runtime 不会自动执行

文件类工具都限制在用户已选择的 workspace 内，默认跳过 `.git`、`node_modules`、
`dist`、`build`、`.venv`、`__pycache__`、`.next`、`target` 等目录，并限制文件大小和结果数量。
`.docx`、`.pptx`、`.xlsx` 通过 OOXML zip/XML 解析；`.doc`、`.ppt`、`.xls` 是旧版二进制 Office
格式，当前通过系统 `textutil` 做只读转换，转换器不可用或文件不兼容时会返回明确错误。
`web_search` / `web_fetch` 是外部联网工具，只在 SQLite 配置里的搜索模式不是 `disabled` 且存在 Tavily API Key 时注册。
`web_fetch` 只接受公开 `http://` / `https://` URL，会拒绝 localhost、本地/私有/链路本地 IP、云元数据地址和带用户名密码的 URL。

它暂时不直接执行写文件、应用 patch、任意命令或 Git 修改操作。`apply_patch` / `run_command`
已作为审批型工具注册：模型可以提出 diff 或命令请求，runtime 会返回 `waiting_for_approval`
和对应的 `AgentProposedAction`，用户拒绝时可通过 `AgentApprovalDecision.message`
把拒绝理由或改法要求回灌给 agent。真实 patch 应用和命令执行仍应由 Tauri/Rust 层在用户批准后完成。
`apply_patch` 要求显式声明 `operation=create|update|delete`。create 直接提交完整 `content`；update 可以提交完整
`content`，也可以按顺序提交 `replace`、`insert_before`、`insert_after`、`append`、`prepend` 结构化编辑；delete 只需目标路径。
Rust 会校验唯一锚点、内容 revision 和文件大小，再生成 unified diff 供用户审批。旧 `patch` 参数仅作为高级兼容输入保留，
并会自动补齐末尾换行。支持文本、代码、配置、Markdown、JSON/YAML/TOML/XML/SVG、CSV/TSV、IPYNB 等可 diff 文件；
PDF 和 Office 文件需要专用编辑工具。

## Native tool calling

`agent/rust/src/llm.rs` 会把 `ToolRegistry` 暴露的 `AgentToolDefinition` 转成模型 API 原生工具协议：

- OpenAI-compatible：`tools: [{ type: "function", function: { name, description, parameters } }]`
- Anthropic-compatible：`tools: [{ name, description, input_schema }]`

模型返回的 OpenAI `tool_calls[]` 或 Anthropic `tool_use` block 会被统一解析成内部 `LlmToolCall`，
再映射到协议层 `AgentToolCall` 事件。工具执行结果会按 provider 要求作为 OpenAI `role=tool`
消息或 Anthropic `tool_result` block 回灌给模型。审批型工具先生成 `AgentProposedAction`；host 批准、拒绝或执行失败后，
通过 `AgentToolContinuation` 恢复同一个原生 tool call 生命周期，不把结果伪装成普通 user 消息。

runtime 仍保留旧的文本 JSON tool_call 解析作为兼容兜底，但系统提示已经要求模型使用原生
tool/function calling。

## Protocol notes

协议源头当前是：

- TypeScript: `agent/typescript/src/protocol.ts`
- Rust: `agent/rust/src/protocol.rs`

当前前端入口是：

```text
agent_start_conversation_turn(input: AgentConversationTurnInput) -> AgentConversationTurnOutput
```

前端只提交当前用户输入、conversation/project/model/message id。Tauri 从 SQLite 读取模型配置、
搜索配置、项目 workspace 和数据库历史消息，构建内部 `AgentChatInput` 后调用 `agent/rust`。
`AgentEvent` 通过 Tauri 窗口事件 `agent_event` 推送给前端，`AgentChatOutput` 仍用于审批执行后的
后端回灌结果和内部状态更新。
