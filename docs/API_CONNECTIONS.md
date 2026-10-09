# API 连接

工作台右上角“API 设置”和画板工具栏的钥匙图标打开同一套连接管理。连接配置存于本机服务端，论文项目只保存连接 ID，不包含 key。

## 新增与使用

1. 点击“新增连接”，填写名称、接口协议、Base URL 和该服务的 key。协议预设会提供地址；可以配置可信网关或本地服务。Base URL 不包含 `/chat/completions` 等具体接口路径。
2. 填写该连接的默认文本模型、默认图片模型。模型 ID 使用该服务自己的命名，不能假定所有供应商都接受 OpenRouter 的 `google/…` 命名。模块里的模型 ID 可以覆盖默认值。
3. 点击“测试连接”读取账户或模型列表，再“保存配置”。测试不生成内容，不证明某个具体模型具有图片生成、视觉输入或结构化输出能力；有些兼容网关未实现模型列表，但允许直接填写模型 ID 后调用。
4. 设置“默认文本连接”“默认图片连接”，点击“保存默认连接”。两者可以来自不同服务。
5. 在论文章节的生成设置中选择“API 连接”和模型，点击“保存配置”。整篇生成按各模块已保存的连接执行。图表模块还可以绑定单独的图片连接和图片模型。
6. 在画板“生成图表 → 方法与模型”中分别选择图片设计、科学分析、视觉设计、元素生成、组装、审查的连接与模型。“使用连接默认模型”批量填入这些连接各自的模型；“质量优先”保留已选连接，不会把其他供应商切回 OpenRouter。Gemma 预设仅用于 OpenRouter。

## 接口范围

| 协议 | 文本与视觉输入 | 图片生成 |
| --- | --- | --- |
| OpenRouter | Chat Completions；保留其 reasoning 等扩展 | Chat Completions 的图片输出 |
| OpenAI 兼容 | 标准 Chat Completions；不发送 OpenRouter 特有扩展 | 可选 Images API 或 Chat Completions 图片输出；Images API 有参考图时使用 multipart edits |
| Gemini 原生 | generateContent，原生 systemInstruction / inlineData | 原生 generateContent 图片输出，过滤思考过程的临时图片 |
| Anthropic 原生 | 官方 SDK Messages API；原生视觉输入、流式收集完整结果、系统提示词缓存 | 不支持；请选择其他图片连接 |

本地 OpenAI 兼容服务可勾选“无需 key”。示例：Ollama 的 `http://localhost:11434/v1`；实际能力仍由部署的模型和服务决定。DeepSeek、其他兼容供应商使用它们提供的地址与模型 ID。AWS Bedrock、Vertex AI、Azure 专用接口、OAuth 登录或非兼容自定义协议需要额外适配，不能仅换 URL 即视为支持。

协议依据：[OpenRouter](https://openrouter.ai/docs/api-reference/overview)、[Gemini](https://ai.google.dev/gemini-api/docs/generate-content/image-generation)、[OpenAI 文本接口](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)、[OpenAI 图片接口](https://developers.openai.com/api/reference/resources/images/methods/edit)、[Anthropic SDK](https://platform.claude.com/docs/en/cli-sdks-libraries/sdks/typescript)。

## 保存、交接与凭据

- 服务端 `.local/api-settings.json` 保存多连接设置，不加密；已忽略版本控制，不应交接给合作者。旧的单 OpenRouter key 文件会在读取时兼容，首次保存连接时升级为多连接格式。
- `.env.local` 的 OpenRouter 配置继续作为兼容入口。未在设置中替换的环境 key 不会复制进新的配置文件。
- 编辑已有连接时，key 留空表示保留。更换地址或协议必须重新输入对应 key；关闭设置会丢弃尚未保存的 key。
- 默认连接需先切换才能删除。删除后旧模块的绑定明确显示“已移除”，不会偷偷改用其他服务，也不删除论文内容。
- 交接论文 JSON 后，接收者应创建自己的连接并重新绑定模块。原服务器的连接 ID 不代表对方机器上存在相同连接。
- 并行生成通过任务内的配置快照隔离各模块的地址与 key。修改配置影响新任务，不切换正在执行任务的凭据。
- 非 OpenRouter 供应商的用量记录在 `outputs/usage/providers.jsonl`；接口未提供实际费用时不推算成 OpenRouter 账单。

回归测试使用隔离的临时目录。多协议单元测试覆盖请求格式、原生图片/视觉解析、密钥隔离、旧配置恢复；网页测试另用本地假接口验证真实后端的逐模块路由，不调用付费供应商。
