import { describe, expect, it } from "vitest";
import type { SessionRequestMetricsRow } from "@zcode/contracts";
import {
  aggregateSessionRequestMetrics,
  emptySessionRequestMetrics,
} from "../src/zcode-protocol/session-request-metrics.js";

function row(
  id: string,
  metrics: SessionRequestMetricsRow["metrics"],
  outputTokens?: number,
): SessionRequestMetricsRow {
  return { id, startedAt: Number(id.replace(/\D/gu, "")) || 0, metrics, ...(outputTokens === undefined ? {} : { outputTokens }) };
}

describe("session request metrics aggregation", () => {
  it("uses time-weighted averages for both TPS flavours", () => {
    const metrics = aggregateSessionRequestMetrics({
      sessionId: "s",
      rows: [
        // 100 token / 2000ms 生成 → 50 tps；5000ms 含首字 → 20 tps
        row("r1", { providerDurationMs: 5_000, providerTimeToFirstContentMs: 3_000 }, 100),
        // 60 token / 1000ms 生成 → 60 tps；2000ms 含首字 → 30 tps
        row("r2", { providerDurationMs: 2_000, providerTimeToFirstContentMs: 1_000 }, 60),
      ],
    });

    // 时间加权 160 token / 3000ms 生成 = 53.33 tps，而不是算术平均 55。
    expect(metrics.aggregate.tpsSampleCount).toBe(2);
    expect(metrics.aggregate.averageDecodeTps).toBeCloseTo(53.33, 2);
    // 160 token / 7000ms 总时长 = 22.86 tps，而不是算术平均 25。
    expect(metrics.aggregate.averageTpsWithTimeToFirstContent).toBeCloseTo(22.86, 2);
  });

  it("averages TTFT arithmetically and keeps independent sample counts", () => {
    const metrics = aggregateSessionRequestMetrics({
      sessionId: "s",
      rows: [
        row("r1", { providerTimeToFirstContentMs: 800 }, 10),
        row("r2", { providerTimeToFirstContentMs: 1_200 }, 10),
        // 没有 TTFT 的请求只参与别的口径，不拉低 TTFT 平均。
        row("r3", { requestBodyBytes: 500 }, 10),
      ],
    });

    expect(metrics.aggregate.ttftSampleCount).toBe(2);
    expect(metrics.aggregate.averageTimeToFirstContentMs).toBe(1_000);
    expect(metrics.aggregate.requestBodySampleCount).toBe(1);
    expect(metrics.aggregate.tpsSampleCount).toBe(0);
    expect(metrics.aggregate.averageDecodeTps).toBeNull();
  });

  it("accumulates request body bytes and averages them over body samples only", () => {
    const metrics = aggregateSessionRequestMetrics({
      sessionId: "s",
      rows: [
        row("r1", { requestBodyBytes: 1_000 }, 10),
        row("r2", { requestBodyBytes: 3_000, requestBodyUploadMs: 100 }, 10),
        row("r3", { providerDurationMs: 1_000, providerTimeToFirstContentMs: 0 }, 10),
      ],
    });

    expect(metrics.aggregate.requestBodySampleCount).toBe(2);
    expect(metrics.aggregate.totalRequestBodyBytes).toBe(4_000);
    expect(metrics.aggregate.averageRequestBodyBytes).toBe(2_000);
    expect(metrics.aggregate.uploadSampleCount).toBe(1);
    expect(metrics.aggregate.totalRequestBodyUploadMs).toBe(100);
    expect(metrics.aggregate.averageRequestBodyUploadMs).toBe(100);
  });

  it("computes compression ratio only from requests that report both sizes", () => {
    const metrics = aggregateSessionRequestMetrics({
      sessionId: "s",
      rows: [
        row("r1", { requestBodyBytes: 1_000, requestBodyCompressedBytes: 200 }, 10),
        row("r2", { requestBodyBytes: 3_000, requestBodyCompressedBytes: 400 }, 10),
        // 未开启 zstd 的请求只有原始大小，不能把它的字节算进压缩率分母。
        row("r3", { requestBodyBytes: 9_000 }, 10),
      ],
    });

    expect(metrics.aggregate.zstd).toEqual({
      requestCount: 2,
      totalRequestBodyBytes: 4_000,
      totalCompressedBytes: 600,
      compressionRatio: 0.15,
    });
  });

  it("takes the last row for latest values and derives its TPS from the provider clock", () => {
    const metrics = aggregateSessionRequestMetrics({
      sessionId: "s",
      rows: [
        row("r1", { requestBodyBytes: 1_000, providerDurationMs: 5_000, providerTimeToFirstContentMs: 3_000 }, 100),
        row(
          "r2",
          {
            requestBodyBytes: 2_000,
            requestBodyCompressedBytes: 400,
            requestBodyUploadMs: 350,
            providerDurationMs: 4_000,
            providerTimeToFirstContentMs: 1_000,
          },
          150,
        ),
      ],
    });

    expect(metrics.last).toEqual({
      requestBodyBytes: 2_000,
      requestBodyCompressedBytes: 400,
      requestBodyUploadMs: 350,
      decodeTps: 50,
      timeToFirstContentMs: 1_000,
      tpsWithTimeToFirstContent: 37.5,
    });
  });

  it("never invents values for missing or degenerate samples", () => {
    const metrics = aggregateSessionRequestMetrics({
      sessionId: "s",
      rows: [
        // TTFT 大于总时长：生成时长为负，任何 TPS 口径都不成立。
        row("r1", { providerDurationMs: 1_000, providerTimeToFirstContentMs: 2_000 }, 100),
        // 零总时长同理。
        row("r2", { providerDurationMs: 0, providerTimeToFirstContentMs: 0 }, 100),
      ],
    });

    expect(metrics.aggregate.tpsSampleCount).toBe(0);
    expect(metrics.aggregate.averageDecodeTps).toBeNull();
    expect(metrics.aggregate.averageTpsWithTimeToFirstContent).toBeNull();
    expect(metrics.last).toEqual({
      requestBodyBytes: null,
      requestBodyCompressedBytes: null,
      requestBodyUploadMs: null,
      decodeTps: null,
      timeToFirstContentMs: 0,
      tpsWithTimeToFirstContent: null,
    });
  });

  it("empty result is well-formed so the UI can hide the pill", () => {
    const metrics = emptySessionRequestMetrics("s");

    expect(metrics.last).toBeNull();
    expect(metrics.aggregate.requestBodySampleCount).toBe(0);
    expect(metrics.aggregate.totalRequestBodyBytes).toBe(0);
    expect(metrics.aggregate.averageRequestBodyBytes).toBeNull();
    expect(metrics.aggregate.zstd).toEqual({
      requestCount: 0,
      totalRequestBodyBytes: 0,
      totalCompressedBytes: 0,
      compressionRatio: null,
    });
  });
});
