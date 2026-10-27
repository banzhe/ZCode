const windowsShellCommandPattern = /\.(cmd|bat)$/i;
const windowsShellCommandNames = new Set(["npm", "pnpm"]);

export interface SpawnRuntimeOptions {
  shell?: boolean;
}

// Bug 原因：Windows runner 上 pnpm/npm 只有 .cmd 垫片。Node 18.20.2/20.12.2/21.7.3 起
// 禁止不带 shell 直接 spawn .cmd/.bat（CVE-2024-27980 加固），命中即抛 spawn EINVAL；
// 而只把命令名改写成 pnpm.cmd 既会 EINVAL，也会让 pnpm exec 落回错误的包 cwd。
// 修复依据：与 scripts/spawn-command.mjs 的规则保持一致——保留原命令名，交给 shell 解析垫片。
export function resolveSpawnRuntimeOptions(
  command: string,
  platform: NodeJS.Platform = process.platform,
): SpawnRuntimeOptions {
  if (
    platform === "win32" &&
    (windowsShellCommandPattern.test(command) || windowsShellCommandNames.has(command))
  ) {
    return { shell: true };
  }

  return {};
}

// shell:true 时 Node 只把参数按空格拼接、不做转义（对应 DEP0190 警告），
// 含空格的参数需要按 cmd.exe 规则自行补引号。
export function quoteArgsForWindowsShell(args: readonly string[]): string[] {
  return args.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg));
}
