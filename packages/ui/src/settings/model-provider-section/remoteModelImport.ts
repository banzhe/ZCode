import type { ModelConfigObject } from "@zcode/provider";
import {
  resolveProviderModelDraftCommit,
  type ProviderModelDraftValues,
} from "@/settings/model-provider-section/ProviderModelMetadata.js";

/**
 * 与 services 层 MODEL_PROVIDER_NEW_MODEL_CONTEXT_WINDOW（legacy 迁移兜底）保持同一数值：
 * 端点与内置规则都不知道的模型按该保守上下文窗口导入，避免导入即配置不完整。
 */
export const REMOTE_MODEL_IMPORT_FALLBACK_CONTEXT_WINDOW = 200_000;

const FALLBACK_REASONING_LEVELS = ["disabled", "enabled"] as const;
const FALLBACK_REASONING_MAP = "{}";

/**
 * 未知模型的保守完整基线：resolveProviderModelDraftCommit 的 supportsText/outputFormat
 * 等系统叶子只从当前生效配置继承，内置规则也不覆盖未知模型；导入必须产出可通过
 * validateComplete 的完整配置，不能用空基线生成「配置不完整」的模型。
 */
const CONSERVATIVE_BASELINE: ModelConfigObject = {
  enabled: true,
  properties: {
    inputFormat: {
      supportsText: true,
      supportsImage: false,
      supportsVideo: false,
      supportsAudio: false,
      supportsPdf: false,
    },
    outputFormat: { supportsText: true },
    supportsToolCall: true,
    supportsJsonSchemaOutput: false,
    supportsNativeWebSearch: false,
    supportsMidConversationSystem: false,
  },
  optionSpecs: {
    reasoningLevel: { values: [...FALLBACK_REASONING_LEVELS], map: FALLBACK_REASONING_MAP },
  },
};

/** 只补空缺、不做深改写；继承层完整时与原值等价。 */
function withConservativeBaseline(inherited: ModelConfigObject | undefined): ModelConfigObject {
  if (!inherited || Object.keys(inherited).length === 0) return CONSERVATIVE_BASELINE;
  return {
    ...CONSERVATIVE_BASELINE,
    ...inherited,
    properties: {
      ...CONSERVATIVE_BASELINE.properties,
      ...inherited.properties,
      inputFormat: {
        ...CONSERVATIVE_BASELINE.properties?.inputFormat,
        ...inherited.properties?.inputFormat,
      },
      outputFormat: {
        ...CONSERVATIVE_BASELINE.properties?.outputFormat,
        ...inherited.properties?.outputFormat,
      },
    },
    optionSpecs: {
      ...CONSERVATIVE_BASELINE.optionSpecs,
      ...inherited.optionSpecs,
    },
  };
}

function readDraftInputFormat({
  modalities,
  inherited,
}: {
  modalities: readonly string[] | undefined;
  inherited: ModelConfigObject;
}): ProviderModelDraftValues["inputFormatValue"] {
  const inheritedFormat = inherited.properties?.inputFormat;
  // 远端声明的模态是 provider 自报事实，直接采纳；未声明时不猜测，回退继承值或仅文本。
  const declared = (modality: "image" | "video" | "audio" | "pdf"): boolean | undefined =>
    modalities === undefined ? undefined : modalities.includes(modality);
  return {
    supportsText: true,
    supportsImage: declared("image") ?? inheritedFormat?.supportsImage ?? false,
    supportsVideo: declared("video") ?? inheritedFormat?.supportsVideo ?? false,
    supportsAudio: declared("audio") ?? inheritedFormat?.supportsAudio ?? false,
    supportsPdf: declared("pdf") ?? inheritedFormat?.supportsPdf ?? false,
  };
}

/**
 * 把远端模型条目合成与「添加模型」弹窗同一套 Draft 提交语义：
 * 推荐模式下只写显式决策的稀疏 Personal Overlay，继承缺口由 resolveProviderModelDraftCommit 补齐。
 */
export function buildImportedRemoteModel({
  entry,
  inheritedConfig,
}: {
  entry: {
    readonly id: string;
    readonly contextWindow?: number;
    readonly maxOutputTokens?: number;
    readonly inputModalities?: readonly string[];
  };
  readonly inheritedConfig: ModelConfigObject | undefined;
}): ReturnType<typeof resolveProviderModelDraftCommit> {
  const inherited = withConservativeBaseline(inheritedConfig);
  const draft: ProviderModelDraftValues = {
    idValue: entry.id,
    contextWindowValue: String(
      entry.contextWindow ??
        inherited.properties?.contextWindow ??
        REMOTE_MODEL_IMPORT_FALLBACK_CONTEXT_WINDOW,
    ),
    maxOutputTokensValue: entry.maxOutputTokens === undefined ? "" : String(entry.maxOutputTokens),
    inputFormatValue: readDraftInputFormat({
      modalities: entry.inputModalities,
      inherited,
    }),
    enabledValue: true,
    useRecommendedConfigValue: true,
    clearPersonalConfigValue: false,
    overriddenFieldsValue: [],
    supportsJsonSchemaOutputValue: inherited.properties?.supportsJsonSchemaOutput ?? false,
    supportsNativeWebSearchValue: inherited.properties?.supportsNativeWebSearch ?? false,
    supportsMidConversationSystemValue:
      inherited.properties?.supportsMidConversationSystem ?? false,
    reasoningLevelValuesValue: [
      ...(inherited.optionSpecs?.reasoningLevel?.values ?? FALLBACK_REASONING_LEVELS),
    ],
    reasoningLevelMapValue:
      typeof inherited.optionSpecs?.reasoningLevel?.map === "string"
        ? inherited.optionSpecs.reasoningLevel.map
        : FALLBACK_REASONING_MAP,
  };
  return resolveProviderModelDraftCommit({
    currentModel: {
      kind: "candidate",
      modelId: entry.id,
      builtin: false,
      inheritedConfig: inherited,
      personalConfig: {},
      useRecommendedConfig: true,
      config: inherited,
      hasPersonalConfig: false,
      executable: false,
      selectable: false,
    },
    draft,
  });
}
