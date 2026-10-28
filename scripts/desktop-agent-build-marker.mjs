import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * 桌面 Agent 构建事实的落点。放在 node_modules/.cache 下：gitignore 覆盖、不参与打包，
 * 且与 zcode-server-cli 的工具缓存同级，便于 CI 一起观察。
 */
const MARKER_RELATIVE_PATH = "node_modules/.cache/desktop-agent-build.json";
const MARKER_SCHEMA_VERSION = 1;
// 只有 pnpm 路径真实构建并校验过插件 runtime；turbo 与 bootstrap-with-remote 不构建，因此
// 读取端只信任这一个 mode，其余一律回退为重建。
const TRUSTED_BUILD_MODE = "pnpm";
const BUILD_MODES = [TRUSTED_BUILD_MODE, "turbo", "bootstrap-with-remote"];

export function resolveDesktopAgentBuildMarkerPath(repoRoot) {
  return join(repoRoot, MARKER_RELATIVE_PATH);
}

/**
 * 记录本轮 agent 构建实际产出的插件 runtime。
 *
 * 只有真实构建并校验过插件 runtime 的路径才允许写入包名（pnpm 路径）；turbo 与
 * bootstrap-with-remote 路径写空数组，让下游继续按原行为重建，
 * 避免"dist 文件齐全就复用"掩盖源码变化。
 *
 * marker 只是缓存提示：写不进去（只读挂载、ACL、磁盘满）只损失复用，不应让构建失败，
 * 因此失败时返回 null，由调用方忽略。
 */
export function writeDesktopAgentBuildMarker({ repoRoot, mode, pluginRuntimePackages = [] }) {
  if (!BUILD_MODES.includes(mode)) {
    throw new Error(`Unknown desktop agent build mode: ${String(mode)}`);
  }
  const markerPath = resolveDesktopAgentBuildMarkerPath(repoRoot);
  try {
    mkdirSync(dirname(markerPath), { recursive: true });
    writeFileSync(
      markerPath,
      `${JSON.stringify(
        {
          schemaVersion: MARKER_SCHEMA_VERSION,
          mode,
          pluginRuntimePackages: [...pluginRuntimePackages],
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    return markerPath;
  } catch (error) {
    console.warn(
      `[desktop-agent-build] 无法写入构建事实 ${markerPath}，下游将重建插件 runtime：${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}

/** 构建入口先清空：marker 存在即代表本轮构建已跑到写入口，而不是上一轮的残留。 */
export function clearDesktopAgentBuildMarker({ repoRoot }) {
  rmSync(resolveDesktopAgentBuildMarkerPath(repoRoot), { force: true });
}

/** 缺失或损坏一律返回 null：调用方据此回退到"重建"，不能把读不到当成"已构建"。 */
export function readDesktopAgentBuildMarker({ repoRoot }) {
  try {
    const parsed = JSON.parse(readFileSync(resolveDesktopAgentBuildMarkerPath(repoRoot), "utf-8"));
    if (parsed?.schemaVersion !== MARKER_SCHEMA_VERSION) return null;
    if (!BUILD_MODES.includes(parsed?.mode)) return null;
    if (!Array.isArray(parsed.pluginRuntimePackages)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** 声明清单必须被本轮 pnpm 路径构建完整覆盖才允许跳过重建；清单扩大或 mode 不可信都回退为重建。 */
export function isPluginRuntimeBuildCovered({ marker, requiredPackages }) {
  if (marker?.mode !== TRUSTED_BUILD_MODE) return false;
  if (!Array.isArray(marker.pluginRuntimePackages)) return false;
  const built = new Set(marker.pluginRuntimePackages);
  return requiredPackages.every((packageName) => built.has(packageName));
}
