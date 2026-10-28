import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SOURCE_SERVER_REMOTE_RELEASE_TARGETS,
  beginSourceServerRemoteReleaseGeneration,
  collectSourceServerRemoteReleaseArchives,
} from "./remoteAssetRelease.js";
import { quoteArgsForWindowsShell, resolveSpawnRuntimeOptions } from "./spawnCommand.js";
import { timeStep } from "./stepTimer.js";

async function run(
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  // Bug 原因：Windows runner 上 pnpm 只有 .cmd 垫片，裸命令 spawn 报 ENOENT，
  // 改写成 pnpm.cmd 又会报 EINVAL。这里保留原命令名并交给 shell 解析垫片。
  const runtimeOptions = resolveSpawnRuntimeOptions(command);
  const spawnArgs = runtimeOptions.shell ? quoteArgsForWindowsShell(args) : [...args];
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(command, spawnArgs, { cwd, env, stdio: "inherit", ...runtimeOptions });
    child.once("error", rejectPromise);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
    });
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const linuxOnly = argv.includes("--linux");
  // 发布链路只发布 descriptor 与四个整包，组件归档是开发态 SSH 验证产物：
  // 默认仍产出，只有显式传入时才跳过（CI 发布步骤使用）。
  const skipComponentArchives = argv.includes("--skip-component-archives");
  const targets = linuxOnly
    ? SOURCE_SERVER_REMOTE_RELEASE_TARGETS.filter((target) => target.startsWith("linux-"))
    : SOURCE_SERVER_REMOTE_RELEASE_TARGETS;
  const env = { ...process.env };
  if (linuxOnly) {
    // Linux 开发入口与 dev:desktop 共用 production 默认值，避免远端模型配置退回 test。
    // 原全平台入口继续沿用通用构建器的环境选择规则。
    const zcodeEnv = env.ZCODE_ENV?.trim().toLowerCase() || "production";
    if (zcodeEnv !== "test" && zcodeEnv !== "production") {
      throw new Error(`Invalid ZCODE_ENV for prepare:remote-assets:linux: ${zcodeEnv}`);
    }
    env.ZCODE_ENV = zcodeEnv;
  }
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const repoRoot = resolve(packageRoot, "../..");
  const { version } = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8")) as {
    version: string;
  };
  const versionReleaseDir = join(repoRoot, "packages/desktop/mock-cdn/releases", version);
  await beginSourceServerRemoteReleaseGeneration({ versionReleaseDir });
  await timeStep("remote-assets:server-cli-build", () =>
    run("pnpm", ["--filter", "@zcode/server-cli", "build"], repoRoot, env),
  );
  // 每个目标的计时包含 stageCli 子进程内部的 stage:* 计时（父含子），两层的耗时不可相加。
  for (const [index, target] of targets.entries()) {
    await timeStep(`remote-assets:${target}`, () =>
      run(
        "pnpm",
        [
          "--filter",
          "@zcode/server-cli",
          "exec",
          "tsx",
          "src/packaging/stageCli.ts",
          "--target",
          target,
          ...(linuxOnly || skipComponentArchives ? ["--skip-component-archives"] : []),
          ...(index === 0 ? [] : ["--skip-agent-build"]),
        ],
        repoRoot,
        env,
      ),
    );
  }
  const collected = await collectSourceServerRemoteReleaseArchives({
    distReleaseDir: join(packageRoot, "dist-release"),
    versionReleaseDir,
    version,
    targets,
  });
  for (const path of collected) console.log(`[source-server-release] ${path}`);
}

await main();
