# 输入框请求性能药丸

Composer 工具条在上下文指示器（`ChatContextUsage`）**左侧**提供一个请求性能药丸，显示当前会话最近一次主轮模型请求的解码 TPS；悬浮或点按展开详情面板，分「最近一次请求」与「会话平均与累计」两段。

## 数据所有权

唯一所有者是 SQLite `model_usage`：一条行 = 一次物理模型请求。请求指标以 JSON 存在 `request_metrics_json` 列（迁移 `0025_model_request_metrics`），不新建表、不在渲染层保存第二份事实。

```text
adapter transport 观测（请求体字节 / zstd 前后字节 / 上传完成耗时）
  └─ model_request_completed(+requestBodyBytes / requestBodyCompressedBytes / requestBodyUploadMs)
       └─ core recordModelUsageFact → model_usage.request_metrics_json（含 provider 时钟）
            └─ session/debug(scope=requestMetrics) 只读聚合
                 └─ services.readSessionDebug → useSessionRequestMetrics → 药丸 / 面板
```

只统计 `query_source = 'main_turn'` 且写入了请求指标的主轮请求；标题、压缩、子代理等 sidecar 请求不进入统计。「最近一次请求」取这些行里最后写入的一条，因此某一行可能只有 provider 时钟而没有请求体字节。

## 指标口径

### 最近一次请求

| 行 | 取值 |
| --- | --- |
| 解码 TPS | `outputTokens / ((providerDurationMs - providerTimeToFirstContentMs) / 1000)` |
| 首字耗时（TTFT） | `providerTimeToFirstContentMs` |
| 含首字 TPS | `outputTokens / (providerDurationMs / 1000)` |
| 请求体大小 | 压缩前请求体字节数 |
| 请求体发送耗时 | 交给 transport → undici 报告请求体已全部写入底层 socket |
| zstd（本次） | 仅当该请求被压缩：`原始 → 压缩后` |

### 会话平均与累计

| 行 | 取值 |
| --- | --- |
| 平均解码 TPS | `Σ outputTokens / (Σ 生成时长 / 1000)`，**时间加权** |
| 平均含首字 TPS | `Σ outputTokens / (Σ providerDurationMs / 1000)`，**时间加权** |
| 平均首字耗时 | 各请求 TTFT 的**算术平均** |
| 平均请求体 | `totalRequestBodyBytes / requestBodySampleCount` |
| 总请求体 | `Σ requestBodyBytes` |
| 平均请求体发送耗时 | `totalRequestBodyUploadMs / uploadSampleCount` |
| 总请求体发送耗时 | `Σ requestBodyUploadMs` |
| zstd 平均压缩率 | 压缩样本的 `Σ 压缩后 / Σ 原始`，并附两组字节总量 |

- TPS 平均用时间加权：A `100 tok / 2000 ms`、B `60 tok / 1000 ms` ⇒ `160 / 3 s = 53.3 tps`，而不是算术平均 55。短请求不应和长请求等权。
- 首字耗时用算术平均：每次请求只有一次首字等待，没有合理的加权量。
- 请求体、上传耗时、两类 TPS、TTFT **各自独立计数**；样本不足时该行显示占位符，不用其他样本填补，也不把缺失当 0。
- 生成时长 `= 总时长 - 首字耗时`，非正数（缺首字或时钟异常）不参与任何 TPS 口径。

## 「发送耗时」为什么不是「到响应头」

`fetch()` 的 resolve 时刻是**收到响应头**，其中包含服务端排队与首包等待，与 TTFT 重叠，用它当发送耗时会把这部分算成客户端成本。

实测（本地 server，POST JSON，`performance.now()` 打点）：

| 场景 | bodySent | headers |
| --- | --- | --- |
| 1 MB，服务端读完后再等 600 ms | 10.7 ms | 625.8 ms |
| 14 B，服务端等 300 ms | 1.1 ms | 303.0 ms |

因此发送耗时取 undici 诊断通道 `undici:request:bodySent`（自 undici v6.3.0 提供，语义为「请求体已全部写入底层 socket」）。该通道消息里的 `request.headers` 可读到 runner 为每次物理尝试下发的 `x-request-id`，用它完成关联，不新增请求头。

语义边界：`bodySent` 是**本地发送完成**，不是「服务端已收到」。链路缓冲充足时它会早于服务端读完请求体（实测 24 MB 请求在本地 39 ms 报完成，而服务端 861 ms 才读完）。它只表达客户端发送成本，正是这一行要表达的东西。

获取不到信号时（非 undici 传输、无 `x-request-id`、通道缺失）该值为空并显示占位符，**不得**回退成「到响应头」时刻。

## 采集与刷新

- 观测器按需订阅 `undici:request:bodySent`，注册表有界（64 项）并带 120 s TTL，空闲即注销；回调在 undici 内部同步执行，全部包在 `try/catch` 中，绝不改变或吞掉请求结果。
- 请求体大小只观测不重建：优先读 `content-length`（zstd 层写入的是压缩后长度），否则在 body 是字符串/二进制时取字节长度；流式 body 跳过。压缩前字节由 zstd 层的观测回调上报。
- 观测层位于 zstd **内层**，因此上传耗时不包含本地压缩时间。
- UI 不做节拍轮询。刷新触发：会话切换、`usage` 变化（每完成一次主轮请求都会推进 `usage.cumulative`，因此按请求节拍刷新）、回合结束（`phase` 由 `running` 变为其它值，严格晚于 core 的 `model_usage` 写入）。悬浮打开面板不额外读取：面板展示的是同一份完成态事实。

## 持久化与保留

- 指标随 `model_usage` 持久化，进程重启后仍可读；随用量表 30 天保留策略清理，超出后该会话统计归零。
- 升级前的历史行没有 `request_metrics_json`，不进入统计，只影响样本数。面板底部的样本数只统计「有请求体字节」的主轮请求，两类 TPS 与 TTFT 各自另有样本计数，不互相填补。
- 协议字段对旧宿主向后兼容：`sessionDebugSnapshotSchema.requestMetrics` 为可选，缺失时 UI 隐藏药丸；开发者工具面板行为不变。

## 可见性与布局

- 所有用户可见，无数据（没有任何带指标的主轮请求）时整个药丸不渲染。
- 药丸位于模型/思考簇最左侧，与上下文指示器同级；空间不足时按 `data-composer-collapse-priority="3"` 的既有收起契约隐藏（纯观测信息最后才占位）。
- 面板复用上下文面板的外壳；内容超高时按 Radix 可用高度内部滚动，不撑出视口。
- 触摸设备（`hover: none`）在 `pointerdown` 阶段打开面板。

## 验收

1. 完成一次 120 output token、5 s 总时长、2 s 首字的请求后，药丸显示 40 t/s，面板「最近一次请求」同上。
2. 两次请求 `100 tok / 2000 ms` 与 `60 tok / 1000 ms`：平均解码 TPS 为 53.3（时间加权），平均 TTFT 为各请求 TTFT 的算术平均。
3. 上传耗时明显小于请求总时长，且不与 TTFT 数值相同或相加关系。
4. 关闭并重启应用后重新打开该会话，药丸与面板保留同一组数字。
5. 未开启 zstd 的 Provider：压缩相关两行显示占位符，不报错、不影响其他行。
6. 390 / 1200 宽度、深色 / 浅色、中英文下药丸与面板可读，无横向溢出，面板不超出视口。
7. 切换到没有指标的任务后药丸立即消失，不残留上一个任务的数值。

## 已知问题

- 迁移 `0025_model_request_metrics` 是纯 `ADD COLUMN`，没有重放守卫（对照 `0023_session_soft_delete_outcome` 用 `pragma table_info` 查列、`0024_session_database_identity` 用 `CREATE TABLE IF NOT EXISTS`）。当账本 `schema_migration` 缺少该行、而列已存在时（恢复或拷贝的库、账本被重建、迁移改号、多写者竞争），重放会报 `duplicate column name: request_metrics_json`，整个迁移事务失败。当前按已知问题记录、未加守卫，受影响用例为 `apps/zcode-cli/packages/adapters/tests/async-migration-startup.test.ts` 的 SILENTDB-02/04 与 SILENTDB-03。

## 未覆盖

- desktop 真实 provider 的端到端验收（当前仅浏览器夹具 + 单测覆盖）。
- 完整手机配对 / relay 链路验收。
