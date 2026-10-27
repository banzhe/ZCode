import { describe, expect, it } from "vitest";
import {
  quoteArgsForWindowsShell,
  resolveSpawnRuntimeOptions,
} from "../src/packaging/spawnCommand.js";

describe("resolveSpawnRuntimeOptions", () => {
  it("Windows 下 pnpm/npm 别名走 shell，让 cmd 解析 .cmd 垫片", () => {
    expect(resolveSpawnRuntimeOptions("pnpm", "win32")).toEqual({ shell: true });
    expect(resolveSpawnRuntimeOptions("npm", "win32")).toEqual({ shell: true });
  });

  it("Windows 下 .cmd/.bat 包装脚本显式走 shell", () => {
    expect(resolveSpawnRuntimeOptions("pnpm.cmd", "win32")).toEqual({ shell: true });
    expect(resolveSpawnRuntimeOptions("build.BAT", "win32")).toEqual({ shell: true });
  });

  it("非 Windows 平台与普通可执行文件不开启 shell", () => {
    expect(resolveSpawnRuntimeOptions("pnpm", "darwin")).toEqual({});
    expect(resolveSpawnRuntimeOptions("pnpm", "linux")).toEqual({});
    expect(resolveSpawnRuntimeOptions("node", "win32")).toEqual({});
  });
});

describe("quoteArgsForWindowsShell", () => {
  it("只给含空格的参数补引号", () => {
    expect(quoteArgsForWindowsShell(["--filter", "E:\\Z Code\\dist", "build"])).toEqual([
      "--filter",
      '"E:\\Z Code\\dist"',
      "build",
    ]);
  });
});
