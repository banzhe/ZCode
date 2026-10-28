import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { applyArchiveExecutableModes } from "../src/packaging/archiveEntryModes.js";
import { resolveHostTarCommand } from "../src/packaging/tarCommand.js";
import { readTarGzEntries, writeTarGz } from "./helpers/tarEntries.js";

const execFileAsync = promisify(execFile);
const temporaryDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-archive-modes-"));
  temporaryDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })),
  );
});

async function sha256File(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function listTarEntries(archivePath: string): Promise<string[]> {
  const { stdout } = await execFileAsync(resolveHostTarCommand(), ["-tvf", archivePath]);
  // Windows bsdtar 的列表输出是 CRLF，行尾 \r 会让 endsWith 匹配失败。
  return stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}

async function readModes(archivePath: string): Promise<Map<string, number>> {
  const entries = await readTarGzEntries(archivePath);
  return new Map(entries.map((entry) => [entry.name, entry.mode & 0o777]));
}

describe("applyArchiveExecutableModes", () => {
  it("把声明集合规范为 0755，其余条目保持宿主记录，且归档仍可被真实 tar 解压", async () => {
    const root = await makeTempDir();
    const archivePath = join(root, "zcode-server-linux-x64.tar.gz");
    await writeTarGz(archivePath, [
      { name: "zcode-server-linux-x64/", mode: 0o777, typeFlag: "5" },
      { name: "zcode-server-linux-x64/bin/zcode", mode: 0o666, contents: "#!/bin/sh\n" },
      { name: "zcode-server-linux-x64/runtime/node", mode: 0o666, contents: "fake-node" },
      {
        name: "zcode-server-linux-x64/runtime/tools/ripgrep/rg",
        mode: 0o666,
        contents: "fake-rg",
      },
      { name: "zcode-server-linux-x64/runtime/server-cli.js", mode: 0o666, contents: "js" },
    ]);

    await applyArchiveExecutableModes({
      archivePath,
      executablePaths: ["bin/zcode", "runtime/node", "runtime/tools/ripgrep/rg"],
    });

    const modes = await readModes(archivePath);
    expect(modes.get("zcode-server-linux-x64/bin/zcode")).toBe(0o755);
    expect(modes.get("zcode-server-linux-x64/runtime/node")).toBe(0o755);
    expect(modes.get("zcode-server-linux-x64/runtime/tools/ripgrep/rg")).toBe(0o755);
    // 未声明的普通文件与目录不做归一化。
    expect(modes.get("zcode-server-linux-x64/runtime/server-cli.js")).toBe(0o666);
    expect(modes.get("zcode-server-linux-x64/")).toBe(0o777);

    // checksum 必须同步重算：真实 tar 解压成功，并按记录的模式列出条目。
    const extractDir = join(root, "extract");
    await mkdir(extractDir, { recursive: true });
    await execFileAsync(resolveHostTarCommand(), ["-xzf", archivePath, "-C", extractDir]);
    const launcherPath = join(extractDir, "zcode-server-linux-x64", "bin", "zcode");
    expect(await readFile(launcherPath, "utf8")).toBe("#!/bin/sh\n");
    if (process.platform !== "win32") {
      expect((await stat(launcherPath)).mode & 0o111).not.toBe(0);
    }
    const listing = await listTarEntries(archivePath);
    const launcherLine = listing.find((line) => line.endsWith("zcode-server-linux-x64/bin/zcode"));
    expect(launcherLine?.startsWith("-rwxr-xr-x")).toBe(true);
  });

  it("按 PAX path 记录匹配长路径可执行条目", async () => {
    const root = await makeTempDir();
    const archivePath = join(root, "long-path.tar.gz");
    const longEntry = `zcode-server-linux-x64/runtime/tools/${"x".repeat(120)}/rg`;
    await writeTarGz(archivePath, [
      { name: longEntry.slice(0, 99), mode: 0o666, contents: "fake-rg", paxPath: longEntry },
    ]);

    await applyArchiveExecutableModes({
      archivePath,
      executablePaths: [`runtime/tools/${"x".repeat(120)}/rg`],
    });

    const modes = await readModes(archivePath);
    expect(modes.get(longEntry)).toBe(0o755);
    const line = (await listTarEntries(archivePath)).find((candidate) =>
      candidate.includes(`runtime/tools/${"x".repeat(120)}/rg`),
    );
    expect(line?.startsWith("-rwxr-xr-x")).toBe(true);
  });

  it("按 GNU L 长名头匹配长路径可执行条目", async () => {
    const root = await makeTempDir();
    const archivePath = join(root, "gnu-long-name.tar.gz");
    const longEntry = `zcode-server-linux-x64/runtime/tools/${"y".repeat(120)}/rg`;
    await writeTarGz(archivePath, [
      {
        name: "././@LongLink",
        mode: 0o644,
        contents: `${longEntry}\0`,
        typeFlag: "L",
      },
      { name: longEntry.slice(0, 99), mode: 0o666, contents: "fake-rg" },
    ]);

    await applyArchiveExecutableModes({
      archivePath,
      executablePaths: [`runtime/tools/${"y".repeat(120)}/rg`],
    });

    const line = (await listTarEntries(archivePath)).find((candidate) =>
      candidate.includes(`runtime/tools/${"y".repeat(120)}/rg`),
    );
    expect(line?.startsWith("-rwxr-xr-x")).toBe(true);
  });

  it("宿主已记录 0755 时不重写归档", async () => {
    const root = await makeTempDir();
    const archivePath = join(root, "already-executable.tar.gz");
    await writeTarGz(archivePath, [
      { name: "zcode-server-linux-x64/bin/zcode", mode: 0o755, contents: "#!/bin/sh\n" },
      { name: "zcode-server-linux-x64/runtime/node", mode: 0o755, contents: "fake-node" },
    ]);
    const before = await sha256File(archivePath);

    await applyArchiveExecutableModes({
      archivePath,
      executablePaths: ["bin/zcode", "runtime/node"],
    });

    expect(await sha256File(archivePath)).toBe(before);
  });

  it("声明集合成员缺失时 fail-closed，且不替换原归档", async () => {
    const root = await makeTempDir();
    const archivePath = join(root, "missing-entry.tar.gz");
    await writeTarGz(archivePath, [
      { name: "zcode-server-linux-x64/bin/zcode", mode: 0o666, contents: "#!/bin/sh\n" },
    ]);
    const before = await sha256File(archivePath);

    await expect(
      applyArchiveExecutableModes({
        archivePath,
        executablePaths: ["bin/zcode", "runtime/node"],
      }),
    ).rejects.toThrow(/missing declared executable entries: runtime\/node/u);

    expect(await sha256File(archivePath)).toBe(before);
  });

  it("声明集合为空时不触碰归档", async () => {
    const root = await makeTempDir();
    const archivePath = join(root, "empty-declaration.tar.gz");
    await writeTarGz(archivePath, [
      { name: "zcode-server-linux-x64/bin/zcode", mode: 0o666, contents: "#!/bin/sh\n" },
    ]);
    const before = await sha256File(archivePath);

    await applyArchiveExecutableModes({ archivePath, executablePaths: [] });

    expect(await sha256File(archivePath)).toBe(before);
  });
});
