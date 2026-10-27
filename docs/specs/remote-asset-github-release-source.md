# Remote Assets GitHub Release 下载源

## 背景

Fork 仓库（如 `banzhe/ZCode`）的 `release-on-push.yml` 只把 Windows 安装包发布到 GitHub Release，
remote assets（Source Server descriptor/archive）没有发布渠道：打包应用的
`ZCODE_VERSION` 是 CI stamp 出的 `<base>-build.<stamp>`（如 `3.16.2-build.20261027112643`），
官方 CDN 上不存在该版本目录，所有 descriptor 请求 404，导致 SSH/WSL/docker 连接
在 "Unable to resolve Source Server release descriptor" 处失败。

本 spec 定义：GitHub Release 作为 remote assets 的补充下载源。

## 产品规则

1. 下载候选顺序 = CDN roots（现有顺序不变）在前，GitHub Release 根在后；前者全部失败才落到 GitHub。
2. GitHub Release 根按构建期注入：`ZCODE_GITHUB_RELEASE_REPO=<owner>/<repo>`（CI 传
   `${{ github.repository }}`）编译为 `https://github.com/<owner>/<repo>/releases/download`。
   未注入（上游官方构建/本地开发）时为空，不产生候选，行为与现状完全一致。
3. 版本到 tag 的映射固定为 `v<ZCODE_VERSION>`；descriptor 与 archive 都是 Release asset，
   文件名与 mock-cdn staging 产物一致（`source-server-release.json`、`zcode-server-<target>.tar.gz`）。
4. 测试产品环境（`ZCODE_ENV=test`，内网根目录）与显式 `ZCODE_REMOTE_ASSET_CDN_BASE_URL`
   覆盖不追加 GitHub 候选：前者要求确定性，后者要求精确控制。
5. 公开仓库匿名下载即可，不引入 token；私有仓库不支持（候选失败会按现有顺序兜底报错）。
6. SSH `remote-download`（远端服务器直下）复用同一组 base 候选，远端机器直接从 GitHub 下载。

## 所有者与接口

- 候选列表唯一所有者：`packages/desktop/src/main/remoteCdn.ts#resolveRemoteCdnBaseUrls`
  （main 进程），经 `msg.remoteAssets.remoteCdnBaseUrls` 单向传递给 Host。
- base → 资源 URL 的拼接唯一所有者：`packages/server/src/remote/remoteAssetCdn.ts#buildReleaseBaseCandidates`。
  已固定到 `v<version>` 的 GitHub 基址不得再叠加 `${version}` 产生必然 404 的重复候选。
- CI 产物 staging：`pnpm prepare:remote-assets`（`stageRemoteAssetsCli`），descriptor 的
  `version` 取 stamp 后的 package.json version，与 `ZCODE_VERSION` 同源，天然满足
  `readDescriptor` 的版本一致性校验。

## 事件顺序

```
connect → probe 远端设备 → resolveReleaseAsset
  → 依序 fetch descriptor 候选（CDN… → GitHub Release）
  → 命中后写入按版本隔离的 remote cache
  → local-download-upload: 本机下载 archive 并上传远端
  → remote-download: 把候选 URL 交给远端自行下载
```

失败诊断：descriptor 候选全部失败时，错误信息必须按序保留每个候选的失败原因
（HTTP 状态码等），不允许只抛笼统的 "Unable to resolve Source Server release descriptor"；
候选 URL 本体由 `sanitizeRemoteConnectionLog` 统一脱敏为 `[redacted-url]`，
这是共享日志安全边界，不为诊断需求单独放行。

## 验收场景

1. 注入 GitHub 根时，production 候选列表 = [CDN×N, `<github-root>/v<version>`]；
   test 环境与显式覆盖不追加。
2. `buildReleaseBaseCandidates` 对以 `/v<version>` 结尾的基址只返回原基址，不产生
   `<base>/<version>` 重复候选。
3. 未注入 GitHub 根（上游官方构建）时，候选列表与现状逐项相等。
4. CI：Release assets 同时包含安装包与 `source-server-release.json` + 4 个平台 archive；
   打包应用连 WSL 时 descriptor 从 GitHub Release 下载成功，SHA/size 校验通过。
