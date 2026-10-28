import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

interface WorkflowStep {
  name?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}

interface WorkflowJob {
  needs?: string | string[];
  steps?: WorkflowStep[];
}

const workflow = parse(
  readFileSync(new URL("../../../.github/workflows/release-on-push.yml", import.meta.url), "utf8"),
) as { jobs: Record<string, WorkflowJob> };

function job(name: string): WorkflowJob {
  const found = workflow.jobs[name];
  if (!found) throw new Error(`workflow job missing: ${name}`);
  return found;
}

function step(jobName: string, stepName: string): WorkflowStep {
  const found = job(jobName).steps?.find((candidate) => candidate.name === stepName);
  if (!found) throw new Error(`workflow step missing: ${jobName}/${stepName}`);
  return found;
}

function needsOf(jobName: string): string[] {
  const needs = job(jobName).needs;
  return needs === undefined ? [] : Array.isArray(needs) ? needs : [needs];
}

describe("release workflow pipeline shape", () => {
  it("splits stamp / installer / remote assets / release into separate jobs", () => {
    expect(Object.keys(workflow.jobs).sort()).toEqual([
      "build-desktop",
      "build-remote-assets",
      "release",
      "stamp",
    ]);
    // 两个构建 job 都必须依赖同一个 stamp，才能保证安装包与 descriptor 版本同源。
    expect(needsOf("build-desktop")).toEqual(["stamp"]);
    expect(needsOf("build-remote-assets")).toEqual(["stamp"]);
    expect(needsOf("release").sort()).toEqual(["build-desktop", "build-remote-assets", "stamp"]);
  });

  it("applies the stamped version from the stamp job instead of recomputing it", () => {
    for (const jobName of ["build-desktop", "build-remote-assets"]) {
      const applyStep = step(jobName, "Apply stamped version");
      expect(applyStep.run).toContain("scripts/apply-release-version.mjs");
      expect(applyStep.run).toContain("needs.stamp.outputs.version");
      // 重新算时间戳会让两个 job 的版本分叉，客户端将找不到 releases/<version>/。
      expect(applyStep.run).not.toContain("Get-Date");
    }
    const stampStep = step("stamp", "Stamp version and resolve tag");
    expect(stampStep.run).toContain("Get-Date");
    // 版本戳只由 stamp job 生成，它自己不写回工作区。
    expect(stampStep.run).not.toContain("apply-release-version");
  });

  it("caches Electron / electron-builder binaries and Source Server staging tools", () => {
    const desktopCache = step("build-desktop", "Cache Electron and electron-builder binaries");
    expect(desktopCache.uses).toBe("actions/cache@v4");
    const desktopPaths = String(desktopCache.with?.path ?? "");
    expect(desktopPaths).toContain("AppData/Local/electron/Cache");
    expect(desktopPaths).toContain("AppData/Local/electron-builder/Cache");
    expect(String(desktopCache.with?.key ?? "")).toContain("hashFiles(");
    expect(String(desktopCache.with?.["restore-keys"] ?? "")).toContain("desktop-packager-");

    const remoteCache = step("build-remote-assets", "Cache Source Server staging tools");
    expect(remoteCache.uses).toBe("actions/cache@v4");
    expect(String(remoteCache.with?.path ?? "")).toContain("node_modules/.cache/zcode-server-cli");
    expect(String(remoteCache.with?.key ?? "")).toContain("native-search-tools-config.mjs");
    expect(String(remoteCache.with?.["restore-keys"] ?? "")).toContain("source-server-tools-");
  });

  it("keeps the release surface to the installer plus descriptor and four archives", () => {
    const stageStep = step("build-remote-assets", "Stage source server release assets");
    expect(stageStep.run).toContain("prepare:remote-assets");
    // 发布路径不产出组件归档；dev 入口不传该参数，行为不变。
    expect(stageStep.run).toContain("--skip-component-archives");

    const releaseStep = step("release", "Create GitHub Release");
    const files = String(releaseStep.with?.files ?? "");
    expect(files).toContain("packages/desktop/dist/*.exe");
    expect(files).toContain("packages/desktop/dist/latest*.yml");
    expect(files).toContain("needs.stamp.outputs.version");

    expect(step("release", "Download desktop installer").uses).toBe("actions/download-artifact@v4");
    expect(step("release", "Download remote assets").uses).toBe("actions/download-artifact@v4");
    expect(step("build-desktop", "Upload desktop installer artifact").uses).toBe(
      "actions/upload-artifact@v4",
    );
    expect(step("build-remote-assets", "Upload remote asset artifacts").uses).toBe(
      "actions/upload-artifact@v4",
    );
  });

  it("keeps the GitHub Release fallback repo injected for the packaged app", () => {
    const buildStep = step("build-desktop", "Build Windows desktop installer");
    expect(buildStep.env?.ZCODE_GITHUB_RELEASE_REPO).toBe("${{ github.repository }}");
    expect(buildStep.env?.ZCODE_TARGET_OS).toBe("win");
    expect(buildStep.env?.ZCODE_AUTO_UPDATE).toBe("");
  });

  it("never reads the stamp job outputs through steps.meta outside the stamp job", () => {
    for (const [jobName, value] of Object.entries(workflow.jobs)) {
      if (jobName === "stamp") continue;
      for (const candidate of value.steps ?? []) {
        expect(JSON.stringify(candidate)).not.toContain("steps.meta.outputs");
      }
    }
  });
});
