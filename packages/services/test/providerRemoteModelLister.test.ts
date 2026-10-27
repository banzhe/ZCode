import type { ProviderSettingsView } from "@zcode/provider";
import { describe, expect, it, vi } from "vitest";
import {
  buildProviderModelsAuthHeaders,
  createProviderRemoteModelLister,
  joinProviderModelsRequestUrl,
  parseRemoteModelListPayload,
} from "../src/model-provider/providerRemoteModelLister.js";

describe("joinProviderModelsRequestUrl", () => {
  it.each([
    { baseUrl: "https://api.example.com/v1", expected: "https://api.example.com/v1/models" },
    { baseUrl: "https://api.example.com/v1/", expected: "https://api.example.com/v1/models" },
    { baseUrl: "https://api.example.com", expected: "https://api.example.com/v1/models" },
    {
      baseUrl: "https://api.example.com/api/paas/v4/",
      expected: "https://api.example.com/api/paas/v4/v1/models",
    },
    { baseUrl: "http://127.0.0.1:8080/v1", expected: "http://127.0.0.1:8080/v1/models" },
  ])("$baseUrl → $expected", ({ baseUrl, expected }) => {
    expect(joinProviderModelsRequestUrl(baseUrl)).toBe(expected);
  });

  it.each(["", "   ", "ftp://api.example.com", "not a url"])("拒绝无效地址 %s", (baseUrl) => {
    expect(() => joinProviderModelsRequestUrl(baseUrl)).toThrow();
  });
});

describe("buildProviderModelsAuthHeaders", () => {
  it("openai 系使用 Bearer 鉴权", () => {
    expect(buildProviderModelsAuthHeaders("openai-chat-completions", "sk-test")).toEqual({
      Authorization: "Bearer sk-test",
    });
    expect(buildProviderModelsAuthHeaders("openai-responses", "sk-test")).toEqual({
      Authorization: "Bearer sk-test",
    });
  });

  it("anthropic 使用 x-api-key 与版本头", () => {
    expect(buildProviderModelsAuthHeaders("anthropic-messages", "sk-ant")).toEqual({
      "x-api-key": "sk-ant",
      "anthropic-version": "2023-06-01",
    });
  });
});

describe("parseRemoteModelListPayload", () => {
  it("解析 OpenAI 兼容 data 列表", () => {
    expect(
      parseRemoteModelListPayload({
        object: "list",
        data: [{ id: "gpt-x", object: "model" }, { id: "gpt-y" }],
      }),
    ).toEqual([{ id: "gpt-x" }, { id: "gpt-y" }]);
  });

  it("解析 Anthropic data 列表", () => {
    expect(
      parseRemoteModelListPayload({
        data: [{ type: "model", id: "claude-x", display_name: "Claude X" }],
      }),
    ).toEqual([{ id: "claude-x" }]);
  });

  it("解析 OpenRouter 富元数据", () => {
    expect(
      parseRemoteModelListPayload({
        data: [
          {
            id: "vendor/model-x",
            context_length: 131072,
            top_provider: { max_completion_tokens: 65536 },
            architecture: { input_modalities: ["text", "image"] },
          },
        ],
      }),
    ).toEqual([
      {
        id: "vendor/model-x",
        contextWindow: 131072,
        maxOutputTokens: 65536,
        inputModalities: ["text", "image"],
      },
    ]);
  });

  it("context_window / max_output_tokens / max_tokens 别名", () => {
    expect(
      parseRemoteModelListPayload({
        data: [
          { id: "a", context_window: 4096, max_output_tokens: 2048 },
          { id: "b", context_length: 8192, max_tokens: 4096 },
        ],
      }),
    ).toEqual([
      { id: "a", contextWindow: 4096, maxOutputTokens: 2048 },
      { id: "b", contextWindow: 8192, maxOutputTokens: 4096 },
    ]);
  });

  it("去重、过滤非对象与非字符串 id，容忍裸数组", () => {
    expect(
      parseRemoteModelListPayload([
        { id: "m1" },
        { id: "m1" },
        { name: "m2" },
        { id: 42 },
        null,
        "x",
      ]),
    ).toEqual([{ id: "m1" }, { id: "m2" }]);
  });

  it("空数据返回空数组", () => {
    expect(parseRemoteModelListPayload({})).toEqual([]);
    expect(parseRemoteModelListPayload({ data: [] })).toEqual([]);
  });
});

function createView(providers: ProviderSettingsView["providers"]): ProviderSettingsView {
  return { revision: 1, providerTemplates: [], providerOrder: [], providers };
}

function createApiKeyProvider(overrides?: {
  apiKey?: string | null;
  baseUrl?: string;
  apiType?: "openai-chat-completions" | "anthropic-messages";
  headers?: Record<string, string>;
}): ProviderSettingsView["providers"][number] {
  return {
    providerId: "custom",
    enabled: true,
    executable: true,
    issues: [],
    models: [],
    effectiveConfig: {
      access: {
        type: "api-key",
        ...(overrides?.apiKey === undefined ? { apiKey: "sk-live" } : { apiKey: overrides.apiKey }),
      },
      api: {
        type: overrides?.apiType ?? "openai-chat-completions",
        baseUrl: overrides?.baseUrl ?? "https://api.example.com/v1",
        ...(overrides?.headers ? { headers: overrides.headers } : {}),
      },
    },
  } as unknown as ProviderSettingsView["providers"][number];
}

describe("createProviderRemoteModelLister", () => {
  const fetchOk = (payload: unknown): typeof fetch =>
    vi.fn(
      async () => new Response(JSON.stringify(payload), { status: 200 }),
    ) as unknown as typeof fetch;

  it("使用已保存的 baseUrl 与 Key 发起请求并解析结果", async () => {
    const fetchImpl = fetchOk({ data: [{ id: "model-a" }] });
    const lister = createProviderRemoteModelLister({
      getView: async () => createView([createApiKeyProvider()]),
      fetchImpl,
    });
    const result = await lister({ providerId: "custom" });
    expect(result.models).toEqual([{ id: "model-a" }]);
    expect(vi.mocked(fetchImpl)).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0]!;
    expect(url).toBe("https://api.example.com/v1/models");
    expect(init.method).toBe("GET");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer sk-live");
  });

  it("anthropic 端点使用 x-api-key 鉴权", async () => {
    const fetchImpl = fetchOk({ data: [] });
    const lister = createProviderRemoteModelLister({
      getView: async () => createView([createApiKeyProvider({ apiType: "anthropic-messages" })]),
      fetchImpl,
    });
    await lister({ providerId: "custom" });
    const [, init] = vi.mocked(fetchImpl).mock.calls[0]!;
    const headers = new Headers(init.headers);
    expect(headers.get("x-api-key")).toBe("sk-live");
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
  });

  it("配置中的自定义请求头参与合并", async () => {
    const fetchImpl = fetchOk({ data: [] });
    const lister = createProviderRemoteModelLister({
      getView: async () => createView([createApiKeyProvider({ headers: { "x-custom": "1" } })]),
      fetchImpl,
    });
    await lister({ providerId: "custom" });
    expect(new Headers(vi.mocked(fetchImpl).mock.calls[0]![1]?.headers).get("x-custom")).toBe("1");
  });

  it.each([
    {
      name: "Provider 不存在",
      view: createView([]),
      message: "Provider 不存在或已被删除",
    },
    {
      name: "access 不是 API Key",
      view: createView([
        {
          providerId: "custom",
          enabled: true,
          executable: true,
          issues: [],
          models: [],
          effectiveConfig: {
            access: { type: "zhipu-account", accountType: "zai", mode: "start-plan" },
            api: { type: "openai-chat-completions", baseUrl: "https://api.example.com/v1" },
          },
        } as unknown as ProviderSettingsView["providers"][number],
      ]),
      message: "仅支持 API Key 接入的 Provider 获取远端模型列表",
    },
    {
      name: "API Key 为空",
      view: createView([createApiKeyProvider({ apiKey: "" })]),
      message: "Provider 尚未配置 API Key，无法获取模型列表",
    },
    {
      name: "baseUrl 为空",
      view: createView([createApiKeyProvider({ baseUrl: " " })]),
      message: "Provider 尚未配置接口地址，无法获取模型列表",
    },
  ])("$name 时 fail-fast", async ({ view, message }) => {
    const fetchImpl = vi.fn();
    const lister = createProviderRemoteModelLister({
      getView: async () => view,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(lister({ providerId: "custom" })).rejects.toThrow(message);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("401 / 404 / 其他状态返回可区分的错误", async () => {
    const build = (status: number) => async (): Promise<Response> => new Response("{}", { status });
    await expect(
      createProviderRemoteModelLister({
        getView: async () => createView([createApiKeyProvider()]),
        fetchImpl: build(401) as unknown as typeof fetch,
      })({ providerId: "custom" }),
    ).rejects.toThrow("API Key 无效");
    await expect(
      createProviderRemoteModelLister({
        getView: async () => createView([createApiKeyProvider()]),
        fetchImpl: build(404) as unknown as typeof fetch,
      })({ providerId: "custom" }),
    ).rejects.toThrow("404");
    await expect(
      createProviderRemoteModelLister({
        getView: async () => createView([createApiKeyProvider()]),
        fetchImpl: build(500) as unknown as typeof fetch,
      })({ providerId: "custom" }),
    ).rejects.toThrow("HTTP 500");
  });

  it("超时与网络错误都有明确文案", async () => {
    const timeoutError = new Error("The operation was aborted due to timeout");
    timeoutError.name = "TimeoutError";
    await expect(
      createProviderRemoteModelLister({
        getView: async () => createView([createApiKeyProvider()]),
        fetchImpl: vi.fn(async () => {
          throw timeoutError;
        }) as unknown as typeof fetch,
      })({ providerId: "custom" }),
    ).rejects.toThrow("超时");
    await expect(
      createProviderRemoteModelLister({
        getView: async () => createView([createApiKeyProvider()]),
        fetchImpl: vi.fn(async () => {
          throw new TypeError("fetch failed");
        }) as unknown as typeof fetch,
      })({ providerId: "custom" }),
    ).rejects.toThrow("获取模型列表失败");
  });

  it("非 JSON 响应报明确错误", async () => {
    const lister = createProviderRemoteModelLister({
      getView: async () => createView([createApiKeyProvider()]),
      fetchImpl: vi.fn(
        async () => new Response("<html>", { status: 200 }),
      ) as unknown as typeof fetch,
    });
    await expect(lister({ providerId: "custom" })).rejects.toThrow("JSON");
  });
});
