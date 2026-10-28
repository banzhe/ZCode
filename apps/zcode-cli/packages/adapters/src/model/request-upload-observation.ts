import { channel } from "node:diagnostics_channel";
import { MODEL_REQUEST_ID_HEADER } from "./model-request-headers.js";

/**
 * 请求体**上传完成**观测：订阅 undici 的 `undici:request:bodySent`，按 `x-request-id` 关联到
 * 本次物理请求。
 *
 * 为什么不用「等到响应头」：fetch 的 resolve 时刻包含服务端排队与首包等待，与 TTFT 重叠，
 * 不能代表客户端发送成本。undici 自 v6.3.0 起在请求体全部写入底层 socket 后发布
 * `undici:request:bodySent`，这是 fetch 客户端能拿到的唯一精确「上传完成」信号。
 *
 * 该信号是**本地发送完成**（写入 socket/流），不是「服务端已收到」：链路缓冲充足时它会早于
 * 服务端读完请求体。缺失时指标必须缺席，不能用响应头时刻冒充。
 *
 * 约束：
 * - 回调在 undici 内部同步执行，必须快且不得抛错。
 * - 按需订阅/注销，注册表有界并带 TTL，避免在无请求时持有全局监听器。
 */
const BODY_SENT_CHANNEL = "undici:request:bodySent";
const MAX_PENDING_OBSERVATIONS = 64;
const PENDING_TTL_MS = 120_000;

interface PendingObservation {
  registeredAt: number;
  settled: boolean;
  onUploaded: (uploadedAtMs: number) => void;
}

const pending = new Map<string, PendingObservation>();
let subscribed = false;

function handler(message: unknown): void {
  try {
    const request = (message as { request?: { headers?: unknown } } | undefined)?.request;
    const requestId = headerValue(request?.headers, MODEL_REQUEST_ID_HEADER);
    if (!requestId) return;
    const observation = pending.get(requestId);
    if (!observation || observation.settled) return;
    observation.settled = true;
    pending.delete(requestId);
    observation.onUploaded(performance.now());
  } catch {
    /* 观测回调不得影响请求 */
  } finally {
    releaseIfIdle();
  }
}

function headerValue(headers: unknown, name: string): string | undefined {
  // undici 诊断消息里的 headers 是扁平数组 [name, value, name, value, ...]；
  // 其它传输/版本可能是 Headers 或普通对象，统一归一化后按小写名查找。
  if (Array.isArray(headers)) {
    for (let index = 0; index + 1 < headers.length; index += 2) {
      const key = headers[index];
      const value = headers[index + 1];
      if (typeof key === "string" && key.toLowerCase() === name && typeof value === "string")
        return value;
    }
    return undefined;
  }
  if (headers && typeof headers === "object") {
    if (typeof (headers as Headers).get === "function") {
      const value = (headers as Headers).get(name);
      return typeof value === "string" && value.length > 0 ? value : undefined;
    }
    for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
      if (key.toLowerCase() === name && typeof value === "string") return value;
    }
  }
  return undefined;
}

function ensureSubscribed(): void {
  if (subscribed) return;
  channel(BODY_SENT_CHANNEL).subscribe(handler);
  subscribed = true;
}

function releaseIfIdle(): void {
  if (!subscribed || pending.size > 0) return;
  channel(BODY_SENT_CHANNEL).unsubscribe(handler);
  subscribed = false;
}

function pruneExpired(now: number): void {
  for (const [requestId, observation] of pending) {
    if (now - observation.registeredAt > PENDING_TTL_MS) pending.delete(requestId);
  }
}

/**
 * 观测一次物理请求的上传完成时刻。
 *
 * 前置：调用方在请求发出前注册，`requestId` 必须是本次请求实际下发的 `x-request-id`。
 * 后置：命中时回调一次（以 `performance.now()` 计时，首次命中生效，重定向不重复计时）。
 * 幂等：`dispose()` 可重复调用；未命中时静默丢弃，不产生指标。
 */
export function observeRequestBodyUpload(
  requestId: string,
  onUploaded: (uploadedAtMs: number) => void,
): () => void {
  const existing = pending.get(requestId);
  if (existing) existing.settled = true;
  const now = performance.now();
  pruneExpired(now);
  if (pending.size >= MAX_PENDING_OBSERVATIONS) {
    // 有界：丢弃最早注册的观测，避免异常链路让注册表无界增长。
    const oldest = pending.keys().next();
    if (!oldest.done) pending.delete(oldest.value);
  }
  const observation: PendingObservation = { registeredAt: now, settled: false, onUploaded };
  pending.set(requestId, observation);
  ensureSubscribed();
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    if (pending.get(requestId) === observation) pending.delete(requestId);
    releaseIfIdle();
  };
}

/** 测试与进程收尾用：清空注册表并注销全局监听。 */
export function disposeRequestBodyUploadObservation(): void {
  pending.clear();
  releaseIfIdle();
}
