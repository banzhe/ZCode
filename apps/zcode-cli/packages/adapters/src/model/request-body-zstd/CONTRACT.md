# model-request-body-zstd

意图：Provider 开启 `requestBodyZstd` 后，模型请求体以 zstd 压缩发送。模块只提供一个包装函数，不持有状态。

不变量：

- 压缩位于 Option Map 改写之后、签名与网络 transport 之前。签名输入、鉴权头与 `RawRequestBodyCapture` 始终是压缩前的 JSON 语义。
- 有请求体的请求压缩后设置 `content-encoding: zstd`，并把 `content-length` 改为压缩后字节数。
- `GET` / `HEAD` 与空请求体原样透传，不设置 `content-encoding`。
- 不回退：压缩或读取请求体失败时以原始错误 reject，绝不静默发送未压缩请求。
- 服务端是否支持 zstd 不做探测；由 Provider 开关的使用者负责确认。
- 可选 `observer.onCompressed(rawBytes, compressedBytes)` 只上报压缩前后字节，用于请求性能诊断；回调抛错必须被吞掉，不影响压缩语义与请求结果。

与其它模块的交集：

- 由 `model-execution.ts` 的 `createFactory` 在 `createModelRequestBodyMetricsFetch`（观测层）与 `createProviderBusinessErrorFetch` 之间挂载，仅当 `providerConfig.requestBodyZstd` 为真时启用。
- 压缩层必须位于请求体观测层外侧：观测层因此看到的是上线字节，压缩前字节由本模块的 `observer` 上报。
- 配置来源是 `packages/provider` 的 `api.requestBodyZstd`，本模块不读取配置。
