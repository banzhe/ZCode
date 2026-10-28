# Source Server 发行归档的 POSIX 可执行位

## 背景

`.github/workflows/release-on-push.yml` 在 `windows-latest` 上执行 `pnpm prepare:remote-assets`，
一次产出 `linux-x64`、`linux-arm64`、`darwin-x64`、`darwin-arm64` 四个 `zcode-server-<target>.tar.gz`
并上传 Release。NTFS 不保存 POSIX exec 位：`stage.ts` 里的 `chmod(0o755)` 在 Windows 上只切换只读
属性，System32 bsdtar 于是把文件记成 0666、目录记成 0777（bsdtar 3.8.9 没有创建期 mode 选项，
`--mode=…` 与 `--mode …` 两种写法都被拒绝）。远端 `tar -xzf` 原样恢复这些 mode：

```text
connect → probe → preflight(tar 存在) → upload 100% → extract
  → tar -xzf 落出 0666 的 bin/zcode
  → 执行 <bootstrap>/bin/zcode update … ⇒ bash: line 1: …/bin/zcode: Permission denied
```

散件组件路径不受影响：`node-runtime`（`packages/server/src/remote/remoteAssetDeployDecision.ts`）与
native search tools（`packages/server/src/remote/runtimeToolDeploy.ts`）都以 `executable: true` 走
`buildRemoteExecutableReplaceCommand`，由远端补 `chmod +x`。整包 archive 路径过去把「宿主 tar 会
保留 exec 位」当作既有能力，于是 Windows 打包出的归档首次安装必然在 extract 阶段失败；即使绕过
引导步骤，`~/.zcode/server/releases/<id>/runtime/node` 同样是 0666，稳定启动器
`exec "$RELEASE_DIR/runtime/node"` 会再次失败。

本 spec 定义：归档内可执行位的唯一来源是 staging 的显式声明，归档必须携带与宿主文件系统无关的
mode。

## 产品规则

1. 可执行集合由 staging 显式声明，不由宿主文件系统推断：POSIX 目标的 `bin/zcode`、`runtime/node`，
   以及 `runtime/tools/<id>/<binary>` 中实际产出的 native search tools。
2. POSIX 目标 archive 创建完成后，声明集合内条目的 mode 必须规范为 0755；其余条目（普通文件、
   目录）保持宿主 tar 记录，不做全量归一化。
3. 声明集合中任一成员在归档内缺失时 staging fail-closed：抛错并且不产出可发布归档，禁止静默跳过。
4. 宿主已记录 0755 时不得重写归档：POSIX 宿主（Linux/macOS）的 staging 产物与改造前逐字节相等，
   不引入新的压缩差异与哈希漂移。
5. 重写 mode 必须同步重算 tar 头 checksum；有效路径匹配必须覆盖长路径条目（PAX `path=` 与 GNU `L`
   头），不能只匹配 100 字节 name 字段。
6. 修复 owner 在 staging 侧：远端安装链不新增「解压后 chmod」步骤，也不要求远端 tar 具备额外能力。
   win32 目标是 zip 归档且不进入远端安装合同，不参与本规则。

## 所有者与接口

- 可执行集合唯一所有者：`packages/zcode-server-cli/src/packaging/stage.ts`——组装发行目录时同时声明
  可执行路径；native tools 的可执行路径由 `copyNativeTools` 按实际产出返回。
- 归档 mode 重写唯一所有者：`packages/zcode-server-cli/src/packaging/archiveEntryModes.ts`
  （`applyArchiveExecutableModes`），输入为归档路径与相对发行根的可执行路径集合。
- 消费顺序 owner：`collectSourceServerRemoteReleaseArchives` 必须在重写之后计算 `sha256`/`sizeBytes`，
  descriptor 记录的是重写后的归档身份。

## 事件顺序

```text
stageRelease
  ├─ 组装 release dir（bin/zcode、runtime/node、runtime/tools/**）
  ├─ tar -czf（宿主 tar：Windows 记 0666/0777，POSIX 记真实 mode）
  ├─ applyArchiveExecutableModes（仅在声明集合存在非 0755 条目时重写 mode + checksum）
  ├─ 组件哈希 / manifest.json
  └─ collectSourceServerRemoteReleaseArchives → sha256/sizeBytes → descriptor → 上传
```

## 验收场景

1. Windows 宿主 staging 出的 `linux-x64` / `darwin-*` 归档中，`bin/zcode`、`runtime/node`、
   `runtime/tools/<id>/<binary>` 的 mode 为 0755，而 `runtime/server-cli.js` 等普通文件保持宿主记录。
2. POSIX 宿主 staging 出的同一归档在改造前后逐字节相等（sha256 不变）。
3. 声明集合成员在归档内缺失时 `stageRelease` 抛错，不返回归档路径。
4. 重写后的归档能被系统 tar 正常解压（头 checksum 有效），解压出的 `bin/zcode` 在 Linux 上可直接执行。
5. 长路径可执行条目（PAX `path=` / GNU `L` 头）同样被规范为 0755。
