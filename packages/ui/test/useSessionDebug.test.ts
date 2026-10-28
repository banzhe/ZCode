// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IServiceAccessor } from "@zcode/services";
import type { SessionDebugSnapshot } from "@zcode/shared";
import { ServiceProvider } from "../src/hooks/useServices.js";
import { useSessionDebug, useSessionRequestMetrics } from "../src/hooks/useSessionDebug.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
const snapshot = (sessionId: string): SessionDebugSnapshot => ({
  sessionId,
  rounds: [],
  networkEntries: [],
  cache: { hitRateRequestCount: 1, totalInputTokens: 100, totalCacheReadTokens: 80, hitRate: 0.8 },
});
function setup(readSessionDebug: ReturnType<typeof vi.fn>) {
  const services = { zcodeAgentService: { readSessionDebug } } as unknown as IServiceAccessor;
  return ({ children }: { children: React.ReactNode }) =>
    createElement(ServiceProvider, { services, children });
}
describe("useSessionDebug", () => {
  it("discards pending results across task/workspace switches", async () => {
    let completeOld!: (data: SessionDebugSnapshot) => void;
    const read = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            completeOld = resolve;
          }),
      )
      .mockResolvedValue(snapshot("new"));
    const { result, rerender } = renderHook(useSessionDebug, {
      wrapper: setup(read),
      initialProps: { workspacePath: "/same", workspaceIdentity: "ssh:one", taskId: "old" },
    });
    rerender({ workspacePath: "/same", workspaceIdentity: "ssh:two", taskId: "new" });
    await waitFor(() => expect(result.current.cache?.hitRateRequestCount).toBe(1));
    await act(async () => {
      completeOld({ ...snapshot("old"), cache: null });
    });
    expect(result.current.cache?.hitRateRequestCount).toBe(1);
    expect(read).toHaveBeenLastCalledWith({
      workspacePath: "/same",
      workspaceIdentity: "ssh:two",
      sessionId: "new",
      // 开发者工具面板走完整 live 观测快照；requestMetrics scope 只服务输入框药丸。
      scope: "all",
    });
  });
  it("does not poll a hidden panel and shows read failures", async () => {
    const read = vi.fn().mockRejectedValue(new Error("not supported"));
    const { result, rerender } = renderHook(useSessionDebug, {
      wrapper: setup(read),
      initialProps: { workspacePath: "/work", taskId: "task", enabled: false },
    });
    expect(read).not.toHaveBeenCalled();
    rerender({ workspacePath: "/work", taskId: "task", enabled: true });
    await waitFor(() => expect(result.current.error).toBe(true));
    expect(result.current.rounds).toEqual([]);
  });
  it("refreshes serially and stops after hiding", async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockResolvedValue(snapshot("task"));
    const { rerender } = renderHook(useSessionDebug, {
      wrapper: setup(read),
      initialProps: { workspacePath: "/work", taskId: "task", enabled: true },
    });
    await act(async () => {});
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(read).toHaveBeenCalledTimes(2);
    rerender({ workspacePath: "/work", taskId: "task", enabled: false });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(read).toHaveBeenCalledTimes(2);
  });
  it("reads request metrics only when the refresh key changes", async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockResolvedValue({
      ...snapshot("task"),
      requestMetrics: {
        sessionId: "task",
        last: {
          requestBodyBytes: 1_000,
          requestBodyCompressedBytes: null,
          requestBodyUploadMs: 40,
          decodeTps: 40,
          timeToFirstContentMs: 1_000,
          tpsWithTimeToFirstContent: 20,
        },
        aggregate: {
          requestBodySampleCount: 1,
          totalRequestBodyBytes: 1_000,
          averageRequestBodyBytes: 1_000,
          uploadSampleCount: 1,
          totalRequestBodyUploadMs: 40,
          averageRequestBodyUploadMs: 40,
          tpsSampleCount: 1,
          averageDecodeTps: 40,
          averageTpsWithTimeToFirstContent: 20,
          ttftSampleCount: 1,
          averageTimeToFirstContentMs: 1_000,
          zstd: {
            requestCount: 0,
            totalRequestBodyBytes: 0,
            totalCompressedBytes: 0,
            compressionRatio: null,
          },
        },
      },
    });
    const { result, rerender } = renderHook(useSessionRequestMetrics, {
      wrapper: setup(read),
      initialProps: { workspacePath: "/work", taskId: "task", enabled: true, refreshKey: "idle:1" },
    });
    await act(async () => {});
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionId: "task", scope: "requestMetrics" }),
    );

    // 与开发者工具面板不同：不做完成节拍轮询。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(read).toHaveBeenCalledTimes(1);

    rerender({ workspacePath: "/work", taskId: "task", enabled: true, refreshKey: "idle:2" });
    await act(async () => {});
    expect(read).toHaveBeenCalledTimes(2);
    expect(result.current.metrics?.last?.decodeTps).toBe(40);
  });
});
