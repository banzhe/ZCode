/**
 * model-request-body-zstd 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 */
import type { CreateRequestBodyZstdFetch, ModelRequestBodyZstdFetch } from "./contract.js";

export function exampleWrapProviderTransport(
  create: CreateRequestBodyZstdFetch,
  baseTransport: ModelRequestBodyZstdFetch,
  enabled: boolean,
): ModelRequestBodyZstdFetch {
  // 仅在 Provider 开启 requestBodyZstd 时包装；未开启时直接使用原 transport。
  return enabled ? create(baseTransport) : baseTransport;
}
