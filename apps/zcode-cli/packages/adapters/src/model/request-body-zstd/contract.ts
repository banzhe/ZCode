/**
 * model-request-body-zstd 对外契约：调用方要想正确调用就必须知道的一切都写在这里；其余对外不可见。
 *
 * 唯一意图：为 Provider 的模型请求套上 zstd 请求体压缩层。调用方只关心"开启后请求体被压缩"，
 * 不关心压缩的实现与 Node zlib 细节。
 */
export type ModelRequestBodyZstdFetch = typeof globalThis.fetch;

/**
 * 包装一个模型请求 transport，使请求体以 zstd 发送。
 *
 * 前置：`baseFetch` 为已完成签名/网络装配的 transport；压缩应位于 Option Map 改写之后。
 * 后置：有请求体的请求以 zstd 压缩并设置 `content-encoding: zstd` 与压缩后 `content-length`；
 *       GET/HEAD 与空请求体原样透传。
 * 幂等：每次调用独立压缩，不缓存、不修改输入 Request。
 * 事件：不发出任何事件；不写持久化状态。
 * 失败：读取请求体或压缩失败时以原始错误 reject，不回退为未压缩请求。
 */
export type CreateRequestBodyZstdFetch = (baseFetch: ModelRequestBodyZstdFetch) => ModelRequestBodyZstdFetch;
