# 发布流水线的构建复用与缓存

## 背景

`.github/workflows/release-on-push.yml` 过去是**单 job 串行**：`pnpm install` → `pnpm bundle:desktop`
（Windows 安装包）→ `pnpm prepare:remote-assets`（4 个平台 Source Server 归档）→ 创建 Release。
由此产生三类浪费：

1. **每次 run 都是冷缓存**：工作流没有任何 `actions/cache`，只有 setup-node 的 pnpm store 缓存。
   Electron runtime（本机 `%LOCALAPPDATA%\electron\Cache` 实测 2.4 GB，单版本约 0.3 GB）、
   electron-builder 二进制（本机 87 MB：nsis / nsis-resources / winCodeSign / icons）、
   `node_modules/.cache/zcode-server-cli`（4 个目标的 Node v22.16.0 与 native search tools）
   每次都要重新下载。[bundle.mjs](../../packages/desktop/scripts/bundle.mjs) 的镜像兜底与最多 3 次尝试
   正是为这类下载抖动准备的补丁。
2. **同一 job 内重复构建 agent 与插件 runtime**：`prepare:agent-bundle` 先经
   [build-desktop-agent-cli.mjs](../../scripts/build-desktop-agent-cli.mjs) 构建 9 个 CLI 包 + 8 个插件
   runtime，随后又对**同一批 8 个插件**再跑一遍 `pnpm --filter … build`；
   `prepare:remote-assets` 的第一个目标还会**再次**跑完整条 agent 构建链。
3. **发布用不到的组件归档**：`stageRemoteAssetsCli` 只在 `--linux`（开发入口）传
   `--skip-component-archives`，发布路径仍为每个目标生成 5 个组件归档（重复哈希 + 复制 + 压缩），
   而 Release 只发布 descriptor 与 4 个整包。

两个大步骤（安装包 / remote assets）互不依赖却串行，进一步拉长关键路径。

本 spec 定义发布流水线的缓存对象、构建复用边界、组件归档的发布范围、job 拆分与计时口径。

## 产品规则

1. 缓存只用于避免重复下载，不得改变构建输入：命中缓存后的版本、摘要与架构校验仍由各脚本自行
   fail-closed 完成（`ensureNodeBinary` 按 `node-v<版本>-<目标>` 隔离，`prepare-native-search-tools.mjs`
   按版本/摘要/架构校验）。缓存 key 只跟随真正决定内容的文件，并用 `restore-keys` 兜底。
2. 同一轮构建内插件 runtime 只构建一次：`build-desktop-agent-cli.mjs` 必须记录本轮实际构建的插件包
   （marker：`node_modules/.cache/desktop-agent-build.json`），`prepare-agent-node-bundle` 只有在
   marker 覆盖了它声明的全部 `requiresRuntime` 插件时才跳过重建；marker 缺失、损坏或覆盖不全时
   一律按原行为重建。无论是否重建，`assertOfficialPluginRuntime` 的存在性断言都保留。
   只有 pnpm 路径真实构建并校验过插件 runtime，因此读取端只信任 `mode: "pnpm"`；turbo 与
   bootstrap-with-remote 写空清单，且每次构建入口先清空 marker，使「marker 存在」等价于
   「本轮构建跑到了写入口」，而不是上一轮的残留。marker 只是缓存提示：写不进去只损失复用，
   不让构建失败。
3. agent bundle 在同一 workspace 内不重复构建：`stageCli --skip-agent-build` 维持 fail-closed
   （缺 bundle 直接失败）。发布链路通过「安装包与 remote assets 分属不同 job、各自构建一次」消除
   串行重复，不引入跨 job 的产物复用。
4. 发布路径不构建组件归档：CI 调用 `prepare:remote-assets` 时显式传 `--skip-component-archives`，
   descriptor 只列 4 个整包；开发入口 `prepare:remote-assets:linux` 的既有行为不变，
   不传该参数时仍产出组件归档。
5. job 拆分固定为 `stamp` → （`build-desktop` ∥ `build-remote-assets`）→ `release`：
   - 版本戳由 `stamp` job 唯一生成并通过 job output 传递，两个构建 job 各自把它写回自己工作区的
     `package.json`，保证安装包的 `ZCODE_VERSION` 与 descriptor 的 `version` 同源；写回由
     [apply-release-version.mjs](../../scripts/apply-release-version.mjs) 统一实现，`stamp` job 本身
     不修改工作区；
   - 构建 job 只上传自己产出的文件，`release` job（`ubuntu-latest`，不 checkout、不 install）下载后
     按既有 glob 发布；
   - 构建产物以 artifact 传递，保留期 1 天，避免长期占用 artifact 存储；产物本身已压缩，
     上传使用 `compression-level: 0`。
6. remote assets 链路必须输出与桌面打包同口径的 `[ci][timer] <label> start/end duration_ms=`，
   用于后续按实测决定是否继续优化（例如 4 个目标并行 stage）。该格式由
   `src/packaging/stepTimer.ts` 唯一实现，输出裸行不加 `[stage]` 前缀；父步骤
   （`remote-assets:<target>`）的耗时包含子进程内部的 `stage:*` 耗时，各行不可相加。

## 所有者与接口

- 缓存与 job 编排唯一所有者：`.github/workflows/release-on-push.yml`。
- 版本戳所有者：`stamp` job（`GITHUB_OUTPUT` 的 `version` / `tag`）；构建 job 只做应用，不重新计算。
  写回实现所有者：[apply-release-version.mjs](../../scripts/apply-release-version.mjs)。
- 插件 runtime 构建事实的唯一来源：[build-desktop-agent-cli.mjs](../../scripts/build-desktop-agent-cli.mjs)
  写入的 marker；读取与判定集中在
  [desktop-agent-build-marker.mjs](../../scripts/desktop-agent-build-marker.mjs)。
- 组件归档开关所有者：`stageRemoteAssetsCli` 的 `--skip-component-archives`（透传给每个目标）。
- 计时口径所有者：`packages/zcode-server-cli/src/packaging/stepTimer.ts`，由 `stageRemoteAssetsCli`
  与 `stageCli` 共用。

## 事件顺序

```text
push(my_dev)
  └─ stamp：读 package.json → version=<base>-build.<UTC 戳> → tag=v<version>
       ├─ build-desktop（并行）        └─ build-remote-assets（并行）
       │    apply version                 apply version
       │    restore electron 缓存         restore zcode-server-cli 缓存
       │    install → bundle:desktop      install → prepare:remote-assets --skip-component-archives
       │    upload artifact               upload artifact（descriptor + 4 整包）
       └──────────────► release（ubuntu-latest）：download 两个 artifact → softprops/action-gh-release
```

## 验收场景

1. `stamp` job 输出的 `version` 同时出现在安装包产物名/`latest*.yml` 与
   `mock-cdn/releases/<version>/source-server-release.json` 中；两个构建 job 的 `package.json`
   版本一致。
2. 命中缓存时不再出现 Electron / electron-builder / Node 二进制 / native tools 的下载日志；
   未命中时构建行为与改造前逐项一致（版本、摘要、架构校验仍由脚本执行）。
3. 桌面 job 内 8 个官方插件 runtime 各只构建一次；marker 缺失、损坏或插件清单扩大时回退为重建，
   非 pnpm 路径（turbo / bootstrap-with-remote）写入的 marker 不被信任，上一轮遗留的 marker 在
   构建入口即被清空；`assertOfficialPluginRuntime` 仍会在产物缺失时失败。
4. 发布产物 = Windows 安装包（`.exe` / `.blockmap` / `latest*.yml`）+ descriptor + 4 个整包，
   不含 `components/**`；`prepare:remote-assets` 不带 `--skip-component-archives` 时行为不变。
5. remote assets 链路日志包含每个目标与每个阶段的 `[ci][timer] … duration_ms=`。
6. `release` job 在任一构建 job 失败时不会发布（`needs` 门禁），`fail_on_unmatched_files: true`
   仍能在产物缺失时失败。
