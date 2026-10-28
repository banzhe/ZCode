import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearDesktopAgentBuildMarker,
  isPluginRuntimeBuildCovered,
  readDesktopAgentBuildMarker,
  resolveDesktopAgentBuildMarkerPath,
  writeDesktopAgentBuildMarker,
} from "../../../scripts/desktop-agent-build-marker.mjs";

const temporaryDirs: string[] = [];

async function makeRepoRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-agent-build-marker-"));
  temporaryDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })),
  );
});

describe("desktop agent build marker", () => {
  it("records the plugin runtimes this run actually built", async () => {
    const repoRoot = await makeRepoRoot();
    const markerPath = writeDesktopAgentBuildMarker({
      repoRoot,
      mode: "pnpm",
      pluginRuntimePackages: ["@zcode/node-repl-host", "@zcode/pdf-plugin"],
    });

    expect(markerPath).toBe(resolveDesktopAgentBuildMarkerPath(repoRoot));
    const marker = readDesktopAgentBuildMarker({ repoRoot });
    expect(marker?.mode).toBe("pnpm");
    expect(marker?.pluginRuntimePackages).toEqual(["@zcode/node-repl-host", "@zcode/pdf-plugin"]);
  });

  it("treats a missing, corrupt or schema-mismatched marker as not built", async () => {
    const repoRoot = await makeRepoRoot();
    // 读不到必须回退到“重建”，不能当成“已构建”。
    expect(readDesktopAgentBuildMarker({ repoRoot })).toBeNull();

    const markerPath = resolveDesktopAgentBuildMarkerPath(repoRoot);
    await mkdir(dirname(markerPath), { recursive: true });
    await writeFile(markerPath, "{ not json", "utf8");
    expect(readDesktopAgentBuildMarker({ repoRoot })).toBeNull();

    await writeFile(
      markerPath,
      JSON.stringify({ schemaVersion: 99, pluginRuntimePackages: [] }),
      "utf8",
    );
    expect(readDesktopAgentBuildMarker({ repoRoot })).toBeNull();

    await writeFile(markerPath, JSON.stringify({ schemaVersion: 1 }), "utf8");
    expect(readDesktopAgentBuildMarker({ repoRoot })).toBeNull();

    // 未知 mode（例如更高版本的写入端）同样按“没构建”处理。
    await writeFile(
      markerPath,
      JSON.stringify({ schemaVersion: 1, mode: "unknown", pluginRuntimePackages: [] }),
      "utf8",
    );
    expect(readDesktopAgentBuildMarker({ repoRoot })).toBeNull();
  });

  it("rejects unknown build modes", async () => {
    const repoRoot = await makeRepoRoot();
    expect(() =>
      writeDesktopAgentBuildMarker({ repoRoot, mode: "turboo", pluginRuntimePackages: [] }),
    ).toThrow(/Unknown desktop agent build mode/u);
  });

  it("清空后不再复用上一轮遗留的构建事实", async () => {
    const repoRoot = await makeRepoRoot();
    writeDesktopAgentBuildMarker({
      repoRoot,
      mode: "pnpm",
      pluginRuntimePackages: ["@zcode/pdf-plugin"],
    });
    const markerPath = resolveDesktopAgentBuildMarkerPath(repoRoot);
    expect(existsSync(markerPath)).toBe(true);

    clearDesktopAgentBuildMarker({ repoRoot });

    expect(existsSync(markerPath)).toBe(false);
    expect(readDesktopAgentBuildMarker({ repoRoot })).toBeNull();
    // 重复清空（marker 已不存在）不应抛错。
    expect(() => clearDesktopAgentBuildMarker({ repoRoot })).not.toThrow();
  });

  it("marker 写不进去时只损失复用，不让构建失败", async () => {
    const repoRoot = await makeRepoRoot();
    // node_modules 是文件时无法在其下建 .cache 目录。
    await writeFile(join(repoRoot, "node_modules"), "", "utf8");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const markerPath = writeDesktopAgentBuildMarker({
      repoRoot,
      mode: "pnpm",
      pluginRuntimePackages: ["@zcode/pdf-plugin"],
    });

    expect(markerPath).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(readDesktopAgentBuildMarker({ repoRoot })).toBeNull();
    warnSpy.mockRestore();
  });

  it("covers a declaration list only when this run built every entry", () => {
    const marker = {
      schemaVersion: 1,
      mode: "pnpm",
      pluginRuntimePackages: ["@zcode/pdf-plugin", "@zcode/node-repl-host"],
    };

    expect(
      isPluginRuntimeBuildCovered({
        marker,
        requiredPackages: ["@zcode/pdf-plugin", "@zcode/node-repl-host"],
      }),
    ).toBe(true);
    // 声明清单扩大（新增 requiresRuntime 插件）时必须回退为重建。
    expect(
      isPluginRuntimeBuildCovered({
        marker,
        requiredPackages: ["@zcode/pdf-plugin", "@zcode/brand-new-plugin"],
      }),
    ).toBe(false);
    // 只有 pnpm 路径真实构建插件 runtime，其余 mode 即使带着包名也不可信。
    for (const mode of ["turbo", "bootstrap-with-remote"]) {
      expect(
        isPluginRuntimeBuildCovered({
          marker: { ...marker, mode },
          requiredPackages: ["@zcode/pdf-plugin"],
        }),
      ).toBe(false);
    }
    // turbo / bootstrap 路径写空清单，等价于“本轮没构建插件 runtime”。
    expect(
      isPluginRuntimeBuildCovered({
        marker: { schemaVersion: 1, mode: "turbo", pluginRuntimePackages: [] },
        requiredPackages: ["@zcode/pdf-plugin"],
      }),
    ).toBe(false);
    expect(
      isPluginRuntimeBuildCovered({ marker: null, requiredPackages: ["@zcode/pdf-plugin"] }),
    ).toBe(false);
    expect(isPluginRuntimeBuildCovered({ marker, requiredPackages: [] })).toBe(true);
  });
});
