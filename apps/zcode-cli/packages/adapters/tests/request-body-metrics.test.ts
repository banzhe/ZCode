import { channel } from "node:diagnostics_channel";
import { afterEach, describe, expect, it } from "vitest";
import {
  createModelRequestBodyMetricsFetch,
  requestBodyMetricsFields,
  type ModelRequestBodyMetrics,
} from "../src/model/request-body-metrics.js";
import { disposeRequestBodyUploadObservation } from "../src/model/request-upload-observation.js";

const BODY_SENT = "undici:request:bodySent";
const RAW_BODY = JSON.stringify({ model: "model-a", input: "x".repeat(2048) });

function captureFetch(captured: Request[] = []) {
  const fetch: typeof globalThis.fetch = async (input, init) => {
    captured.push(new Request(input, init));
    return Response.json({ ok: true });
  };
  return { captured, fetch };
}

function publishBodySent(requestId: string): void {
  channel(BODY_SENT).publish({ request: { headers: ["x-request-id", requestId] } });
}

afterEach(() => {
  disposeRequestBodyUploadObservation();
});

describe("模型请求体指标观测", () => {
  it("从字符串请求体取压缩前字节数，并原样转发请求", async () => {
    const { captured, fetch } = captureFetch();
    const metrics: ModelRequestBodyMetrics = {};
    await createModelRequestBodyMetricsFetch(fetch, metrics)("https://provider.test/v1/x", {
      method: "POST",
      body: RAW_BODY,
    });

    expect(metrics.wireBytes).toBe(Buffer.byteLength(RAW_BODY));
    // 只观测不重建：请求体必须逐字节一致，不能被读取或改写。
    expect(await captured[0]!.text()).toBe(RAW_BODY);
  });

  it("优先采用 content-length（zstd 层写入的是压缩后长度）", async () => {
    const { fetch } = captureFetch();
    const metrics: ModelRequestBodyMetrics = {};
    await createModelRequestBodyMetricsFetch(fetch, metrics)("https://provider.test/v1/x", {
      method: "POST",
      headers: { "content-length": "321", "content-encoding": "zstd" },
      body: new Uint8Array(8),
    });

    expect(metrics.wireBytes).toBe(321);
  });

  it("用 x-request-id 关联 undici bodySent，得到上传完成耗时", async () => {
    const metrics: ModelRequestBodyMetrics = {};
    const fetch: typeof globalThis.fetch = async () => {
      // 模拟 undici 在响应头之前报告请求体已发送。
      publishBodySent("req-upload");
      return Response.json({ ok: true });
    };
    await createModelRequestBodyMetricsFetch(fetch, metrics)("https://provider.test/v1/x", {
      method: "POST",
      headers: { "x-request-id": "req-upload" },
      body: RAW_BODY,
    });

    expect(metrics.uploadMs).toBeDefined();
    expect(metrics.uploadMs).toBeGreaterThanOrEqual(0);
  });

  it("没有 x-request-id 时不注册观测，上传耗时保持缺席", async () => {
    const metrics: ModelRequestBodyMetrics = {};
    const { fetch } = captureFetch();
    await createModelRequestBodyMetricsFetch(fetch, metrics)("https://provider.test/v1/x", {
      method: "POST",
      body: RAW_BODY,
    });

    expect(metrics.uploadMs).toBeUndefined();
    expect(channel(BODY_SENT).hasSubscribers).toBe(false);
  });

  it("流式请求体不测量，但请求照常发出", async () => {
    const { captured, fetch } = captureFetch();
    const metrics: ModelRequestBodyMetrics = {};
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    });
    const response = await createModelRequestBodyMetricsFetch(fetch, metrics)(
      "https://provider.test/v1/x",
      { method: "POST", body: stream, duplex: "half" } as RequestInit,
    );

    expect(response.ok).toBe(true);
    expect(captured).toHaveLength(1);
    expect(metrics.wireBytes).toBeUndefined();
  });

  it("请求失败时仍然清理观测注册（不留全局监听）", async () => {
    const metrics: ModelRequestBodyMetrics = {};
    const failing: typeof globalThis.fetch = async () => {
      throw new Error("network down");
    };

    await expect(
      createModelRequestBodyMetricsFetch(failing, metrics)("https://provider.test/v1/x", {
        method: "POST",
        headers: { "x-request-id": "req-fail" },
        body: RAW_BODY,
      }),
    ).rejects.toThrow("network down");
    expect(channel(BODY_SENT).hasSubscribers).toBe(false);
  });
});

describe("requestBodyMetricsFields", () => {
  it("未开启 zstd 时只用上线字节充当原始大小，不伪造压缩后大小", () => {
    expect(requestBodyMetricsFields({ wireBytes: 1200, uploadMs: 12 })).toEqual({
      requestBodyBytes: 1200,
      requestBodyUploadMs: 12,
    });
  });

  it("开启 zstd 时同时给出原始与压缩后大小", () => {
    expect(
      requestBodyMetricsFields({ wireBytes: 120, rawBytes: 1200, compressedBytes: 120, uploadMs: 8 }),
    ).toEqual({
      requestBodyBytes: 1200,
      requestBodyCompressedBytes: 120,
      requestBodyUploadMs: 8,
    });
  });

  it("空指标与非有限值一律缺席，不写成 0", () => {
    expect(requestBodyMetricsFields(undefined)).toEqual({});
    expect(requestBodyMetricsFields({ uploadMs: Number.NaN, wireBytes: -1 })).toEqual({});
  });
});
