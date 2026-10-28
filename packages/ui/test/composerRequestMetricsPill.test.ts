import { describe, expect, it } from "vitest";
import type { SessionRequestMetrics } from "@zcode/shared";
import {
  buildRequestMetricsRows,
  formatCompressionPercent,
  formatDurationMs,
  formatTokensPerSecond,
  hasRequestMetricsData,
} from "@/chat-input-toolbar/RequestMetricsPill.js";

/** 只校验 id 与数值：文案由 locale 文件维护，测试不重复抄写。 */
function makeIntl(messages: Record<string, string>) {
  return {
    formatMessage: (
      descriptor: { id: string },
      values?: Record<string, string | number>,
    ): string => {
      const template = messages[descriptor.id] ?? descriptor.id;
      return template.replace(/\{(\w+)\}/gu, (_match, key: string) =>
        String(values?.[key] ?? `{${key}}`),
      );
    },
  } as unknown as Parameters<typeof buildRequestMetricsRows>[1];
}

const intl = makeIntl({
  "chat.requestMetrics.zstdSizes": "{raw} → {compressed}",
});

function metrics(overrides: Partial<SessionRequestMetrics["aggregate"]> = {}, last?: SessionRequestMetrics["last"]): SessionRequestMetrics {
  return {
    sessionId: "s",
    last: last ?? null,
    aggregate: {
      requestBodySampleCount: 0,
      totalRequestBodyBytes: 0,
      averageRequestBodyBytes: null,
      uploadSampleCount: 0,
      totalRequestBodyUploadMs: 0,
      averageRequestBodyUploadMs: null,
      tpsSampleCount: 0,
      averageDecodeTps: null,
      averageTpsWithTimeToFirstContent: null,
      ttftSampleCount: 0,
      averageTimeToFirstContentMs: null,
      zstd: {
        requestCount: 0,
        totalRequestBodyBytes: 0,
        totalCompressedBytes: 0,
        compressionRatio: null,
      },
      ...overrides,
    },
  };
}

describe("request metrics formatting", () => {
  it("formats tps with one decimal and never invents a value", () => {
    expect(formatTokensPerSecond("en-US", 42.14)).toBe("42.1");
    expect(formatTokensPerSecond("en-US", 0)).toBe("0");
    expect(formatTokensPerSecond("en-US", null)).toBe("—");
    expect(formatTokensPerSecond("en-US", Number.NaN)).toBe("—");
  });

  it("switches duration unit at one second", () => {
    expect(formatDurationMs("en-US", 850)).toBe("850 ms");
    expect(formatDurationMs("en-US", 1_234)).toBe("1.2 s");
    expect(formatDurationMs("en-US", null)).toBe("—");
  });

  it("formats the compression ratio as compressed over original", () => {
    expect(formatCompressionPercent("en-US", 0.17)).toBe("17%");
    expect(formatCompressionPercent("zh-CN", 0.1712)).toBe("17.1%");
    expect(formatCompressionPercent("en-US", null)).toBe("—");
  });
});

describe("request metrics panel rows", () => {
  it("renders the latest request section with provider values and upload time", () => {
    const rows = buildRequestMetricsRows(
      metrics(
        { requestBodySampleCount: 1, totalRequestBodyBytes: 1_200_000 },
        {
          requestBodyBytes: 1_200_000,
          requestBodyCompressedBytes: 200_000,
          requestBodyUploadMs: 320,
          decodeTps: 42.14,
          timeToFirstContentMs: 850,
          tpsWithTimeToFirstContent: 12.5,
        },
      ),
      intl,
      "en-US",
    );

    const lastRows = rows.filter((row) => row.section === "last");
    expect(lastRows.map((row) => row.id)).toEqual([
      "decodeTps",
      "ttft",
      "tpsWithTtft",
      "requestBody",
      "bodyUploadMs",
      "zstdLast",
    ]);
    expect(lastRows[0]?.value).toBe("42.1 t/s");
    expect(lastRows[1]?.value).toBe("850 ms");
    expect(lastRows[2]?.value).toBe("12.5 t/s");
    expect(lastRows[3]?.value).toBe("1.1 MB");
    // 上传耗时与首字耗时是两个独立口径，不能相等或互相回退。
    expect(lastRows[4]?.value).toBe("320 ms");
    expect(lastRows[5]?.value).toBe("1.1 MB → 195 KB");
  });

  it("renders the aggregate section including totals and weighted averages", () => {
    const rows = buildRequestMetricsRows(
      metrics({
        requestBodySampleCount: 2,
        totalRequestBodyBytes: 3_000,
        averageRequestBodyBytes: 1_500,
        uploadSampleCount: 2,
        totalRequestBodyUploadMs: 3_000,
        averageRequestBodyUploadMs: 1_500,
        tpsSampleCount: 2,
        averageDecodeTps: 53.33,
        averageTpsWithTimeToFirstContent: 22.86,
        ttftSampleCount: 2,
        averageTimeToFirstContentMs: 1_000,
        zstd: {
          requestCount: 2,
          totalRequestBodyBytes: 4_000,
          totalCompressedBytes: 600,
          compressionRatio: 0.15,
        },
      }),
      intl,
      "en-US",
    );

    const aggregateRows = rows.filter((row) => row.section === "aggregate");
    expect(aggregateRows.map((row) => row.id)).toEqual([
      "avgDecodeTps",
      "avgTpsWithTtft",
      "avgTtft",
      "avgRequestBody",
      "totalRequestBody",
      "avgBodyUploadMs",
      "totalBodyUploadMs",
      "zstdRatio",
    ]);
    expect(aggregateRows.map((row) => row.value)).toEqual([
      "53.3 t/s",
      "22.9 t/s",
      "1 s",
      "1.5 KB",
      "2.9 KB",
      "1.5 s",
      "3 s",
      "15% · 3.9 KB → 600 B",
    ]);
  });

  it("keeps every row visible but shows a placeholder when a metric is unknown", () => {
    const rows = buildRequestMetricsRows(
      metrics({ requestBodySampleCount: 1, totalRequestBodyBytes: 500 }, {
        requestBodyBytes: 500,
        requestBodyCompressedBytes: null,
        requestBodyUploadMs: null,
        decodeTps: null,
        timeToFirstContentMs: null,
        tpsWithTimeToFirstContent: null,
      }),
      intl,
      "en-US",
    );

    expect(rows).toHaveLength(14);
    expect(rows.find((row) => row.id === "decodeTps")?.value).toBe("— t/s");
    expect(rows.find((row) => row.id === "bodyUploadMs")?.value).toBe("—");
    expect(rows.find((row) => row.id === "zstdLast")?.value).toBe("—");
    expect(rows.find((row) => row.id === "requestBody")?.value).toBe("500 B");
    // 没有上传样本时总量不能显示成 0。
    expect(rows.find((row) => row.id === "totalBodyUploadMs")?.value).toBe("—");
  });

  it("hides the pill until at least one main request carries metrics", () => {
    expect(hasRequestMetricsData(null)).toBe(false);
    expect(hasRequestMetricsData(metrics())).toBe(false);
    expect(
      hasRequestMetricsData(
        metrics({ requestBodySampleCount: 1, totalRequestBodyBytes: 10 }, {
          requestBodyBytes: 10,
          requestBodyCompressedBytes: null,
          requestBodyUploadMs: null,
          decodeTps: 10,
          timeToFirstContentMs: null,
          tpsWithTimeToFirstContent: null,
        }),
      ),
    ).toBe(true);
  });
});
