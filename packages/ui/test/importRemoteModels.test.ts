// @vitest-environment jsdom

import { createElement, type ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderModelsSection } from "@/settings/model-provider-section/ProviderCardSections.js";
import { ProviderDetailFeedbackBoundary } from "@/settings/model-provider-section/ProviderDetailFeedback.js";
import { buildImportedRemoteModel } from "@/settings/model-provider-section/remoteModelImport.js";
import type { ProviderSettingsFormModel } from "@/lib/providerSettingsFormTypes.js";

const providerSettingsServiceMock = vi.hoisted(() => ({
  resolveModelConfig: vi.fn(),
}));

vi.mock("@/hooks/useServices.js", () => ({
  useServices: () => ({
    providerSettingsService: providerSettingsServiceMock,
  }),
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    locale: "zh-CN",
    intl: {
      formatMessage: ({ id }, values) => {
        const messages: Record<string, string> = {
          "settings.modelProvider.models": "模型列表",
          "settings.modelProvider.addModel": "添加模型",
          "settings.modelProvider.importRemoteModels.action": "从接口获取",
          "settings.modelProvider.importRemoteModels.title": "从接口获取模型",
          "settings.modelProvider.importRemoteModels.searchPlaceholder": "搜索模型 ID",
          "settings.modelProvider.importRemoteModels.selectAll": "全选",
          "settings.modelProvider.importRemoteModels.deselectAll": "取消全选",
          "settings.modelProvider.importRemoteModels.empty":
            "该接口未返回任何模型，请检查接口地址。",
          "settings.modelProvider.importRemoteModels.alreadyAdded": "已添加",
          "settings.modelProvider.importRemoteModels.selectedCount": `已选择 ${values?.count ?? 0} 个模型`,
          "settings.modelProvider.importRemoteModels.confirm": "添加所选模型",
          "settings.modelProvider.importRemoteModels.failure": "导入模型失败，请重试。",
          "settings.modelProvider.importRemoteModels.partialSummary": `已添加 ${values?.added ?? 0} 个模型，${values?.failed ?? 0} 个失败；失败的模型仍保持勾选，可直接重试。`,
          "settings.modelProvider.importRemoteModels.requiresConnection":
            "请先填写并保存接口地址和 API Key",
          "common.cancel": "取消",
          "common.save": "保存",
          "common.retry": "重试",
          "common.close": "关闭",
        };
        return messages[id] ?? id;
      },
    },
  }),
}));

vi.mock("@/components/ui/dialog.js", () => ({
  Dialog: ({
    children,
    open,
    onOpenChange,
  }: {
    children: ReactNode;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
  }) =>
    open
      ? createElement(
          "div",
          null,
          children,
          createElement(
            "button",
            { type: "button", onClick: () => onOpenChange?.(false) },
            "close-dialog",
          ),
        )
      : null,
  DialogContent: ({ children }: { children: ReactNode }) =>
    createElement("section", null, children),
  DialogDescription: ({ children }: { children: ReactNode }) => createElement("p", null, children),
  DialogHeader: ({ children }: { children: ReactNode }) => createElement("header", null, children),
  DialogTitle: ({ children }: { children: ReactNode }) => createElement("h2", null, children),
  DialogTrigger: ({ children }: { children: ReactNode }) => children,
}));

const inheritAllConfig = {
  properties: {
    contextWindow: 128_000,
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
    reasoningLevel: { values: ["disabled", "enabled"], map: "{}" },
    maxOutputTokens: { max: 32_000 },
  },
};

function renderSection(params: {
  models?: ProviderSettingsFormModel[];
  onFetchRemoteModels?: () => Promise<{ models: { id: string }[] }>;
  fetchRemoteModelsEnabled?: boolean;
  onAddModel?: (model: ProviderSettingsFormModel) => Promise<unknown>;
}) {
  render(
    // 失败反馈渲染在 ProviderDetailFeedbackBoundary 覆盖层，与真实详情页装配一致。
    createElement(
      ProviderDetailFeedbackBoundary,
      null,
      createElement(ProviderModelsSection, {
        providerId: "custom-provider",
        models: params.models ?? [],
        onModelCommit: vi.fn(),
        onDeleteModel: vi.fn(),
        onAddModel: params.onAddModel ?? vi.fn(),
        onFetchRemoteModels: params.onFetchRemoteModels,
        fetchRemoteModelsEnabled: params.fetchRemoteModelsEnabled ?? true,
      }),
    ),
  );
}

describe("buildImportedRemoteModel 配置合成", () => {
  it("端点与内置规则都未知时走保守兜底", () => {
    const result = buildImportedRemoteModel({
      entry: { id: "unknown-model" },
      inheritedConfig: {},
    });
    expect(result.status).toBe("commit");
    if (result.status !== "commit") return;
    expect(result.model.modelId).toBe("unknown-model");
    expect(result.model.config.properties).toMatchObject({ contextWindow: 200_000 });
    expect(result.model.config.optionSpecs).toMatchObject({
      reasoningLevel: { values: ["disabled", "enabled"], map: "{}" },
    });
    expect(result.model.config.properties?.inputFormat).toMatchObject({
      supportsText: true,
      supportsImage: false,
    });
  });

  it("远端模态元数据优先于继承值，写入 Personal Overlay", () => {
    const result = buildImportedRemoteModel({
      entry: { id: "m", inputModalities: ["text", "image", "pdf"] },
      inheritedConfig: {
        properties: {
          contextWindow: 4096,
          inputFormat: {
            supportsText: true,
            supportsImage: false,
            supportsVideo: false,
            supportsAudio: false,
            supportsPdf: false,
          },
        },
      },
    });
    expect(result.status).toBe("commit");
    if (result.status !== "commit") return;
    expect(result.model.personalConfig.properties?.inputFormat).toMatchObject({
      supportsImage: true,
      supportsPdf: true,
    });
    // 远端未声明的模态回落继承值，不写 Personal。
    expect(result.model.personalConfig.properties?.inputFormat).not.toHaveProperty("supportsVideo");
  });
});

describe("从接口获取模型列表", () => {
  beforeEach(() => {
    providerSettingsServiceMock.resolveModelConfig.mockReset();
    providerSettingsServiceMock.resolveModelConfig.mockResolvedValue({
      inheritedConfig: inheritAllConfig,
      effectiveConfig: inheritAllConfig,
      issues: [],
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("未装配能力时不渲染按钮，连接信息未保存时禁用", () => {
    renderSection({});
    expect(screen.queryByText("从接口获取")).toBeNull();

    cleanup();
    renderSection({
      onFetchRemoteModels: vi.fn(),
      fetchRemoteModelsEnabled: false,
    });
    expect(
      (screen.getByTestId("model-provider-fetch-remote-models-button") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("获取后展示列表并支持多选批量添加，自动配置上下文与模态", async () => {
    const onAddModel = vi.fn(async () => undefined);
    renderSection({
      onFetchRemoteModels: vi.fn(async () => ({
        models: [
          { id: "vision-model", contextWindow: 262_144, maxOutputTokens: 65_536 },
          { id: "plain-model" },
        ],
      })),
      onAddModel,
    });

    fireEvent.click(screen.getByTestId("model-provider-fetch-remote-models-button"));
    await act(async () => {
      await Promise.resolve();
    });

    const rows = document.querySelectorAll<HTMLElement>("[role='checkbox'][tabindex]");
    expect(rows).toHaveLength(2);
    fireEvent.click(rows[0]!);
    fireEvent.click(rows[1]!);
    expect(screen.getByText("已选择 2 个模型")).toBeTruthy();

    fireEvent.click(screen.getByTestId("import-remote-models-confirm"));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onAddModel).toHaveBeenCalledTimes(2);
    const visionCall = onAddModel.mock.calls.find(([model]) => model.modelId === "vision-model")!;
    expect(visionCall![0].config.properties).toMatchObject({ contextWindow: 262_144 });
    expect(visionCall![0].config.optionSpecs).toMatchObject({ maxOutputTokens: { max: 65_536 } });
    // 内置规则有该模型 ID 匹配时保持推荐模态；远端未声明不覆盖。
    expect(visionCall![0].useRecommendedConfig).toBe(true);
    // 无远端元数据时回退该 Provider 身份下的推荐配置基线（mock 规则给出 128000）。
    const plainCall = onAddModel.mock.calls.find(([model]) => model.modelId === "plain-model")!;
    expect(plainCall![0].config.properties).toMatchObject({ contextWindow: 128_000 });
  });

  it("远端声明的模态写入 Personal Overlay", async () => {
    const onAddModel = vi.fn(async () => undefined);
    renderSection({
      onFetchRemoteModels: vi.fn(async () => ({
        models: [{ id: "vision-model", inputModalities: ["text", "image"] }],
      })),
      onAddModel,
    });

    fireEvent.click(screen.getByTestId("model-provider-fetch-remote-models-button"));
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(document.querySelector<HTMLElement>("[role='checkbox'][tabindex]")!);
    fireEvent.click(screen.getByTestId("import-remote-models-confirm"));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onAddModel.mock.calls[0]?.[0].personalConfig.properties).toMatchObject({
      inputFormat: { supportsImage: true },
    });
  });

  it("已存在的模型禁用勾选且不会重复添加", async () => {
    const onAddModel = vi.fn(async () => undefined);
    renderSection({
      models: [
        {
          kind: "candidate",
          modelId: "vision-model",
          builtin: false,
          personalConfig: {},
          config: inheritAllConfig,
          hasPersonalConfig: true,
          executable: true,
          selectable: true,
        },
      ],
      onFetchRemoteModels: vi.fn(async () => ({
        models: [{ id: "vision-model" }, { id: "new-model" }],
      })),
      onAddModel,
    });

    fireEvent.click(screen.getByTestId("model-provider-fetch-remote-models-button"));
    await act(async () => {
      await Promise.resolve();
    });

    const rows = document.querySelectorAll<HTMLElement>("[role='checkbox'][tabindex]");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText("已添加")).toBeTruthy();
    fireEvent.click(rows[0]!);
    fireEvent.click(rows[1]!);
    fireEvent.click(screen.getByTestId("import-remote-models-confirm"));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onAddModel).toHaveBeenCalledTimes(1);
    expect(onAddModel.mock.calls[0]?.[0].modelId).toBe("new-model");
  });

  it("部分失败保留已成功项，失败原因展示且保持可重试", async () => {
    providerSettingsServiceMock.resolveModelConfig
      .mockResolvedValueOnce({
        inheritedConfig: inheritAllConfig,
        effectiveConfig: inheritAllConfig,
        issues: [],
      })
      .mockRejectedValueOnce(new Error("config resolution unavailable"));
    const onAddModel = vi.fn(async () => undefined);
    renderSection({
      onFetchRemoteModels: vi.fn(async () => ({
        models: [{ id: "first-model" }, { id: "broken-model" }],
      })),
      onAddModel,
    });

    fireEvent.click(screen.getByTestId("model-provider-fetch-remote-models-button"));
    await act(async () => {
      await Promise.resolve();
    });
    const rows = document.querySelectorAll<HTMLElement>("[role='checkbox'][tabindex]");
    fireEvent.click(rows[0]!);
    fireEvent.click(rows[1]!);
    fireEvent.click(screen.getByTestId("import-remote-models-confirm"));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onAddModel).toHaveBeenCalledTimes(1);
    expect(screen.getByText("config resolution unavailable")).toBeTruthy();
    expect(
      screen.getByText("已添加 1 个模型，1 个失败；失败的模型仍保持勾选，可直接重试。"),
    ).toBeTruthy();
    // 对话框保持打开，可重试失败项。
    expect(screen.getByTestId("import-remote-models-confirm")).toBeTruthy();
  });

  it("获取失败通过反馈 toast 展示且支持重试，不挤压按钮行", async () => {
    const onFetchRemoteModels = vi
      .fn()
      .mockRejectedValueOnce(new Error("获取模型列表被拒绝（API Key 无效或无权限）"))
      .mockResolvedValue({ models: [{ id: "retried-model" }] });
    renderSection({ onFetchRemoteModels });
    fireEvent.click(screen.getByTestId("model-provider-fetch-remote-models-button"));
    await act(async () => {
      await Promise.resolve();
    });

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("获取模型列表被拒绝（API Key 无效或无权限）");
    // 错误在覆盖层反馈区，不在模型区按钮行内展开。
    expect(
      document
        .querySelector("[data-provider-detail-feedback-state='failure']")!
        .contains(screen.getByTestId("model-provider-fetch-remote-models-button")),
    ).toBe(false);
    expect(screen.queryByText("从接口获取模型")).toBeNull();

    // 点击重试后成功拉取并打开对话框。
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(onFetchRemoteModels).toHaveBeenCalledTimes(2);
    expect(screen.getByText("从接口获取模型")).toBeTruthy();
  });
});
