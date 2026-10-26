import { zstdDecompressSync } from "node:zlib";
import { generateText } from "ai";
import { describe, expect, it } from "vitest";
import { AiSdkModelExecution } from "../src/model/model-execution.js";
import { createRegistryProviderConfig, parseProviderConfig } from "@zcode/provider";

function anthropicResponse() {
  return Response.json({
    id: "msg_zstd",
    type: "message",
    role: "assistant",
    model: "model-a",
    content: [{ type: "text", text: "ok" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  });
}

async function sendOnce(requestBodyZstd: boolean | undefined): Promise<Request> {
  const requests: Request[] = [];
  const execution = new AiSdkModelExecution(
    { env: {} },
    {
      transport: async (input, init) => {
        requests.push(new Request(input, init));
        return anthropicResponse();
      },
    },
  );
  const provider = createRegistryProviderConfig(
    parseProviderConfig({
      group: "standard-personal",
      access: { type: "api-key", apiKey: "key" },
      api: {
        type: "anthropic-messages",
        baseUrl: "https://provider.test/anthropic",
        ...(requestBodyZstd === undefined ? {} : { requestBodyZstd }),
      },
    }),
  );
  if (!provider.ok) throw new Error("invalid zstd fixture");
  const bound = execution.bindModel({
    providerId: "zstd-fixture",
    modelId: "model-a",
    providerConfig: provider.config,
    supportsJsonSchemaOutput: false,
    optionSpecs: { reasoningLevel: { map: "{}" }, maxOutputTokens: { map: "{}" } },
  });
  const resolved = bound.resolveRequest({
    options: { reasoningLevel: "disabled", maxOutputTokens: 64 },
  });
  await generateText({ model: resolved.model, prompt: "hello zstd", maxRetries: 0 });
  expect(requests).toHaveLength(1);
  return requests[0]!;
}

describe("Provider requestBodyZstd 装配", () => {
  it("开启后请求体为 zstd 且可还原为原 JSON，并设置 content-encoding", async () => {
    const sent = await sendOnce(true);
    const wire = Buffer.from(await sent.arrayBuffer());

    expect(sent.headers.get("content-encoding")).toBe("zstd");
    const body = JSON.parse(zstdDecompressSync(wire).toString("utf8")) as Record<string, unknown>;
    expect(body.model).toBe("model-a");
  });

  it("缺省（未配置）时请求体保持明文，不设置 content-encoding", async () => {
    const sent = await sendOnce(undefined);
    const body = JSON.parse(await sent.text()) as Record<string, unknown>;

    expect(sent.headers.get("content-encoding")).toBeNull();
    expect(body.model).toBe("model-a");
  });

  it("显式 false 时与缺省行为一致", async () => {
    const sent = await sendOnce(false);

    expect(sent.headers.get("content-encoding")).toBeNull();
  });
});
