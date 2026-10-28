import { calculateOutputTps, type SessionRequestMetrics } from "@zcode/shared";
import type { SessionRequestMetricsRow } from "@zcode/contracts";

/**
 * 把 `model_usage` 的请求指标行聚合成请求性能面板直接可用的协议值。
 *
 * 口径（与 `docs/ui/composer-request-metrics.md` 一致）：
 * - 解码 TPS / 含首字 TPS 的**平均**用时间加权（Σ outputTokens ÷ Σ 时长），避免短请求拉偏；
 *   单值仍按 provider 时钟算，和开发者工具面板同一公式。
 * - 首字耗时平均用算术平均：每次请求只有一次首字等待，没有合理的加权量。
 * - 请求体、上传耗时、两类 TPS、TTFT 各自独立样本计数；缺样本时不互相填补，一律 `null`。
 */
export function aggregateSessionRequestMetrics(input: {
  sessionId: string;
  rows: readonly SessionRequestMetricsRow[];
}): SessionRequestMetrics {
  let requestBodySampleCount = 0;
  let totalRequestBodyBytes = 0;
  let uploadSampleCount = 0;
  let totalRequestBodyUploadMs = 0;
  let ttftSampleCount = 0;
  let totalTtftMs = 0;
  let zstdRequestCount = 0;
  let zstdTotalRequestBodyBytes = 0;
  let zstdTotalCompressedBytes = 0;
  // 解码口径的样本：outputTokens + 正数生成时长。
  let decodeSampleCount = 0;
  let decodeTotalOutputTokens = 0;
  let decodeTotalGenerationMs = 0;
  // 含首字口径的样本：outputTokens + 正数 provider 请求总时长。
  let withTtftSampleCount = 0;
  let withTtftTotalOutputTokens = 0;
  let withTtftTotalDurationMs = 0;

  for (const row of input.rows) {
    const metrics = row.metrics;
    const bodyBytes = nonNegative(metrics.requestBodyBytes);
    if (bodyBytes !== undefined) {
      requestBodySampleCount += 1;
      totalRequestBodyBytes += bodyBytes;
    }
    const uploadMs = nonNegative(metrics.requestBodyUploadMs);
    if (uploadMs !== undefined) {
      uploadSampleCount += 1;
      totalRequestBodyUploadMs += uploadMs;
    }
    const compressedBytes = nonNegative(metrics.requestBodyCompressedBytes);
    // 压缩率只在同时拿到原始与压缩后字节的请求上计算，避免半份数据凑出比值。
    if (compressedBytes !== undefined && bodyBytes !== undefined) {
      zstdRequestCount += 1;
      zstdTotalRequestBodyBytes += bodyBytes;
      zstdTotalCompressedBytes += compressedBytes;
    }
    const ttftMs = nonNegative(metrics.providerTimeToFirstContentMs);
    if (ttftMs !== undefined) {
      ttftSampleCount += 1;
      totalTtftMs += ttftMs;
    }
    const durationMs = nonNegative(metrics.providerDurationMs);
    const outputTokens = nonNegative(row.outputTokens);
    if (outputTokens === undefined) continue;
    // 首字耗时不能晚于请求总时长：这是时钟不一致，不是「慢」，任何 TPS 口径都不成立。
    const coherentClock = ttftMs === undefined || durationMs === undefined || ttftMs <= durationMs;
    if (!coherentClock) continue;
    // 生成时长 = 请求总时长 - 首字等待；非正数（缺首字、时钟异常）不参与任何 TPS 口径。
    if (durationMs !== undefined && ttftMs !== undefined && durationMs > ttftMs) {
      decodeSampleCount += 1;
      decodeTotalOutputTokens += outputTokens;
      decodeTotalGenerationMs += durationMs - ttftMs;
    }
    if (durationMs !== undefined && durationMs > 0) {
      withTtftSampleCount += 1;
      withTtftTotalOutputTokens += outputTokens;
      withTtftTotalDurationMs += durationMs;
    }
  }

  return {
    sessionId: input.sessionId,
    last: lastRequestMetrics(input.rows),
    aggregate: {
      requestBodySampleCount,
      totalRequestBodyBytes,
      averageRequestBodyBytes:
        requestBodySampleCount > 0 ? totalRequestBodyBytes / requestBodySampleCount : null,
      uploadSampleCount,
      totalRequestBodyUploadMs,
      averageRequestBodyUploadMs:
        uploadSampleCount > 0 ? totalRequestBodyUploadMs / uploadSampleCount : null,
      tpsSampleCount: decodeSampleCount,
      averageDecodeTps:
        decodeSampleCount > 0 ? (decodeTotalOutputTokens * 1000) / decodeTotalGenerationMs : null,
      averageTpsWithTimeToFirstContent:
        withTtftSampleCount > 0
          ? (withTtftTotalOutputTokens * 1000) / withTtftTotalDurationMs
          : null,
      ttftSampleCount,
      averageTimeToFirstContentMs: ttftSampleCount > 0 ? totalTtftMs / ttftSampleCount : null,
      zstd: {
        requestCount: zstdRequestCount,
        totalRequestBodyBytes: zstdTotalRequestBodyBytes,
        totalCompressedBytes: zstdTotalCompressedBytes,
        compressionRatio:
          zstdRequestCount > 0 && zstdTotalRequestBodyBytes > 0
            ? zstdTotalCompressedBytes / zstdTotalRequestBodyBytes
            : null,
      },
    },
  };
}

/** 空指标：无 session 行、store 无该能力或尚未采集到任何请求时的唯一返回形状。 */
export function emptySessionRequestMetrics(sessionId: string): SessionRequestMetrics {
  return aggregateSessionRequestMetrics({ sessionId, rows: [] });
}

function lastRequestMetrics(
  rows: readonly SessionRequestMetricsRow[],
): SessionRequestMetrics["last"] {
  const last = rows.at(-1);
  if (!last) return null;
  const metrics = last.metrics;
  const durationMs = nonNegative(metrics.providerDurationMs);
  const ttftMs = nonNegative(metrics.providerTimeToFirstContentMs);
  const outputTokens = nonNegative(last.outputTokens);
  const generationMs =
    durationMs !== undefined && ttftMs !== undefined ? durationMs - ttftMs : null;
  // 首字晚于总时长属于时钟不一致，两个 TPS 口径都不能给出数字。
  const coherentClock = ttftMs === undefined || durationMs === undefined || ttftMs <= durationMs;
  return {
    requestBodyBytes: nonNegative(metrics.requestBodyBytes) ?? null,
    requestBodyCompressedBytes: nonNegative(metrics.requestBodyCompressedBytes) ?? null,
    requestBodyUploadMs: nonNegative(metrics.requestBodyUploadMs) ?? null,
    decodeTps: calculateOutputTps(outputTokens, generationMs),
    timeToFirstContentMs: ttftMs ?? null,
    tpsWithTimeToFirstContent:
      coherentClock && outputTokens !== undefined && durationMs !== undefined && durationMs > 0
        ? (outputTokens * 1000) / durationMs
        : null,
  };
}

function nonNegative(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value < 0) return undefined;
  return value;
}
