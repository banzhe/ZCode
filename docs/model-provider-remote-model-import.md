# 自定义 Provider 远端模型导入（从接口获取模型列表）

## 产品规则

自定义模型 Provider（`access.type === "api-key"`）的详情卡片模型区提供「从接口获取」按钮：

1. 使用该 Provider 已保存的 `api.baseUrl` + `access.apiKey` 调用远端模型列表接口，展示可选模型。
2. 用户多选确认后批量添加为 Personal Model，已存在的模型禁用勾选。
3. 添加时自动配置能力，逐字段取值优先级：
   1. 远端列表接口返回的元数据（`context_length` / `context_window` → 上下文窗口；`top_provider.max_completion_tokens` / `max_output_tokens` / `max_tokens` → 最大输出；`architecture.input_modalities` → 输入模态）；
   2. 内置智能推荐规则（`resolveModelConfig`，`config/provider/zcode-builtin.json`）；
   3. 保守兜底：上下文窗口 200_000；最大输出留空（推荐模式允许缺省）；模态仅文本；推理档位 `["disabled","enabled"]` + `map "{}"`。
4. 远端元数据是 provider 自报事实，优先于内置规则；内置规则补齐缺口；兜底只在两者都缺时使用，不猜测能力。
5. `zhipu-account` access 的 Provider 不提供该按钮。

## 状态所有者

| 状态 | 所有者 | 说明 |
|---|---|---|
| Provider / Model 配置 | Host（Provider Config Service + Registry） | 唯一事实源；导入仅通过既有 `addPersonalModel` 命令写入，不新增写入路径 |
| 远端模型列表 | Host `listRemoteModels` 请求结果 | 只读，不持久化；Renderer 持有选择草稿 |
| 选择草稿 / 对话框状态 | Renderer（`ImportRemoteModelsDialog`） | 局部 UI 状态，不广播 |

## 接口

- `IProviderSettingsService.listRemoteModels({ providerId })` → `{ models: RemoteModelListEntry[] }`。
- `RemoteModelListEntry`：`{ id, contextWindow?, maxOutputTokens?, inputModalities? }`，可选字段一律安全缺省。
- 请求执行：Host 侧（Node fetch），URL 拼接 `${baseUrl}${endsWith("/v1") ? "" : "/v1"}/models`，与 CLI adapters 一致；鉴权头按 `api.type`：openai 系 `Authorization: Bearer`，`anthropic-messages` 用 `x-api-key` + `anthropic-version`；叠加 `api.headers` 自定义头。
- 调用前置边界：与连通性测试一致——`ensureReady()` + `facade.waitForProviderOperations(providerId)`；UI 先提交未保存的连接草稿。

## 验收场景

| # | 场景 | 期望 |
|---|---|---|
| 1 | 端点返回 OpenAI 兼容 `{data:[{id}]}` | 列表展示全部 id，无元数据时走推荐规则/兜底 |
| 2 | 端点返回 OpenRouter 富元数据 | contextWindow/maxOutputTokens/模态按远端值自动配置 |
| 3 | 401 / 404 / 超时 / 网络错误 | 明确错误反馈，不落任何配置 |
| 4 | 返回空列表 | 对话框空态文案 |
| 5 | 模型已存在 | 禁用勾选并标注「已添加」 |
| 6 | 批量添加中途失败 | 已成功项保留；未成功项保持勾选可重试 |
| 7 | zhipu-account Provider | 按钮不渲染 |
| 8 | baseUrl/Key 草稿未保存 | 点击先提交草稿再请求；保存失败则中止 |
