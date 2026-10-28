import type { ModelRequestCompletedStatusEvent } from "@zcode/contracts";
import { readRequestObservationId } from "./request-observations.js";
import { observeRequestBodyUpload } from "./request-upload-observation.js";

type ProviderFetch = typeof globalThis.fetch;

const CONTENT_LENGTH_HEADER = "content-length";

/**
 * 单次模型请求的传输指标。字段缺失表示该值无法测量，调用方不得用替代口径填充。
 *
 * - `wireBytes`：真正交给网络 transport 的请求体字节数（开启 zstd 时为压缩后大小）。
 * - `rawBytes` / `compressedBytes`：由 zstd 层观测回调写入的压缩前后大小。
 * - `uploadMs`：交给 transport 到 `undici:request:bodySent` 的耗时（本地发送完成，不含服务端等待）。
 */
export interface ModelRequestBodyMetrics {
  wireBytes?: number;
  rawBytes?: number;
  compressedBytes?: number;
  uploadMs?: number;
}

/**
 * 观测模型请求的请求体大小与上传完成耗时。
 *
 * 只观测、不重建请求体：优先读 `content-length`（zstd 层会显式写成压缩后长度），
 * 否则在 body 是字符串/二进制时取字节长度；其它形态（流式 body）直接跳过，绝不为了测量
 * 消费或复制请求体，也不改变请求本身。
 *
 * 位置：必须在 zstd 层**内层**（压缩之后、网络 transport 之前），这样 `uploadMs` 不含本地压缩，
 * 且 `wireBytes` 等于上线字节。
 */
export function createModelRequestBodyMetricsFetch(
  baseFetch: ProviderFetch,
  metrics: ModelRequestBodyMetrics,
): ProviderFetch {
  return async (input, init) => {
    const bytes = bodyByteLength(input, init);
    if (bytes !== undefined) metrics.wireBytes = bytes;
    const requestId = readRequestObservationId(input, init);
    if (!requestId) return baseFetch(input, init);

    const startedAt = performance.now();
    const dispose = observeRequestBodyUpload(requestId, (uploadedAtMs) => {
      metrics.uploadMs = Math.max(0, uploadedAtMs - startedAt);
    });
    try {
      return await baseFetch(input, init);
    } finally {
      // fetch resolve 于响应头，一定晚于上传完成；这里的 dispose 只是防止注册项泄漏。
      dispose();
    }
  };
}

function bodyByteLength(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): number | undefined {
  const contentLength = contentLengthOf(input, init);
  if (contentLength !== undefined) return contentLength;
  const body = init?.body;
  if (typeof body === "string") return Buffer.byteLength(body);
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  return undefined;
}

function contentLengthOf(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): number | undefined {
  const fromInit = headerOf(init?.headers, CONTENT_LENGTH_HEADER);
  if (fromInit !== undefined) return fromInit;
  if (input instanceof Request) return headerOf(input.headers, CONTENT_LENGTH_HEADER);
  return undefined;
}

function headerOf(headers: HeadersInit | undefined, name: string): number | undefined {
  if (!headers) return undefined;
  const value = new Headers(headers).get(name);
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/**
 * 把观测结果转成完成事件字段：无法测量的值必须缺席，不能写成 0 或「到响应头」时刻。
 * 未开启 zstd 时压缩前后是同一份字节，只报 `requestBodyBytes`。
 *
 * 返回类型直接取自完成事件契约：字段改名时在这里编译失败，而不是让指标静默消失。
 */
export function requestBodyMetricsFields(
  metrics: ModelRequestBodyMetrics | undefined,
): Pick<
  ModelRequestCompletedStatusEvent,
  "requestBodyBytes" | "requestBodyCompressedBytes" | "requestBodyUploadMs"
> {
  if (!metrics) return {};
  const bytes = metrics.rawBytes ?? metrics.wireBytes;
  return {
    ...(bytes !== undefined && Number.isFinite(bytes) && bytes >= 0
      ? { requestBodyBytes: bytes }
      : {}),
    ...(metrics.compressedBytes !== undefined &&
    Number.isFinite(metrics.compressedBytes) &&
    metrics.compressedBytes >= 0
      ? { requestBodyCompressedBytes: metrics.compressedBytes }
      : {}),
    ...(metrics.uploadMs !== undefined && Number.isFinite(metrics.uploadMs) && metrics.uploadMs >= 0
      ? { requestBodyUploadMs: metrics.uploadMs }
      : {}),
  };
}
