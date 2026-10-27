import { describe, expect, it } from "vitest";
import {
  buildComponentArtifactUrlCandidates,
  buildReleaseAssetUrlCandidates,
  buildReleaseBaseCandidates,
} from "@zcode/server/remote/remoteAssetCdn.js";

describe("remoteAssetCdn URL encoding", () => {
  it("组件路径包含 '+' 时应编码为 %2B", () => {
    const urls = buildComponentArtifactUrlCandidates(
      ["https://cdn.example.com/zcode/electron/releases/1.3.0"],
      "components/linux-arm64/server-bundle/v1.3.0+7138ea7a9b45.tar.gz",
      "1.3.0",
    );

    expect(urls).toEqual([
      "https://cdn.example.com/zcode/electron/releases/components/linux-arm64/server-bundle/v1.3.0%2B7138ea7a9b45.tar.gz",
      "https://cdn.example.com/zcode/electron/releases/1.3.0/components/linux-arm64/server-bundle/v1.3.0%2B7138ea7a9b45.tar.gz",
    ]);
  });

  it("组件产物应从带版本 manifest 基址回退到跨版本 components 根目录", () => {
    const urls = buildComponentArtifactUrlCandidates(
      [
        "https://cdn.example.com/zcode/electron/releases/1.3.0",
        "https://backup.example.com/zcode/electron/releases/1.3.0",
      ],
      "components/linux-arm64/server-bundle/v1.3.0.tar.gz",
      "1.3.0",
    );

    expect(urls).toEqual([
      "https://cdn.example.com/zcode/electron/releases/components/linux-arm64/server-bundle/v1.3.0.tar.gz",
      "https://cdn.example.com/zcode/electron/releases/1.3.0/components/linux-arm64/server-bundle/v1.3.0.tar.gz",
      "https://backup.example.com/zcode/electron/releases/components/linux-arm64/server-bundle/v1.3.0.tar.gz",
      "https://backup.example.com/zcode/electron/releases/1.3.0/components/linux-arm64/server-bundle/v1.3.0.tar.gz",
    ]);
  });

  it("已编码路径不应重复编码", () => {
    const urls = buildReleaseAssetUrlCandidates(
      ["https://cdn.example.com/zcode/electron/releases/1.3.0"],
      ["components/linux-arm64/server-bundle/v1.3.0%2B7138ea7a9b45.tar.gz"],
    );

    expect(urls).toEqual([
      "https://cdn.example.com/zcode/electron/releases/1.3.0/components/linux-arm64/server-bundle/v1.3.0%2B7138ea7a9b45.tar.gz",
    ]);
  });

  it("GitHub Release 基址（v<version> 结尾）不应叠加版本段产生重复候选", () => {
    expect(
      buildReleaseBaseCandidates(
        ["https://github.com/banzhe/ZCode/releases/download/v3.16.2-build.20261027112643"],
        "3.16.2-build.20261027112643",
      ),
    ).toEqual(["https://github.com/banzhe/ZCode/releases/download/v3.16.2-build.20261027112643"]);
  });

  it("未固定版本的基址仍按 <base>/<version> 与裸根生成候选", () => {
    expect(
      buildReleaseBaseCandidates(["https://github.com/banzhe/ZCode/releases/download"], "1.3.0"),
    ).toEqual([
      "https://github.com/banzhe/ZCode/releases/download/1.3.0",
      "https://github.com/banzhe/ZCode/releases/download",
    ]);
  });
});
