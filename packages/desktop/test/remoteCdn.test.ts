import { describe, expect, it } from "vitest";
import {
  isUtcPlusEightTimeZone,
  resolveRemoteCdnBaseUrls,
  shouldPreferDomesticRemoteCdn,
} from "../src/main/remoteCdn.js";

describe("remoteCdn", () => {
  it("中文且东八区时应优先国内 CDN", () => {
    expect(
      shouldPreferDomesticRemoteCdn({
        locale: "zh-CN",
        timeZone: "Asia/Shanghai",
      }),
    ).toBe(true);
    expect(
      resolveRemoteCdnBaseUrls({
        env: "production",
        locale: "zh-CN",
        timeZone: "Asia/Shanghai",
        version: "0.0.0-test",
      }),
    ).toEqual([
      "https://cdn.codegeex.cn/zcode/electron/releases/0.0.0-test",
      "https://cdn-zcode.z.ai/zcode/electron/releases/0.0.0-test",
    ]);
  });

  it("非中文或非东八区时应优先海外 CDN", () => {
    expect(
      shouldPreferDomesticRemoteCdn({
        locale: "en-US",
        timeZone: "Asia/Shanghai",
      }),
    ).toBe(false);
    expect(
      shouldPreferDomesticRemoteCdn({
        locale: "zh-CN",
        timeZone: "America/Los_Angeles",
      }),
    ).toBe(false);
    expect(
      resolveRemoteCdnBaseUrls({
        env: "production",
        locale: "zh-CN",
        timeZone: "America/Los_Angeles",
        version: "0.0.0-test",
      }),
    ).toEqual([
      "https://cdn-zcode.z.ai/zcode/electron/releases/0.0.0-test",
      "https://cdn.codegeex.cn/zcode/electron/releases/0.0.0-test",
    ]);
  });

  it("东八区判断应按 UTC 偏移而不是固定城市名单", () => {
    expect(isUtcPlusEightTimeZone("Asia/Shanghai")).toBe(true);
    expect(isUtcPlusEightTimeZone("Asia/Singapore")).toBe(true);
    expect(isUtcPlusEightTimeZone("Asia/Tokyo")).toBe(false);
  });

  it("测试产品环境应固定使用内网 SSH remote assets 根目录", () => {
    expect(
      resolveRemoteCdnBaseUrls({
        env: "test",
        locale: "zh-CN",
        timeZone: "Asia/Shanghai",
        version: "0.0.0-test",
      }),
    ).toEqual([
      "http://intranet.example.invalid:12345/ssh-remote-assets/0.0.0-test",
    ]);
  });

  it("显式覆盖 CDN 基址时不再按产品环境选择默认值", () => {
    expect(
      resolveRemoteCdnBaseUrls({
        env: "test",
        overrideBaseUrl: "https://cdn.example.com/releases///",
        version: "0.0.0-test",
      }),
    ).toEqual(["https://cdn.example.com/releases"]);
  });

  it("注入 GitHub Release 根时在 CDN 候选后追加 v<version> 兜底", () => {
    expect(
      resolveRemoteCdnBaseUrls({
        env: "production",
        locale: "zh-CN",
        timeZone: "Asia/Shanghai",
        version: "3.16.2-build.20261027112643",
        githubReleaseDownloadRoot: "https://github.com/banzhe/ZCode/releases/download",
      }),
    ).toEqual([
      "https://cdn.codegeex.cn/zcode/electron/releases/3.16.2-build.20261027112643",
      "https://cdn-zcode.z.ai/zcode/electron/releases/3.16.2-build.20261027112643",
      "https://github.com/banzhe/ZCode/releases/download/v3.16.2-build.20261027112643",
    ]);
  });

  it("测试环境注入 GitHub Release 根时在内网根之后追加兜底候选", () => {
    // fork 的 GitHub Actions 发布不注入 ZCODE_ENV，产物是 Preview（test 产品环境）；
    // 内网占位根不可解析，必须能回落到同一 Release 上已发布的 descriptor/archive。
    expect(
      resolveRemoteCdnBaseUrls({
        env: "test",
        version: "3.16.2-build.20261027133747",
        githubReleaseDownloadRoot: "https://github.com/banzhe/ZCode/releases/download",
      }),
    ).toEqual([
      "http://intranet.example.invalid:12345/ssh-remote-assets/3.16.2-build.20261027133747",
      "https://github.com/banzhe/ZCode/releases/download/v3.16.2-build.20261027133747",
    ]);
  });

  it("显式覆盖 CDN 基址时不追加 GitHub Release 候选", () => {
    expect(
      resolveRemoteCdnBaseUrls({
        env: "production",
        overrideBaseUrl: "https://cdn.example.com/releases",
        version: "0.0.0-test",
        githubReleaseDownloadRoot: "https://github.com/banzhe/ZCode/releases/download",
      }),
    ).toEqual(["https://cdn.example.com/releases"]);
    expect(
      resolveRemoteCdnBaseUrls({
        env: "test",
        overrideBaseUrl: "https://cdn.example.com/releases",
        version: "0.0.0-test",
        githubReleaseDownloadRoot: "https://github.com/banzhe/ZCode/releases/download",
      }),
    ).toEqual(["https://cdn.example.com/releases"]);
  });

  it("未注入 GitHub Release 根时保持现有候选列表", () => {
    expect(
      resolveRemoteCdnBaseUrls({
        env: "production",
        locale: "zh-CN",
        timeZone: "Asia/Shanghai",
        version: "3.16.2",
        githubReleaseDownloadRoot: "  ",
      }),
    ).toEqual([
      "https://cdn.codegeex.cn/zcode/electron/releases/3.16.2",
      "https://cdn-zcode.z.ai/zcode/electron/releases/3.16.2",
    ]);
  });
});
