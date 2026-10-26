import { zstdDecompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import type { CreateRequestBodyZstdFetch } from "../src/model/request-body-zstd/contract.js";
import { createRequestBodyZstdFetch } from "../src/model/request-body-zstd/request-body-zstd-fetch.js";
import { modelRequestBodyZstdModule } from "../src/model/request-body-zstd/module.js";

// 契约测试只依赖契约类型与模块清单；行为断言通过契约签名完成，不读取实现细节。
const create: CreateRequestBodyZstdFetch = createRequestBodyZstdFetch;

describe("model-request-body-zstd contract", () => {
  it("declares its module manifest with the real public entrypoints", () => {
    expect(modelRequestBodyZstdModule.id).toBe("model-request-body-zstd");
    expect(modelRequestBodyZstdModule.publicEntrypoints).toContain("request-body-zstd-fetch.ts");
    expect(modelRequestBodyZstdModule.publicEntrypoints).toContain("contract.ts");
  });

  it("wraps a transport so that the outbound body is zstd-decodable to the original", async () => {
    const seen: Request[] = [];
    const base: typeof globalThis.fetch = async (input, init) => {
      seen.push(new Request(input, init));
      return Response.json({ ok: true });
    };
    const raw = JSON.stringify({ model: "contract-model" });

    await create(base)("https://provider.test/v1/messages", { method: "POST", body: raw });

    const wire = Buffer.from(await seen[0]!.arrayBuffer());
    expect(seen[0]!.headers.get("content-encoding")).toBe("zstd");
    expect(zstdDecompressSync(wire).toString("utf8")).toBe(raw);
  });
});
