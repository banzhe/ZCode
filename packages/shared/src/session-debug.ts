import { z } from "zod";

export const SESSION_DEBUG_LIMITS = { rounds: 200, network: 100, dedupe: 2000 } as const;

/**
 * `requestMetrics` scope 只返回持久化的请求指标，不带 rounds/networkEntries；
 * 缺省（`all`）保持既有 live 观测快照语义。
 */
export const SESSION_DEBUG_SCOPE_ALL = "all";
export const SESSION_DEBUG_SCOPE_REQUEST_METRICS = "requestMetrics";
export const SESSION_DEBUG_SCOPES = [
  SESSION_DEBUG_SCOPE_ALL,
  SESSION_DEBUG_SCOPE_REQUEST_METRICS,
] as const;
export type SessionDebugScope = (typeof SESSION_DEBUG_SCOPES)[number];
export const sessionDebugParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    scope: z.enum(SESSION_DEBUG_SCOPES).optional(),
  })
  .strict();
const count = z.number().finite().nonnegative();
const debugUsageSchema = z
  .object({
    inputTokens: count.optional(),
    outputTokens: count.optional(),
    totalTokens: count.optional(),
    reasoningTokens: count.optional(),
    cachedInputTokens: count.optional(),
    cachedWriteInputTokens: count.optional(),
  })
  .strict();
export const sessionDebugRoundSchema = z
  .object({
    eventKey: z.string(),
    requestId: z.string(),
    requestIndex: count,
    recordedAt: count,
    usage: debugUsageSchema,
    hitRate: count.nullable(),
    generationDurationMs: count.nullable(),
    tokensPerSecond: count.nullable(),
  })
  .strict();
export const sessionDebugNetworkEntrySchema = z
  .object({
    eventKey: z.string(),
    traceId: z.string(),
    recordedAt: count,
    statusType: z.enum([
      "model_request_started",
      "model_request_completed",
      "model_request_failed",
      "model_retry_scheduled",
      "model_stream_stalled",
    ]),
    requestId: z.string().optional(),
    providerId: z.string().optional(),
    modelId: z.string().optional(),
    providerKind: z.string().optional(),
    transport: z.string().optional(),
    baseURL: z.string().optional(),
    querySource: z.string().optional(),
    queryId: z.string().optional(),
    timestamp: z.string().optional(),
    attempt: count.optional(),
    maxAttempts: count.optional(),
    nextAttempt: count.optional(),
    retryable: z.boolean().optional(),
    statusCode: count.optional(),
    durationMs: count.optional(),
    delayMs: count.optional(),
    idleMs: count.optional(),
    timeoutMs: count.optional(),
    reason: z.string().optional(),
    message: z.string().optional(),
    requestHeaders: z.record(z.string(), z.string()),
    responseHeaders: z.record(z.string(), z.string()),
    requestHeaderCount: count,
    responseHeaderCount: count,
  })
  .strict();
/**
 * 会话级请求指标（持久化，来自 `model_usage`，随 30 天用量保留清理）。
 *
 * - `last`：最近一条带指标的主轮请求，全部按 provider 时钟取原始值，派生值由调用方计算。
 * - `aggregate`：会话累计与平均。请求体、上传耗时、TPS/TTFT 各自独立样本计数，
 *   样本不足时不互相填补，缺失一律 `null`。
 * - `requestBodyUploadMs` 是**上传完成**（客户端把请求体写入底层 socket）耗时，
 *   不是「到响应头」；后者包含服务端排队与 TTFT，不能用来代表发送成本。
 */
export const sessionRequestMetricsSchema = z
  .object({
    sessionId: z.string(),
    last: z
      .object({
        requestBodyBytes: count.nullable(),
        requestBodyCompressedBytes: count.nullable(),
        requestBodyUploadMs: count.nullable(),
        decodeTps: count.nullable(),
        timeToFirstContentMs: count.nullable(),
        tpsWithTimeToFirstContent: count.nullable(),
      })
      .strict()
      .nullable(),
    aggregate: z
      .object({
        requestBodySampleCount: count,
        totalRequestBodyBytes: count,
        averageRequestBodyBytes: count.nullable(),
        uploadSampleCount: count,
        totalRequestBodyUploadMs: count,
        averageRequestBodyUploadMs: count.nullable(),
        tpsSampleCount: count,
        averageDecodeTps: count.nullable(),
        averageTpsWithTimeToFirstContent: count.nullable(),
        ttftSampleCount: count,
        averageTimeToFirstContentMs: count.nullable(),
        zstd: z
          .object({
            requestCount: count,
            totalRequestBodyBytes: count,
            totalCompressedBytes: count,
            /** 压缩后 / 原始；仅统计同时报告两者的请求。 */
            compressionRatio: count.nullable(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();
export const sessionDebugSnapshotSchema = z
  .object({
    sessionId: z.string(),
    rounds: z.array(sessionDebugRoundSchema).max(SESSION_DEBUG_LIMITS.rounds),
    networkEntries: z.array(sessionDebugNetworkEntrySchema).max(SESSION_DEBUG_LIMITS.network),
    cache: z
      .object({
        hitRateRequestCount: count,
        totalInputTokens: count,
        totalCacheReadTokens: count,
        hitRate: count.nullable(),
      })
      .strict()
      .nullable(),
    // additive：旧宿主不返回该键，UI 视为「无请求指标」；strict 解析仍需保留可选。
    requestMetrics: sessionRequestMetricsSchema.optional(),
  })
  .strict();
export type SessionDebugSnapshot = z.infer<typeof sessionDebugSnapshotSchema>;
export type SessionDebugNetworkEntry = z.infer<typeof sessionDebugNetworkEntrySchema>;
export type SessionRequestMetrics = z.infer<typeof sessionRequestMetricsSchema>;

/** 输出 token 与首输出到请求结束的同源时间；未知值不能用请求总耗时替代。 */
export function calculateOutputTps(
  outputTokens: number | undefined,
  generationDurationMs: number | null,
): number | null {
  if (
    outputTokens === undefined ||
    !Number.isFinite(outputTokens) ||
    outputTokens < 0 ||
    generationDurationMs === null ||
    !Number.isFinite(generationDurationMs) ||
    generationDurationMs <= 0
  )
    return null;
  const tps = (outputTokens * 1000) / generationDurationMs;
  return Number.isFinite(tps) ? tps : null;
}
