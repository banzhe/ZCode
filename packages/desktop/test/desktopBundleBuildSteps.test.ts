import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveDesktopBuildSteps } from "../scripts/bundle.mjs";

const desktopScripts = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    scripts: Record<string, string>;
  }
).scripts;

describe("桌面打包的前置步骤", () => {
  it("默认只跑一次资源准备", () => {
    expect(resolveDesktopBuildSteps({ skipPrepare: false, skipBuild: false })).toEqual([
      "prepare:runtime-assets",
      "build:no-runtime-assets",
    ]);
  });

  it("--skip-prepare 真的跳过资源准备", () => {
    expect(resolveDesktopBuildSteps({ skipPrepare: true, skipBuild: false })).toEqual([
      "build:no-runtime-assets",
    ]);
  });

  it("--skip-build 保留资源准备，两个都跳过时不跑任何前置步骤", () => {
    expect(resolveDesktopBuildSteps({ skipPrepare: false, skipBuild: true })).toEqual([
      "prepare:runtime-assets",
    ]);
    expect(resolveDesktopBuildSteps({ skipPrepare: true, skipBuild: true })).toEqual([]);
  });

  it("build 脚本自身仍会跑 prepare，因此前置步骤不能改回 build", () => {
    // 若 build 不再包含 prepare:runtime-assets，bundle 就必须改回调 build，否则资源不会被准备。
    expect(desktopScripts.build).toContain("prepare:runtime-assets");
    expect(desktopScripts.build).toContain("build:no-runtime-assets");
  });
});
