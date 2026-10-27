import { isApiKeyAccess, type ProviderApiType, type ProviderSettingsView } from "@zcode/provider";

/** 远端模型列表条目；可选元数据来自端点自报字段，缺失一律安全缺省。 */
export interface RemoteModelListEntry {
  readonly id: string;
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
  readonly inputModalities?: readonly string[];
}

export interface ProviderRemoteModelListResult {
  readonly models: readonly RemoteModelListEntry[];
}

export interface ProviderRemoteModelListerInput {
  readonly providerId: string;
}

export type ProviderRemoteModelLister = (
  input: ProviderRemoteModelListerInput,
) => Promise<ProviderRemoteModelListResult>;

const REMOTE_MODEL_LIST_TIMEOUT_MS = 15_000;

/** 与 CLI adapters 的 messages/chat-completions URL 拼接规则保持同一约定。 */
export function joinProviderModelsRequestUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/u, "");
  if (!trimmed) throw new Error("Provider 接口地址为空，无法获取模型列表");
  try {
    // URL 校验同时拦截非 http(s) 与含空格的无效地址。
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error(`不支持的接口地址协议: ${parsed.protocol}`);
    }
  } catch (error) {
    if (error instanceof TypeError) throw new Error(`Provider 接口地址无效: ${baseUrl}`);
    throw error;
  }
  return `${trimmed}${trimmed.endsWith("/v1") ? "" : "/v1"}/models`;
}

export function buildProviderModelsAuthHeaders(
  apiType: ProviderApiType,
  apiKey: string,
): Record<string, string> {
  if (apiType === "anthropic-messages") {
    return {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    };
  }
  return { Authorization: `Bearer ${apiKey}` };
}

function readPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function readStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.filter(
    (entry): entry is string => typeof entry === "string" && !!entry.trim(),
  );
  return values.length > 0 ? values : undefined;
}

function readEntryString(
  entry: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = entry[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function readEntryNumber(
  entry: Record<string, unknown>,
  keys: readonly string[],
): number | undefined {
  for (const key of keys) {
    const value = readPositiveInteger(entry[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

/** 解析 OpenAI 兼容 / Anthropic 的 `{data:[...]}` 与直接的 `[{...}]` 两种响应形态。 */
export function parseRemoteModelListPayload(payload: unknown): RemoteModelListEntry[] {
  const list = Array.isArray(payload)
    ? payload
    : payload !== null &&
        typeof payload === "object" &&
        Array.isArray((payload as { data?: unknown }).data)
      ? (payload as { data: unknown[] }).data
      : [];
  const entries: RemoteModelListEntry[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (item === null || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    const id = readEntryString(entry, ["id", "name", "model"]);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const architecture =
      entry.architecture !== null && typeof entry.architecture === "object"
        ? (entry.architecture as Record<string, unknown>)
        : undefined;
    const topProvider =
      entry.top_provider !== null && typeof entry.top_provider === "object"
        ? (entry.top_provider as Record<string, unknown>)
        : undefined;
    const contextWindow = readEntryNumber(entry, ["context_length", "context_window"]);
    const maxOutputTokens =
      readEntryNumber(entry, ["max_output_tokens", "max_tokens"]) ??
      (topProvider ? readEntryNumber(topProvider, ["max_completion_tokens"]) : undefined);
    const inputModalities = readStringArray(architecture?.input_modalities);
    entries.push({
      id,
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
      ...(inputModalities === undefined ? {} : { inputModalities }),
    });
  }
  return entries;
}

/**
 * 远端模型列表在 Host 侧执行：Renderer 直接 fetch 第三方端点会被 CORS 拦截，
 * 且 API Key 只在 Host 配置中完整保存，不能要求 Renderer 回传。
 */
export function createProviderRemoteModelLister(dependencies: {
  readonly getView: () => Promise<ProviderSettingsView>;
  readonly fetchImpl?: typeof fetch;
}): ProviderRemoteModelLister {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  return async (input) => {
    const view = await dependencies.getView();
    const provider = view.providers.find((item) => item.providerId === input.providerId);
    if (!provider) throw new Error("Provider 不存在或已被删除");
    const access = provider.effectiveConfig.access;
    const apiKey = isApiKeyAccess(access) ? (access.apiKey ?? "") : "";
    if (!isApiKeyAccess(access)) {
      throw new Error("仅支持 API Key 接入的 Provider 获取远端模型列表");
    }
    if (!apiKey.trim()) throw new Error("Provider 尚未配置 API Key，无法获取模型列表");
    const api = provider.effectiveConfig.api;
    if (!api?.baseUrl?.trim()) throw new Error("Provider 尚未配置接口地址，无法获取模型列表");
    const apiType: ProviderApiType = api.type ?? "anthropic-messages";
    const requestUrl = joinProviderModelsRequestUrl(api.baseUrl);
    const requestInit: RequestInit = {
      method: "GET",
      headers: {
        Accept: "application/json",
        ...buildProviderModelsAuthHeaders(apiType, apiKey),
        // 显式自定义头最后合并，允许覆盖默认鉴权形态。
        ...api.headers,
      },
      signal: AbortSignal.timeout(REMOTE_MODEL_LIST_TIMEOUT_MS),
    };
    let response: Response;
    try {
      response = await fetchImpl(requestUrl, requestInit);
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new Error("获取模型列表超时，请检查接口地址或网络连接");
      }
      throw new Error(
        `获取模型列表失败: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new Error("获取模型列表被拒绝（API Key 无效或无权限）");
      }
      if (response.status === 404) {
        throw new Error("该接口地址不支持模型列表查询（/models 返回 404）");
      }
      throw new Error(`获取模型列表失败（HTTP ${response.status}）`);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error("模型列表响应不是有效 JSON");
    }
    return { models: parseRemoteModelListPayload(payload) };
  };
}
