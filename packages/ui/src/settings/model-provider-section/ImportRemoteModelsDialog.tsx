import { useMemo, useState } from "react";
import { Loader2Icon, SearchIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Input } from "@/components/ui/input.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { ModelConfigObject } from "@zcode/provider";
import type { RemoteModelListEntry } from "@zcode/services";
import type { ProviderSettingsFormModel } from "@/lib/providerSettingsFormTypes.js";
import { logger } from "@/logger.js";
import { ModelOptionCheckbox } from "@/settings/model-provider-section/ProviderModelMetadataFields.js";
import { buildImportedRemoteModel } from "@/settings/model-provider-section/remoteModelImport.js";

export interface ImportRemoteModelsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  providerId: string;
  /** 远端模型列表条目（已按 id 去重）。 */
  entries: readonly RemoteModelListEntry[];
  /** 已存在的模型 ID；对应行禁用勾选，不重复添加。 */
  existingModelIds: readonly string[];
  /** 逐个模型取推荐配置基线；与「添加模型」弹窗同一解析入口。 */
  resolveModelConfig: (modelId: string) => Promise<{ inheritedConfig: ModelConfigObject }>;
  /** 复用「添加模型」的保存事务与反馈；失败不回滚已成功的模型。 */
  onAddModel: (model: ProviderSettingsFormModel) => void | Promise<unknown>;
}

interface ImportRowState {
  readonly entry: RemoteModelListEntry;
  readonly exists: boolean;
}

export function ImportRemoteModelsDialog({
  open,
  onOpenChange,
  providerId,
  entries,
  existingModelIds,
  resolveModelConfig,
  onAddModel,
}: ImportRemoteModelsDialogProps) {
  const { intl } = useZCodeIntl();
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [searchValue, setSearchValue] = useState("");
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importSummary, setImportSummary] = useState<{ added: number; failed: number } | null>(
    null,
  );

  const existingSet = useMemo(() => new Set(existingModelIds), [existingModelIds]);
  const rows = useMemo<ImportRowState[]>(
    () => entries.map((entry) => ({ entry, exists: existingSet.has(entry.id) })),
    [entries, existingSet],
  );
  const filteredRows = useMemo(() => {
    const keyword = searchValue.trim().toLowerCase();
    if (!keyword) return rows;
    return rows.filter((row) => row.entry.id.toLowerCase().includes(keyword));
  }, [rows, searchValue]);
  const selectableRows = filteredRows.filter((row) => !row.exists);
  const allSelectableSelected =
    selectableRows.length > 0 && selectableRows.every((row) => selectedIds.has(row.entry.id));
  const selectedCount = [...selectedIds].filter((id) => !existingSet.has(id)).length;

  const toggleRow = (id: string, selectable: boolean) => {
    if (!selectable) return;
    setImportError(null);
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAllSelectable = () => {
    setImportError(null);
    setSelectedIds((current) => {
      const next = new Set(current);
      if (allSelectableSelected) {
        for (const row of selectableRows) next.delete(row.entry.id);
      } else {
        for (const row of selectableRows) next.add(row.entry.id);
      }
      return next;
    });
  };

  const commitImport = async (): Promise<boolean> => {
    if (importing || selectedCount === 0) return false;
    setImporting(true);
    setImportError(null);
    setImportSummary(null);
    let added = 0;
    let failed = 0;
    let firstError: string | null = null;
    try {
      for (const id of selectedIds) {
        if (existingSet.has(id)) continue;
        const entry = entries.find((item) => item.id === id);
        if (!entry) continue;
        try {
          // 与「添加模型」智能模式同源：先取该模型在当前 Provider 身份下的推荐基线。
          const resolution = await resolveModelConfig(entry.id);
          const result = buildImportedRemoteModel({
            entry,
            inheritedConfig: resolution.inheritedConfig,
          });
          if (result.status !== "commit") {
            failed += 1;
            firstError ??= intl.formatMessage({
              id: `settings.modelProvider.modelMetadata.invalid.${result.field}`,
            });
            continue;
          }
          await onAddModel(result.model);
          added += 1;
        } catch (error) {
          failed += 1;
          firstError ??= error instanceof Error ? error.message : String(error);
          logger.warn("[ImportRemoteModelsDialog] 导入远端模型失败", {
            providerId,
            modelId: id,
            error,
          });
        }
      }
      // 部分失败不回滚已成功的模型；成功项随父层刷新 existingModelIds 自动转为「已添加」禁用行，
      // 失败项保持勾选，用户可直接重试。
      setImportSummary({ added, failed });
      if (failed === 0 && added > 0) {
        // 全部成功才关闭；先清空本会话选择，避免下一次打开残留旧勾选。
        resetDialog();
        onOpenChange(false);
      } else if (failed > 0) {
        setImportError(
          firstError ??
            intl.formatMessage({ id: "settings.modelProvider.importRemoteModels.failure" }),
        );
      }
      return failed === 0;
    } finally {
      setImporting(false);
    }
  };

  const resetDialog = () => {
    setSelectedIds(new Set());
    setSearchValue("");
    setImportError(null);
    setImportSummary(null);
  };

  const handleOpenChange = (next: boolean) => {
    if (importing) return;
    if (!next) resetDialog();
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="max-h-[min(48rem,calc(100vh-4rem))] max-w-xl grid-rows-[auto_minmax(0,1fr)_auto_auto] overflow-clip"
        data-no-model-drag="true"
        data-testid="import-remote-models-dialog"
      >
        <DialogHeader className="pr-8">
          <DialogTitle>
            {intl.formatMessage({ id: "settings.modelProvider.importRemoteModels.title" })}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {intl.formatMessage({ id: "settings.modelProvider.importRemoteModels.description" })}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 min-w-0 -mr-3 space-y-3 overflow-y-auto pr-4">
          <div className="flex items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <SearchIcon
                className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-foreground-subtlest"
                aria-hidden="true"
              />
              <Input
                type="text"
                size="lg"
                className="pl-8"
                value={searchValue}
                placeholder={intl.formatMessage({
                  id: "settings.modelProvider.importRemoteModels.searchPlaceholder",
                })}
                onChange={(event) => setSearchValue(event.target.value)}
              />
            </div>
            <Button
              type="button"
              variant="outline"
              disabled={selectableRows.length === 0}
              onClick={toggleAllSelectable}
            >
              {intl.formatMessage({
                id: allSelectableSelected
                  ? "settings.modelProvider.importRemoteModels.deselectAll"
                  : "settings.modelProvider.importRemoteModels.selectAll",
              })}
            </Button>
          </div>
          {filteredRows.length === 0 ? (
            <div className="flex h-24 items-center justify-center rounded-lg border border-dashed border-border px-4 text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "settings.modelProvider.importRemoteModels.empty" })}
            </div>
          ) : (
            <div className="overflow-hidden rounded-lg border border-input-border bg-input">
              {filteredRows.map((row, index) => {
                const selected = selectedIds.has(row.entry.id);
                return (
                  <div
                    key={row.entry.id}
                    role="checkbox"
                    tabIndex={row.exists ? -1 : 0}
                    aria-checked={selected || row.exists}
                    aria-disabled={row.exists || undefined}
                    data-testid={`import-remote-model-row-${index}`}
                    data-import-remote-model-id={row.entry.id}
                    data-import-remote-model-exists={row.exists || undefined}
                    className={
                      "flex items-center gap-3 border-b border-input-border px-3 py-2 text-ui-base last:border-b-0" +
                      (row.exists ? " cursor-not-allowed opacity-60" : " cursor-pointer")
                    }
                    onClick={() => toggleRow(row.entry.id, !row.exists)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== " ") return;
                      event.preventDefault();
                      toggleRow(row.entry.id, !row.exists);
                    }}
                  >
                    <ModelOptionCheckbox selected={selected || row.exists} />
                    <span className="min-w-0 flex-1 truncate font-mono">{row.entry.id}</span>
                    {row.exists ? (
                      <span className="shrink-0 text-ui-sm text-foreground-subtle">
                        {intl.formatMessage({
                          id: "settings.modelProvider.importRemoteModels.alreadyAdded",
                        })}
                      </span>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
          {importError ? (
            <p role="alert" className="text-ui-sm text-destructive">
              {importError}
            </p>
          ) : null}
          {importSummary && importSummary.failed > 0 ? (
            <p className="text-ui-sm text-foreground-subtle">
              {intl.formatMessage(
                { id: "settings.modelProvider.importRemoteModels.partialSummary" },
                { added: importSummary.added, failed: importSummary.failed },
              )}
            </p>
          ) : null}
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-ui-sm text-foreground-subtle">
            {intl.formatMessage(
              { id: "settings.modelProvider.importRemoteModels.selectedCount" },
              { count: selectedCount },
            )}
          </span>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              disabled={importing}
              onClick={() => handleOpenChange(false)}
            >
              {intl.formatMessage({ id: "common.cancel" })}
            </Button>
            <Button
              type="button"
              data-testid="import-remote-models-confirm"
              disabled={importing || selectedCount === 0}
              onClick={() => void commitImport()}
            >
              {importing ? (
                <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
              ) : null}
              {intl.formatMessage({ id: "settings.modelProvider.importRemoteModels.confirm" })}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
