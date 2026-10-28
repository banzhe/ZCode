import { useState } from "react";
import { createRoot } from "react-dom/client";
import { RequestMetricsPill } from "@/chat-input-toolbar/RequestMetricsPill.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import type { IServiceAccessor } from "@zcode/services";
import type { SessionDebugSnapshot, SessionRequestMetrics } from "@zcode/shared";
import "@/styles.css";

const params = new URLSearchParams(location.search);
document.documentElement.classList.add(
  params.get("theme") === "light" ? "theme-zai-light" : "theme-zai-dark",
);

const REQUEST_METRICS: SessionRequestMetrics = {
  sessionId: "session-1",
  last: {
    requestBodyBytes: 1_200_000,
    requestBodyCompressedBytes: 200_000,
    requestBodyUploadMs: 320,
    decodeTps: 42.1,
    timeToFirstContentMs: 850,
    tpsWithTimeToFirstContent: 12.5,
  },
  aggregate: {
    requestBodySampleCount: 3,
    totalRequestBodyBytes: 3_600_000,
    averageRequestBodyBytes: 1_200_000,
    uploadSampleCount: 3,
    totalRequestBodyUploadMs: 1_200,
    averageRequestBodyUploadMs: 400,
    tpsSampleCount: 3,
    averageDecodeTps: 38.4,
    averageTpsWithTimeToFirstContent: 18.2,
    ttftSampleCount: 3,
    averageTimeToFirstContentMs: 900,
    zstd: {
      requestCount: 3,
      totalRequestBodyBytes: 3_600_000,
      totalCompressedBytes: 600_000,
      compressionRatio: 1 / 6,
    },
  },
};

const services = {
  zcodeAgentService: {
    readSessionDebug: async (target: { sessionId: string; scope?: string }) => {
      if (target.sessionId !== "session-1") {
        return {
          sessionId: target.sessionId,
          rounds: [],
          networkEntries: [],
          cache: null,
        } satisfies SessionDebugSnapshot;
      }
      return {
        sessionId: target.sessionId,
        rounds: [],
        networkEntries: [],
        cache: null,
        ...(target.scope === "requestMetrics" ? { requestMetrics: REQUEST_METRICS } : {}),
      } satisfies SessionDebugSnapshot;
    },
  },
} as unknown as IServiceAccessor;

function Fixture() {
  const [sessionId, setSessionId] = useState<string | null>("session-1");
  return (
    <main className="min-h-screen min-w-0 bg-background p-4 text-foreground">
      <button type="button" onClick={() => setSessionId("session-2")}>
        Switch task
      </button>
      <div className="mt-4 flex min-w-0 items-center gap-1">
        <RequestMetricsPill
          workspacePath="/metrics"
          workspaceIdentity="ssh:metrics"
          sessionId={sessionId}
          phase="completedSuccess"
          usage={{
            contextWindow: {
              usedTokens: 12_000,
              maxTokens: 200_000,
              autoCompactThresholdTokens: null,
            },
            cumulative: {
              inputTokens: 0,
              outputTokens: 1_234,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            },
          }}
        />
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <ServiceProvider services={services}>
    <ZCodeIntlProvider initialLocale={params.get("locale") === "en-US" ? "en-US" : "zh-CN"}>
      <Fixture />
    </ZCodeIntlProvider>
  </ServiceProvider>,
);
