import { useEffect, useState } from "react";
import {
  SESSION_DEBUG_SCOPE_ALL,
  SESSION_DEBUG_SCOPE_REQUEST_METRICS,
  type SessionDebugScope,
  type SessionDebugSnapshot,
  type SessionRequestMetrics,
} from "@zcode/shared";
import { useServices } from "@/hooks/useServices.js";
import { getWorkspaceKey } from "@/lib/workspaceKey.js";

const REFRESH_INTERVAL_MS = 1000;
const EMPTY_DEBUG: Pick<SessionDebugSnapshot, "rounds" | "networkEntries" | "cache"> = {
  rounds: [],
  networkEntries: [],
  cache: null,
};

function scopeKeyOf(
  workspaceIdentity: string | undefined,
  workspacePath: string,
  taskId: string | null,
): string {
  return JSON.stringify([getWorkspaceKey(workspacePath, workspaceIdentity), taskId]);
}

function useSessionDebugRead({
  workspacePath,
  workspaceIdentity,
  taskId,
  enabled,
  scope,
  refreshKey,
  poll,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string | null;
  enabled: boolean;
  scope: SessionDebugScope;
  refreshKey: string | number;
  /** true 时按完成节拍循环读取；false 时只在 `refreshKey` 变化时读一次。 */
  poll: boolean;
}) {
  const { zcodeAgentService } = useServices();
  const scopeKey = scopeKeyOf(workspaceIdentity, workspacePath, taskId);
  const [result, setResult] = useState<{
    key: string;
    service: typeof zcodeAgentService;
    data: SessionDebugSnapshot | null;
    error: boolean;
  } | null>(null);
  useEffect(() => {
    if (!enabled || !taskId) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      try {
        const data = await zcodeAgentService.readSessionDebug({
          workspacePath,
          workspaceIdentity,
          sessionId: taskId,
          scope,
        });
        if (!disposed) setResult({ key: scopeKey, service: zcodeAgentService, data, error: false });
      } catch {
        if (!disposed)
          setResult((previous) => ({
            key: scopeKey,
            service: zcodeAgentService,
            data:
              previous?.key === scopeKey && previous.service === zcodeAgentService
                ? previous.data
                : null,
            error: true,
          }));
      } finally {
        // 调试查询按完成节拍刷新，不重叠请求；切任务后的旧结果不能覆盖新任务。
        if (!disposed && poll) timer = setTimeout(() => void refresh(), REFRESH_INTERVAL_MS);
      }
    };
    void refresh();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [
    enabled,
    poll,
    refreshKey,
    scope,
    scopeKey,
    taskId,
    workspaceIdentity,
    workspacePath,
    zcodeAgentService,
  ]);
  const current = result?.key === scopeKey && result.service === zcodeAgentService ? result : null;
  return { data: current?.data ?? null, error: current?.error ?? false };
}

export function useSessionDebug({
  workspacePath,
  workspaceIdentity,
  taskId,
  enabled = true,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string | null;
  enabled?: boolean;
}) {
  const read = useSessionDebugRead({
    workspacePath,
    workspaceIdentity,
    taskId,
    enabled,
    scope: SESSION_DEBUG_SCOPE_ALL,
    refreshKey: 0,
    poll: true,
  });
  return { ...(read.data ?? EMPTY_DEBUG), error: read.error };
}

/**
 * 会话级请求指标（请求体 / 上传耗时 / TPS / TTFT）。
 *
 * 与开发者工具面板不同，这里**不做节拍轮询**：数据是持久化的完成态事实，只在 `refreshKey`
 * 声明的语义变化时读一次（会话切换、usage 变化、回合结束、面板打开）。
 */
export function useSessionRequestMetrics({
  workspacePath,
  workspaceIdentity,
  taskId,
  enabled = true,
  refreshKey = 0,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string | null;
  enabled?: boolean;
  refreshKey?: string | number;
}): { metrics: SessionRequestMetrics | null; error: boolean } {
  const read = useSessionDebugRead({
    workspacePath,
    workspaceIdentity,
    taskId,
    enabled,
    scope: SESSION_DEBUG_SCOPE_REQUEST_METRICS,
    refreshKey,
    poll: false,
  });
  return { metrics: read.data?.requestMetrics ?? null, error: read.error };
}
