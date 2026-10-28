import { useCallback, useMemo, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { SessionRequestMetrics } from "@zcode/shared";
import type { SessionPhase, SessionUsageState } from "@zcode/shared/zcode-protocol-v4";
import {
  TID_CHAT_REQUEST_METRICS_PANEL,
  TID_CHAT_REQUEST_METRICS_TRIGGER,
} from "@zcode/shared/test-ids";
import {
  Context,
  ContextContent,
  ContextContentBody,
  ContextTrigger,
} from "@/components/ai-elements/context.js";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { isHoverlessTouchPointerDown } from "@/chat-input-toolbar/contextPanelAction.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useSessionRequestMetrics } from "@/hooks/useSessionDebug.js";
import { formatBytes } from "@/lib/byteSizeFormat.js";

const TPS_UNIT_MESSAGE_ID = "chat.requestMetrics.tpsUnit";
/** 占位符不是文案：缺失即未知，避免把 0 当成「测得 0」。 */
const EMPTY_VALUE = "—";

export type RequestMetricSection = "last" | "aggregate";

export interface RequestMetricRow {
  id: string;
  section: RequestMetricSection;
  labelId: string;
  value: string;
}

/** TPS 单值：与开发者工具面板同一精度（一位小数）；未知值不伪造 0。 */
export function formatTokensPerSecond(locale: string, value: number | null): string {
  if (value === null || !Number.isFinite(value) || value < 0) return EMPTY_VALUE;
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value);
}

/** 时长：秒级用 `s`、毫秒级用 `ms`，避免长时间一律显示成六位毫秒数。 */
export function formatDurationMs(locale: string, value: number | null): string {
  if (value === null || !Number.isFinite(value) || value < 0) return EMPTY_VALUE;
  const format = (input: number, maximumFractionDigits: number) =>
    new Intl.NumberFormat(locale, { maximumFractionDigits }).format(input);
  return value >= 1_000 ? `${format(value / 1_000, 1)} s` : `${format(value, 0)} ms`;
}

/** zstd 压缩率 = 压缩后 / 原始（越小越好）；同时展示原始与压缩尺寸由调用方拼接。 */
export function formatCompressionPercent(locale: string, ratio: number | null): string {
  if (ratio === null || !Number.isFinite(ratio) || ratio < 0) return EMPTY_VALUE;
  return new Intl.NumberFormat(locale, {
    maximumFractionDigits: 1,
    style: "percent",
  }).format(ratio);
}

function formatOptionalBytes(value: number | null | undefined): string {
  return value === null || value === undefined ? EMPTY_VALUE : formatBytes(value);
}

function formatZstdSizes(
  intl: ReturnType<typeof useZCodeIntl>["intl"],
  raw: number,
  compressed: number,
) {
  return intl.formatMessage(
    { id: "chat.requestMetrics.zstdSizes" },
    { raw: formatBytes(raw), compressed: formatBytes(compressed) },
  );
}

/**
 * 面板行：最近一次请求 6 行 + 会话平均/累计 8 行。
 *
 * 顺序即产品口径顺序：先看本次，再看会话；缺样本的行保留并显示占位符，
 * 让用户能判断「本来就没有」与「这次没测到」，而不是整行消失。
 */
export function buildRequestMetricsRows(
  metrics: SessionRequestMetrics,
  intl: ReturnType<typeof useZCodeIntl>["intl"],
  locale: string,
): RequestMetricRow[] {
  const last = metrics.last;
  const aggregate = metrics.aggregate;
  const lastZstd =
    last && last.requestBodyBytes !== null && last.requestBodyCompressedBytes !== null
      ? formatZstdSizes(intl, last.requestBodyBytes, last.requestBodyCompressedBytes)
      : EMPTY_VALUE;
  const zstdRatioValue =
    aggregate.zstd.compressionRatio === null
      ? EMPTY_VALUE
      : `${formatCompressionPercent(locale, aggregate.zstd.compressionRatio)} · ${formatZstdSizes(
          intl,
          aggregate.zstd.totalRequestBodyBytes,
          aggregate.zstd.totalCompressedBytes,
        )}`;
  return [
    {
      id: "decodeTps",
      section: "last",
      labelId: "chat.requestMetrics.decodeTps",
      value: `${formatTokensPerSecond(locale, last?.decodeTps ?? null)} t/s`,
    },
    {
      id: "ttft",
      section: "last",
      labelId: "chat.requestMetrics.ttft",
      value: formatDurationMs(locale, last?.timeToFirstContentMs ?? null),
    },
    {
      id: "tpsWithTtft",
      section: "last",
      labelId: "chat.requestMetrics.tpsWithTtft",
      value: `${formatTokensPerSecond(locale, last?.tpsWithTimeToFirstContent ?? null)} t/s`,
    },
    {
      id: "requestBody",
      section: "last",
      labelId: "chat.requestMetrics.requestBody",
      value: formatOptionalBytes(last?.requestBodyBytes),
    },
    {
      id: "bodyUploadMs",
      section: "last",
      labelId: "chat.requestMetrics.bodyUploadMs",
      value: formatDurationMs(locale, last?.requestBodyUploadMs ?? null),
    },
    {
      id: "zstdLast",
      section: "last",
      labelId: "chat.requestMetrics.zstdLast",
      value: lastZstd,
    },
    {
      id: "avgDecodeTps",
      section: "aggregate",
      labelId: "chat.requestMetrics.avgDecodeTps",
      value: `${formatTokensPerSecond(locale, aggregate.averageDecodeTps)} t/s`,
    },
    {
      id: "avgTpsWithTtft",
      section: "aggregate",
      labelId: "chat.requestMetrics.avgTpsWithTtft",
      value: `${formatTokensPerSecond(locale, aggregate.averageTpsWithTimeToFirstContent)} t/s`,
    },
    {
      id: "avgTtft",
      section: "aggregate",
      labelId: "chat.requestMetrics.avgTtft",
      value: formatDurationMs(locale, aggregate.averageTimeToFirstContentMs),
    },
    {
      id: "avgRequestBody",
      section: "aggregate",
      labelId: "chat.requestMetrics.avgRequestBody",
      value: formatOptionalBytes(aggregate.averageRequestBodyBytes),
    },
    {
      id: "totalRequestBody",
      section: "aggregate",
      labelId: "chat.requestMetrics.totalRequestBody",
      value:
        aggregate.requestBodySampleCount === 0
          ? EMPTY_VALUE
          : formatBytes(aggregate.totalRequestBodyBytes),
    },
    {
      id: "avgBodyUploadMs",
      section: "aggregate",
      labelId: "chat.requestMetrics.avgBodyUploadMs",
      value: formatDurationMs(locale, aggregate.averageRequestBodyUploadMs),
    },
    {
      id: "totalBodyUploadMs",
      section: "aggregate",
      labelId: "chat.requestMetrics.totalBodyUploadMs",
      value:
        aggregate.uploadSampleCount === 0
          ? EMPTY_VALUE
          : formatDurationMs(locale, aggregate.totalRequestBodyUploadMs),
    },
    {
      id: "zstdRatio",
      section: "aggregate",
      labelId: "chat.requestMetrics.zstdRatio",
      value: zstdRatioValue,
    },
  ];
}

/** 是否有可展示的请求指标；无主轮请求或旧宿主不支持时整个药丸不渲染。 */
export function hasRequestMetricsData(
  metrics: SessionRequestMetrics | null,
): metrics is SessionRequestMetrics & { last: NonNullable<SessionRequestMetrics["last"]> } {
  return metrics !== null && metrics.last !== null;
}

/**
 * 输入框上下文指示器左侧的请求性能药丸。
 *
 * 数据是持久化的完成态事实（`model_usage`），不随流式 token 更新：只在会话切换、usage 变化或
 * 回合结束时读一次，避免常驻轮询。
 */
export function RequestMetricsPill({
  workspacePath,
  workspaceIdentity,
  sessionId,
  phase,
  usage,
  enabled = true,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId: string | null;
  phase: SessionPhase | null;
  /** 会话 usage 投影：每完成一次主轮请求就推进，驱动按请求节拍的刷新。 */
  usage: SessionUsageState | null;
  /** 设置页/草稿态等不应发起查询的场景由调用方关闭。 */
  enabled?: boolean;
}) {
  const { intl, locale } = useZCodeIntl();
  const [open, setOpen] = useState(false);
  // usage.cumulative 每完成一次主轮请求就推进，因此这里按请求节拍刷新；phase 由 running 变为
  // 其它值严格晚于 core 的 model_usage 写入，是最后一次可靠刷新。
  const refreshKey = `${phase === "running" ? "run" : "idle"}:${usage?.cumulative.outputTokens ?? 0}`;
  const { metrics } = useSessionRequestMetrics({
    workspacePath,
    workspaceIdentity,
    taskId: sessionId,
    enabled,
    refreshKey,
  });
  const rows = useMemo(
    () => (metrics ? buildRequestMetricsRows(metrics, intl, locale) : []),
    [intl, locale, metrics],
  );
  const lastRows = useMemo(
    () => rows.filter((row) => row.section === "last"),
    [rows],
  );
  const aggregateRows = useMemo(
    () => rows.filter((row) => row.section === "aggregate"),
    [rows],
  );
  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (isHoverlessTouchPointerDown(event) && !open) setOpen(true);
    },
    [open],
  );

  if (!hasRequestMetricsData(metrics)) return null;

  const tpsLabel =
    metrics.last.decodeTps === null
      ? EMPTY_VALUE
      : `${formatTokensPerSecond(locale, metrics.last.decodeTps)} ${intl.formatMessage({ id: TPS_UNIT_MESSAGE_ID })}`;
  const ariaLabel = intl.formatMessage({ id: "chat.requestMetrics" }, { tps: tpsLabel });
  const sampleLabel = intl.formatMessage(
    { id: "chat.requestMetrics.sample" },
    {
      count: new Intl.NumberFormat(locale).format(metrics.aggregate.requestBodySampleCount),
    },
  );

  return (
    <Context
      usedTokens={usage?.contextWindow?.usedTokens ?? 0}
      maxTokens={usage?.contextWindow?.maxTokens ?? 1}
      open={open}
      onOpenChange={setOpen}
    >
      <ContextTrigger>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={ariaLabel}
          data-testid={TID_CHAT_REQUEST_METRICS_TRIGGER}
          data-chat-toolbar-popover-trigger="true"
          // 与 ThoughtLevelCycleControl 共用工具条收起契约：空间不足时最后一级隐藏纯观测信息。
          data-composer-collapse-priority="3"
          onPointerDown={handlePointerDown}
          className={cn(
            "h-6 shrink-0 gap-1 rounded-full px-2 font-mono text-ui-xs tabular-nums",
            "text-foreground-subtle hover:bg-hover",
            "data-[composer-compact]:hidden",
          )}
        >
          {tpsLabel}
        </Button>
      </ContextTrigger>
      <ContextContent
        className="!w-80 !rounded-xl !shadow-md"
        data-testid={TID_CHAT_REQUEST_METRICS_PANEL}
        side="top"
        sideOffset={2}
      >
        {/* 长内容不能撑出视口：Radix 暴露可用高度，超出时面板内部滚动。 */}
        <ContextContentBody className="max-h-(--radix-hover-card-content-available-height) space-y-3 overflow-auto">
          <div className="flex min-w-0 items-center gap-3">
            <span className="shrink-0 text-ui-base font-medium text-foreground">
              {intl.formatMessage({ id: "chat.requestMetrics.title" })}
            </span>
            <span className="ml-auto shrink-0 font-mono text-ui-sm text-foreground-subtle tabular-nums">
              {tpsLabel}
            </span>
          </div>
          <RequestMetricsSection
            headingId="chat.requestMetrics.section.last"
            intl={intl}
            rows={lastRows}
          />
          <RequestMetricsSection
            className="border-t border-border pt-3"
            headingId="chat.requestMetrics.section.aggregate"
            intl={intl}
            rows={aggregateRows}
          />
          <div className="text-ui-xs text-foreground-subtlest">{sampleLabel}</div>
        </ContextContentBody>
      </ContextContent>
    </Context>
  );
}

function RequestMetricsSection({
  className,
  headingId,
  intl,
  rows,
}: {
  className?: string;
  headingId: string;
  intl: ReturnType<typeof useZCodeIntl>["intl"];
  rows: readonly RequestMetricRow[];
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="text-ui-sm font-medium text-foreground-subtle">
        {intl.formatMessage({ id: headingId })}
      </div>
      <div className="grid gap-1.5">
        {rows.map((row) => (
          <div className="flex min-w-0 items-center gap-3 text-ui-sm" key={row.id}>
            <span className="min-w-0 truncate text-foreground-subtle">
              {intl.formatMessage({ id: row.labelId })}
            </span>
            <span className="ml-auto shrink-0 text-right font-mono text-ui-sm tabular-nums text-foreground">
              {row.value}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
