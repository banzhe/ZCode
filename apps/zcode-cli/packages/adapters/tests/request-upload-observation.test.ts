import { channel } from "node:diagnostics_channel";
import { afterEach, describe, expect, it } from "vitest";
import {
  disposeRequestBodyUploadObservation,
  observeRequestBodyUpload,
} from "../src/model/request-upload-observation.js";

const BODY_SENT = "undici:request:bodySent";

function publishBodySent(headers: unknown): void {
  channel(BODY_SENT).publish({ request: { headers } });
}

afterEach(() => {
  disposeRequestBodyUploadObservation();
});

describe("请求体上传完成观测", () => {
  it("按扁平 header 数组里的 x-request-id 命中注册项", () => {
    const uploaded: number[] = [];
    observeRequestBodyUpload("req-a", (at) => uploaded.push(at));

    publishBodySent(["content-type", "application/json", "x-request-id", "req-a"]);

    expect(uploaded).toHaveLength(1);
    expect(uploaded[0]).toBeGreaterThan(0);
  });

  it("支持 Headers 与普通对象两种 header 形态", () => {
    const fromHeaders: number[] = [];
    const fromObject: number[] = [];
    observeRequestBodyUpload("req-headers", (at) => fromHeaders.push(at));
    observeRequestBodyUpload("req-object", (at) => fromObject.push(at));

    publishBodySent(new Headers({ "x-request-id": "req-headers" }));
    publishBodySent({ "X-Request-Id": "req-object" });

    expect(fromHeaders).toHaveLength(1);
    expect(fromObject).toHaveLength(1);
  });

  it("首次命中即生效，重定向后的重复上报不再计时", () => {
    const uploaded: number[] = [];
    observeRequestBodyUpload("req-once", (at) => uploaded.push(at));

    publishBodySent(["x-request-id", "req-once"]);
    publishBodySent(["x-request-id", "req-once"]);

    expect(uploaded).toHaveLength(1);
  });

  it("没有 x-request-id 的请求（代理 CONNECT 等）不命中任何注册项", () => {
    const uploaded: number[] = [];
    observeRequestBodyUpload("req-x", (at) => uploaded.push(at));

    publishBodySent(["host", "provider.test"]);

    expect(uploaded).toHaveLength(0);
  });

  it("dispose 后不再命中，且不会因为异常 header 抛错", () => {
    const uploaded: number[] = [];
    const dispose = observeRequestBodyUpload("req-dispose", (at) => uploaded.push(at));
    dispose();
    dispose();

    publishBodySent(["x-request-id", "req-dispose"]);

    expect(uploaded).toHaveLength(0);
  });

  it("订阅者回调抛错时不影响 undici 发布，也不影响后续请求", () => {
    observeRequestBodyUpload("req-throws", () => {
      throw new Error("observer exploded");
    });
    const uploaded: number[] = [];
    observeRequestBodyUpload("req-after", (at) => uploaded.push(at));

    expect(() => publishBodySent(["x-request-id", "req-throws"])).not.toThrow();
    publishBodySent(["x-request-id", "req-after"]);

    expect(uploaded).toHaveLength(1);
  });

  it("重复注册同一 requestId 时只保留最后一次注册", () => {
    const first: number[] = [];
    const second: number[] = [];
    observeRequestBodyUpload("req-dup", (at) => first.push(at));
    observeRequestBodyUpload("req-dup", (at) => second.push(at));

    publishBodySent(["x-request-id", "req-dup"]);

    expect(first).toHaveLength(0);
    expect(second).toHaveLength(1);
  });

  it("空闲时注销全局监听，避免无请求时持有订阅", () => {
    const before = channel(BODY_SENT).hasSubscribers;
    const dispose = observeRequestBodyUpload("req-idle", () => {});
    expect(channel(BODY_SENT).hasSubscribers).toBe(true);

    dispose();

    expect(channel(BODY_SENT).hasSubscribers).toBe(before);
  });
});
