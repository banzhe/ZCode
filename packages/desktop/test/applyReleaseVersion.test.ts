import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const scriptPath = fileURLToPath(
  new URL("../../../scripts/apply-release-version.mjs", import.meta.url),
);
const temporaryDirs: string[] = [];

async function writePackageJson(content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-release-version-"));
  temporaryDirs.push(dir);
  const packageJsonPath = join(dir, "package.json");
  await writeFile(packageJsonPath, content, "utf8");
  return packageJsonPath;
}

function runApply(args: string[]) {
  return spawnSync(process.execPath, [scriptPath, ...args], { encoding: "utf8" });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })),
  );
});

describe("apply-release-version", () => {
  it("只替换顶层 version，其余字节（嵌套字段、CRLF、结尾换行）保持不变", async () => {
    const content =
      '{\r\n  "name": "zcode",\r\n  "version": "3.16.2",\r\n  "nested": {\r\n    "version": "1.0.0"\r\n  }\r\n}\r\n';
    const packageJsonPath = await writePackageJson(content);

    const result = runApply(["3.16.2-build.20261028010101", packageJsonPath]);

    expect(result.status).toBe(0);
    expect(await readFile(packageJsonPath, "utf8")).toBe(
      content.replace('"version": "3.16.2"', '"version": "3.16.2-build.20261028010101"'),
    );
  });

  it("找不到 version 字段时失败，不写出半成品", async () => {
    const content = '{\n  "name": "zcode"\n}\n';
    const packageJsonPath = await writePackageJson(content);

    const result = runApply(["3.16.2-build.20261028010101", packageJsonPath]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("version field not found");
    expect(await readFile(packageJsonPath, "utf8")).toBe(content);
  });

  it("缺少版本参数时给出用法提示", () => {
    const result = runApply([]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("apply-release-version.mjs <version>");
  });
});
