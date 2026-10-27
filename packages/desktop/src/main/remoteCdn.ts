import { ZCODE_VERSION, type ZCodeEnv } from "@zcode/shared";

declare const __ZCODE_REMOTE_CDN_RELEASE_ROOTS__: readonly string[] | undefined;
// 构建期注入的 GitHub Release 下载根（https://github.com/<owner>/<repo>/releases/download），
// 由 CI 的 ZCODE_GITHUB_RELEASE_REPO=<owner>/<repo> 派生；未注入时为空串，表示不启用该下载源。
declare const __ZCODE_GITHUB_RELEASE_DOWNLOAD_ROOT__: string | undefined;

const REMOTE_CDN_RELEASE_ROOTS = {
  domestic: "https://cdn.codegeex.cn/zcode/electron/releases",
  // 开发构建未注入 CDN_DOMAIN 时也须使用当前发布域名，避免仍请求旧域名。
  overseas: "https://cdn-zcode.z.ai/zcode/electron/releases",
} as const;
const TEST_REMOTE_CDN_RELEASE_ROOT = "http://intranet.example.invalid:12345/ssh-remote-assets";

export interface ResolveRemoteCdnOptions {
  env?: ZCodeEnv;
  locale?: string;
  timeZone?: string;
  overrideBaseUrl?: string;
  version?: string;
  now?: Date;
  /** 测试注入用；默认读构建期 define __ZCODE_GITHUB_RELEASE_DOWNLOAD_ROOT__。 */
  githubReleaseDownloadRoot?: string;
}

function isChineseLocale(locale?: string | null): boolean {
  return locale?.trim().toLowerCase().startsWith("zh") ?? false;
}

function resolveLocalTimeZone(): string | undefined {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export function isUtcPlusEightTimeZone(timeZone?: string | null, now: Date = new Date()): boolean {
  const normalizedTimeZone = timeZone?.trim();
  if (!normalizedTimeZone) {
    return false;
  }

  const offsetMinutes = resolveTimeZoneOffsetMinutes(normalizedTimeZone, now);
  return offsetMinutes === 8 * 60;
}

export function shouldPreferDomesticRemoteCdn(
  options: Pick<ResolveRemoteCdnOptions, "locale" | "timeZone" | "now">,
): boolean {
  const timeZone = options.timeZone ?? resolveLocalTimeZone();
  return isChineseLocale(options.locale) && isUtcPlusEightTimeZone(timeZone, options.now);
}

function resolveGithubReleaseDownloadRoot(options: ResolveRemoteCdnOptions): string {
  if (options.githubReleaseDownloadRoot !== undefined) {
    return options.githubReleaseDownloadRoot.trim();
  }
  return typeof __ZCODE_GITHUB_RELEASE_DOWNLOAD_ROOT__ === "undefined"
    ? ""
    : __ZCODE_GITHUB_RELEASE_DOWNLOAD_ROOT__.trim();
}

export function resolveRemoteCdnBaseUrls(options: ResolveRemoteCdnOptions = {}): string[] {
  const overrideBaseUrl = options.overrideBaseUrl?.trim();
  if (overrideBaseUrl) {
    return [normalizeBaseUrl(overrideBaseUrl)];
  }

  const version = options.version ?? ZCODE_VERSION;

  // Bug 原因：fork 构建的 ZCODE_VERSION 带 -build.<stamp> 后缀，官方 CDN 上没有该版本目录，
  // descriptor 全部 404 后连接必然失败。这里把构建期注入的 GitHub Release 根（CI 的
  // ZCODE_GITHUB_RELEASE_REPO）追加为兜底候选：CDN 全部失败后按 v<version> tag 拉 Release asset。
  const githubReleaseDownloadRoot = resolveGithubReleaseDownloadRoot(options);
  const githubBase = githubReleaseDownloadRoot
    ? `${normalizeBaseUrl(githubReleaseDownloadRoot)}/v${version}`
    : null;

  if (options.env === "test") {
    // Bug 原因：test 产品环境过去在这里直接返回内网占位根。fork 的 GitHub Actions 发布不注入
    // ZCODE_ENV，产物就是 Preview（test 环境），占位域名 intranet.example.invalid 不可解析，
    // 于是 SSH/WSL 连接的 descriptor 只剩一个必然失败的候选，Release 上已发布的
    // descriptor/archive 永远消费不到。内网根保持第一优先级，只在显式注入 GitHub 根时追加兜底；
    // 官方测试构建不注入，候选列表逐项不变。
    const testBases = [`${TEST_REMOTE_CDN_RELEASE_ROOT}/${version}`];
    return githubBase ? [...testBases, githubBase] : testBases;
  }

  const orderedReleaseRoots = shouldPreferDomesticRemoteCdn(options)
    ? [REMOTE_CDN_RELEASE_ROOTS.domestic, REMOTE_CDN_RELEASE_ROOTS.overseas]
    : [REMOTE_CDN_RELEASE_ROOTS.overseas, REMOTE_CDN_RELEASE_ROOTS.domestic];

  const configuredReleaseRoots =
    typeof __ZCODE_REMOTE_CDN_RELEASE_ROOTS__ === "undefined"
      ? []
      : __ZCODE_REMOTE_CDN_RELEASE_ROOTS__;

  const cdnBases =
    configuredReleaseRoots.length > 0
      ? // Bugfix：remote runtime 的 manifest/components 下载根不能继续写死旧 CDN。
        // 构建期按 CI 的 CDN_DOMAIN/OSS_PATH_PREFIX 注入有序列表，切换时只改 CI 变量。
        configuredReleaseRoots.map((releaseRoot) => `${normalizeBaseUrl(releaseRoot)}/${version}`)
      : orderedReleaseRoots.map((releaseRoot) => `${releaseRoot}/${version}`);

  return githubBase ? [...cdnBases, githubBase] : cdnBases;
}

export function resolvePrimaryRemoteCdnBaseUrl(
  options: ResolveRemoteCdnOptions = {},
): string | undefined {
  return resolveRemoteCdnBaseUrls(options)[0];
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function resolveTimeZoneOffsetMinutes(timeZone: string, now: Date): number | null {
  try {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    const parts = formatter.formatToParts(now);
    const values = Object.fromEntries(
      parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]),
    );
    const year = Number(values.year);
    const month = Number(values.month);
    const day = Number(values.day);
    const hour = Number(values.hour);
    const minute = Number(values.minute);
    const second = Number(values.second);
    if ([year, month, day, hour, minute, second].some((value) => Number.isNaN(value))) {
      return null;
    }

    // 这里把目标时区“格式化后的人类时间”反算成 UTC，得到该时区相对 UTC 的真实偏移。
    // 不能只按常见亚洲城市白名单判断，否则 UTC+8 但非中国命名的时区会被误判。
    const targetUtcMs = Date.UTC(year, month - 1, day, hour, minute, second);
    const currentUtcMs = now.getTime();
    return Math.round((targetUtcMs - currentUtcMs) / 60_000);
  } catch {
    return null;
  }
}
