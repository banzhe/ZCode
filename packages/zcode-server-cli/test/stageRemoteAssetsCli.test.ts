import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { spawn, begin, collect } = vi.hoisted(() => ({
  spawn: vi.fn(),
  begin: vi.fn(),
  collect: vi.fn(),
}));
vi.mock("node:child_process", () => ({ spawn }));

const releaseModulePath = fileURLToPath(
  new URL("../src/packaging/remoteAssetRelease.ts", import.meta.url),
);
const cliModulePath = fileURLToPath(
  new URL("../src/packaging/stageRemoteAssetsCli.ts", import.meta.url),
);
const allTargets = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"];

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  begin.mockResolvedValue(undefined);
  collect.mockResolvedValue([]);
  spawn.mockImplementation(() => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("exit", 0));
    return child;
  });
  vi.doMock(releaseModulePath, () => ({
    SOURCE_SERVER_REMOTE_RELEASE_TARGETS: allTargets,
    beginSourceServerRemoteReleaseGeneration: begin,
    collectSourceServerRemoteReleaseArchives: collect,
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.doUnmock(releaseModulePath);
});

async function runCli(args: string[]) {
  vi.spyOn(process, "argv", "get").mockReturnValue([process.execPath, cliModulePath, ...args]);
  await import(cliModulePath);
}

describe("remote asset staging CLI", () => {
  it("wires the root Linux command to the existing staging entry", async () => {
    const rootPackage = JSON.parse(
      await readFile(new URL("../../../package.json", import.meta.url), "utf8"),
    );
    expect(rootPackage.scripts["prepare:remote-assets:linux"]).toBe(
      "pnpm --filter @zcode/server-cli stage:remote-assets --linux",
    );
  });

  it.each([
    [undefined, "production"],
    ["   ", "production"],
    [" TEST ", "test"],
    ["production", "production"],
  ])("stages only Linux targets with ZCODE_ENV=%s", async (input, expected) => {
    vi.stubEnv("ZCODE_ENV", input);
    await runCli(["--linux"]);
    expect(spawn.mock.calls.map((call) => call[1])).toEqual([
      ["--filter", "@zcode/server-cli", "build"],
      [
        "--filter",
        "@zcode/server-cli",
        "exec",
        "tsx",
        "src/packaging/stageCli.ts",
        "--target",
        "linux-x64",
        "--skip-component-archives",
      ],
      [
        "--filter",
        "@zcode/server-cli",
        "exec",
        "tsx",
        "src/packaging/stageCli.ts",
        "--target",
        "linux-arm64",
        "--skip-component-archives",
        "--skip-agent-build",
      ],
    ]);
    for (const call of spawn.mock.calls) {
      expect(call[2].env.ZCODE_ENV).toBe(expected);
    }
    expect(collect).toHaveBeenCalledWith(
      expect.objectContaining({ targets: ["linux-x64", "linux-arm64"] }),
    );
    expect(begin.mock.invocationCallOrder[0]).toBeLessThan(spawn.mock.invocationCallOrder[0]!);
    expect(collect.mock.invocationCallOrder[0]).toBeGreaterThan(
      spawn.mock.invocationCallOrder.at(-1)!,
    );
  });

  it("preserves all four targets and environment for the default entry", async () => {
    vi.stubEnv("ZCODE_ENV", undefined);
    await runCli([]);
    expect(spawn).toHaveBeenCalledTimes(5);
    expect(spawn.mock.calls.slice(1).map((call) => call[1][6])).toEqual(allTargets);
    for (const call of spawn.mock.calls) {
      expect(call[1]).not.toContain("--skip-component-archives");
    }
    expect(spawn.mock.calls[0]![2].env?.ZCODE_ENV).toBeUndefined();
    expect(collect).toHaveBeenCalledWith(expect.objectContaining({ targets: allTargets }));
  });

  it("发布入口显式请求时才对全部目标跳过组件归档", async () => {
    vi.stubEnv("ZCODE_ENV", undefined);
    await runCli(["--skip-component-archives"]);
    const targetCalls = spawn.mock.calls.slice(1).map((call) => call[1]);
    expect(targetCalls).toHaveLength(allTargets.length);
    for (const args of targetCalls) {
      expect(args).toContain("--skip-component-archives");
    }
    // agent bundle 仍只由第一个目标构建，其余目标复用（fail-closed 由 stageCli 负责）。
    expect(targetCalls[0]).not.toContain("--skip-agent-build");
    for (const args of targetCalls.slice(1)) {
      expect(args).toContain("--skip-agent-build");
    }
  });

  it("为构建与每个目标输出 [ci][timer] 阶段计时", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await runCli([]);
    const lines = logSpy.mock.calls.map((call) => String(call[0]));
    for (const label of [
      "remote-assets:server-cli-build",
      ...allTargets.map((target) => `remote-assets:${target}`),
    ]) {
      expect(lines).toContain(`[ci][timer] ${label} start`);
      expect(lines.some((line) => line.startsWith(`[ci][timer] ${label} end duration_ms=`))).toBe(
        true,
      );
    }
  });

  it("rejects invalid Linux environments before invalidating or building", async () => {
    vi.stubEnv("ZCODE_ENV", "invalid");
    await expect(runCli(["--linux"])).rejects.toThrow(/Invalid ZCODE_ENV/);
    expect(begin).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(collect).not.toHaveBeenCalled();
  });

  it("Windows 下保留 pnpm 命令名并交给 shell 解析 .cmd 垫片", async () => {
    // 回归：改写命令名为 pnpm.cmd 会触发 spawn EINVAL（Actions run 40510679016）。
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    await runCli([]);
    expect(spawn).toHaveBeenCalledTimes(5);
    for (const call of spawn.mock.calls) {
      expect(call[0]).toBe("pnpm");
      expect(call[2].shell).toBe(true);
    }
  });

  it("非 Windows 平台不开启 shell", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    await runCli([]);
    for (const call of spawn.mock.calls) {
      expect(call[2].shell).toBeUndefined();
    }
  });

  it("does not publish when the second Linux target fails", async () => {
    spawn.mockImplementation((_command, args: string[]) => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", args.includes("linux-arm64") ? 1 : 0));
      return child;
    });
    await expect(runCli(["--linux"])).rejects.toThrow(/exited with code 1/);
    expect(begin).toHaveBeenCalledOnce();
    expect(collect).not.toHaveBeenCalled();
  });
});
