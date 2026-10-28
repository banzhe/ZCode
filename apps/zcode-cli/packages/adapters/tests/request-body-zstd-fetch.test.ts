import { zstdDecompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { createRequestBodyZstdFetch } from "../src/model/request-body-zstd/request-body-zstd-fetch.js";

const PAYLOAD = { model: "model-a", messages: [{ role: "user", content: "hello".repeat(40) }] };

function captureFetch() {
  const seen: Request[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    seen.push(new Request(input, init));
    return Response.json({ ok: true });
  };
  return { fetch, seen };
}

describe("模型请求体 zstd 压缩", () => {
  it("把 POST 请求体压缩为可还原的 zstd，并设置 content-encoding 与压缩后的 content-length", async () => {
    const { fetch, seen } = captureFetch();
    const wrapped = createRequestBodyZstdFetch(fetch);
    const raw = JSON.stringify(PAYLOAD);

    await wrapped("https://provider.test/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer key" },
      body: raw,
    });

    const sent = seen[0];
    expect(sent).toBeDefined();
    const wire = Buffer.from(await sent!.arrayBuffer());
    expect(sent!.headers.get("content-encoding")).toBe("zstd");
    expect(sent!.headers.get("content-length")).toBe(String(wire.byteLength));
    expect(wire.byteLength).toBeLessThan(Buffer.byteLength(raw));
    expect(zstdDecompressSync(wire).toString("utf8")).toBe(raw);
    // 鉴权头与业务头原样保留，压缩不改变签名输入以外的语义。
    expect(sent!.headers.get("authorization")).toBe("Bearer key");
    expect(sent!.headers.get("content-type")).toBe("application/json");
  });

  it("GET 请求没有请求体，原样透传且不设置 content-encoding", async () => {
    const { fetch, seen } = captureFetch();
    const wrapped = createRequestBodyZstdFetch(fetch);

    await wrapped("https://provider.test/v1/models", { method: "GET" });

    expect(seen[0]!.method).toBe("GET");
    expect(seen[0]!.headers.get("content-encoding")).toBeNull();
  });

  it("空请求体的 POST 不压缩也不设置 content-encoding", async () => {
    const { fetch, seen } = captureFetch();
    const wrapped = createRequestBodyZstdFetch(fetch);

    await wrapped("https://provider.test/v1/x", { method: "POST" });

    expect(seen[0]!.headers.get("content-encoding")).toBeNull();
  });

  it("observer 上报压缩前后字节，且不改变压缩语义", async () => {
    const { fetch, seen } = captureFetch();
    const observed: Array<[number, number]> = [];
    const wrapped = createRequestBodyZstdFetch(fetch, {
      onCompressed: (rawBytes, compressedBytes) => observed.push([rawBytes, compressedBytes]),
    });
    const raw = JSON.stringify(PAYLOAD);

    await wrapped("https://provider.test/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: raw,
    });

    expect(observed).toHaveLength(1);
    const [rawBytes, compressedBytes] = observed[0]!;
    expect(rawBytes).toBe(Buffer.byteLength(raw));
    expect(compressedBytes).toBe(
      Buffer.from(await seen[0]!.arrayBuffer()).byteLength,
    );
    expect(compressedBytes).toBeLessThan(rawBytes);
  });

  it("observer 抛错不影响压缩请求", async () => {
    const { fetch, seen } = captureFetch();
    const wrapped = createRequestBodyZstdFetch(fetch, {
      onCompressed: () => {
        throw new Error("observer exploded");
      },
    });

    await wrapped("https://provider.test/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify(PAYLOAD),
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]!.headers.get("content-encoding")).toBe("zstd");
  });

  it("GET / 空请求体不调用 observer", async () => {
    const { fetch } = captureFetch();
    let calls = 0;
    const wrapped = createRequestBodyZstdFetch(fetch, {
      onCompressed: () => {
        calls += 1;
      },
    });

    await wrapped("https://provider.test/v1/models", { method: "GET" });
    await wrapped("https://provider.test/v1/x", { method: "POST" });

    expect(calls).toBe(0);
  });
});
