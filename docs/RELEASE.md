## 无 GitHub Actions 的 macOS 发行方式

如果 GitHub Actions 托管 Runner 额度已用完，**不要继续重试同一工作流**。在已登录 GitHub 的 Apple Silicon Mac 上安装 Node.js、Rust、Xcode Command Line Tools、GitHub CLI（`brew install gh`），并执行：

```bash
git switch master
git pull --ff-only
gh auth login     # 首次使用 GitHub CLI 时
bash scripts/release_local_macos.sh
```

此脚本核对 v0.3.2 的三个版本号，直接在 Mac 上通过 Tauri 生成 DMG、附带 SHA-256 和来源提交 JSON，然后通过 `gh release create` 发布正式 `v0.3.2`，**不调用 GitHub Actions**。如果缺少 GitHub CLI 或登录状态，仍会先产出本地 DMG，但不会谎称已发布。macOS 使用 ad-hoc 签名，尚未 notarize；这是个人构建的发行边界。

此发行入口首先覆盖 Mac Apple Silicon。Windows/Linux 安装包需在相应系统上另行构建，不会把旧版本的 Windows/Linux 文件充作 v0.3.2。若需由 ChatGPT 代操作 Mac，需先将该 Mac 连接到可操作的远程桌面工具；当前账户连接的远程设备仅有 Linux 主机。

## v0.3.1 待打包状态（2026-11-24）

[应用新代码](https://github.com/xzcode/shell-ex/commit/4669cc80e324092a15eed2ca904c8a050edd5fde) 已合并并通过独立测试，但 GitHub Actions 三平台包作业 [45337791471](https://github.com/xzcode/shell-ex/actions/runs/45337791471) 在取得 Runner 前失败，`runner_id=0` 且 `steps=[]`。macOS / Windows / Linux 新安装包**未生成**，正式 `v0.3.1` 标签和 Release 也未创建。禁止将 v0.3.0 的旧产物冒充新版本，待 Actions 资源问题排除后从 `master` 重建，见 [v0.3.1 版本说明](releases/v0.3.1.md)。

# 构建、安装与签名更新

## v0.3.0 当前构建与发布状态（2026-11-24）

应用代码来源：`a247fc10f27466c781d8f9ed335e0063ecc62051`。本版新增本地加密密码库，并把身份认证并入基本信息，旧配置 `credentialStore` 缺省为系统凭据库。

[Verify 45322075422](https://github.com/xzcode/shell-ex/actions/runs/45322075422) 与 [Desktop packages 45322075361](https://github.com/xzcode/shell-ex/actions/runs/45322075361) 均成功。macOS Apple Silicon DMG、Windows x64 EXE、Linux x64 DEB、逐平台 SHA-256、build.json 和 UI 验收报告共 **12 个附件**，均保存在 [v0.3.0 已验收构建草稿](https://github.com/xzcode/shell-ex/releases/tag/untagged-caa6163daf2a2574e4f6)。当前 GitHub Release id `456283740`，tag 暂为 `build-a247fc10f274`，`draft=true`。不能把草稿写成正式 Release。

| 平台 | 文件 | SHA-256 |
| --- | --- | --- |
| macOS Apple Silicon | `Shell-EX_0.3.0_aarch64-r45322075361.1.dmg` | `62e85c07cf0baf8646ba378f460879231b66a59c77e07320dc4c871e04daacda` |
| Windows x64 | `Shell-EX_0.3.0_x64-setup-r45322075361.1.exe` | `3485ca33473b41ed83dbc55f6bb92f7c5506d7a19f8476f7b1becccee62a2221` |
| Linux x64 | `Shell-EX_0.3.0_amd64-r45322075361.1.deb` | `3920d1c8f6f7d5b6d6708dabda547c7e4ed484d8be7a01bc3ba892185be05fc5` |

正式发布自动化位于 `release/v0.3.0` 分支 `.github/workflows/publish-v0.3.0.yml`。该作业在获得 Runner 前即结束（`runner_id=0`、`steps=[]`、无日志）；更换 `ubuntu-24.04` 与 `ubuntu-latest`、重复运行均未解决。可能涉及 Actions 限额/权限或 GitHub Runner 分配问题，具体原因尚未确认。[失败作业](https://github.com/xzcode/shell-ex/actions/runs/45323404699)。恢复后可重新执行发布工作流；或在 GitHub Releases 编辑现有草稿，设置 `v0.3.0` 标签（目标提交 `a247fc1`），使用 [v0.3.0 版本说明](releases/v0.3.0.md)，选择 Publish release。不重新上传、更换或覆盖已验收的 12 个附件。

## 自动构建

`.github/workflows/desktop.yml` 在 master 代码推送或手动触发时构建：

| 目标 | Runner | 产物 |
| --- | --- | --- |
| Apple Silicon | macos-15 / aarch64-apple-darwin | `.app` 构建，分发 `.dmg` |
| Windows x64 | windows-latest / x86_64-pc-windows-msvc | NSIS `.exe` |
| Linux x64 | ubuntu-24.04 / x86_64-unknown-linux-gnu | `.deb` |

开发构建可在 GitHub → Actions → Desktop packages → 对应运行摘要的 **Download build draft** 下载，或进入仓库 Releases 找到 `build-提交前12位` 草稿。每个平台同时提供 SHA-256 校验文件、来源提交和工作流记录。这条自动流程默认保留草稿，正式发布独立执行；普通 master 构建不会自动发布正式版，也不会覆盖已发布版本。下载需要仓库相应权限。本次正式发行见 [v0.1.0](https://github.com/xzcode/shell-ex/releases/tag/v0.1.0) 与 [版本说明](releases/v0.1.0.md)。

2026-11-23 首轮 macOS 原生构建和 DMG 已成功生成，但账户 Actions artifact 存储配额耗尽，阻止附件上传。发行流程因此采用 GitHub Release 资产存储；不删除其他项目产物、不调整账户付费设置。不同平台独立构建并添加到同一来源提交的草稿，故下载前需确认所选平台任务已成功。文件名包含运行编号及重试序号，重复运行保留既有文件，不替换安装包或修改已发布发行版。

`verify.yml` 独立运行核心风险/回环 OpenSSH 测试与 Playwright 交互/截图检查。master 的界面报告也存入对应构建草稿，测试截图来自专用 TEST-NET 虚构主机。PR 不上传发行资产。构建不会公开仓库或上传用户主机配置。

终端 ACK 恢复补丁通过对应提交的界面测试与 Linux 桌面原生通道清理测试验收。`terminal-ack.spec.ts` 覆盖顺序恢复、重试耗尽、超时和取消后的晚到结果；Linux 打包任务执行 `terminal_delivery_tests`，覆盖事件传递失败时的所属会话清理。以下结果均引用本次来源提交的实际工作流。

## 本次构建结果

来源提交：`7c5b2e547dabb48de4d42cfd00ed4dde5181cf87`。[正式 Release v0.1.0](https://github.com/xzcode/shell-ex/releases/tag/v0.1.0) 已发布并设为 Latest，非草稿、非预发布；Git 标签精确指向该来源提交。[正式发布作业 45182812179](https://github.com/xzcode/shell-ex/actions/runs/45182812179) 已成功，复用原有 12 份资产，资产 ID、大小和摘要保持不变。

安装包来自已成功完成的 [Desktop packages 45173939358](https://github.com/xzcode/shell-ex/actions/runs/45173939358)。三个平台各自提供安装包、SHA-256 校验文件及 `build.json`，共 9 份平台资产；其余为界面验收资产。版本内容见 [v0.1.0 说明](releases/v0.1.0.md)。文档后续更新不改变这些安装包的代码来源。

| 平台 | 安装包 | 当前结果 | 作业证据 |
| --- | --- | --- | --- |
| macOS Apple Silicon | `.dmg` | 构建成功，已正式发布 | [macOS 作业](https://github.com/xzcode/shell-ex/actions/runs/45173939358/job/137690212900) |
| Windows x64 | NSIS `.exe` | 构建成功，已正式发布 | [Windows 作业](https://github.com/xzcode/shell-ex/actions/runs/45173939358/job/137690212384) |
| Linux x64 | `.deb` | 构建成功，已正式发布；原生通道清理 2 项测试通过 | [Linux 作业](https://github.com/xzcode/shell-ex/actions/runs/45173939358/job/137690212872) |

已确认的安装包与大小：

| 平台 | 安装包文件 | 大小，字节 |
| --- | --- | ---: |
| macOS Apple Silicon | `Shell-EX_0.1.0_aarch64-r45173939358.1.dmg` | 8,324,314 |
| Windows x64 | `Shell-EX_0.1.0_x64-setup-r45173939358.1.exe` | 7,809,111 |
| Linux x64 | `Shell-EX_0.1.0_amd64-r45173939358.1.deb` | 9,013,590 |

对应 SHA-256：

```text
e8ee75ddb6e25cfa02b260ed22c79b50f0ae3fc8ce740a70842a820f4a1d7136  Shell-EX_0.1.0_aarch64-r45173939358.1.dmg
d03f72b097a99a24bf65b74923400c782d4eb9a03deadd22558a644a6903e21e  Shell-EX_0.1.0_x64-setup-r45173939358.1.exe
786768dc3a6aeabfc8400386e2e87a0bb88067ebd6880324a59b7f189208a09a  Shell-EX_0.1.0_amd64-r45173939358.1.deb
```

同一提交的 [Verify 核心作业](https://github.com/xzcode/shell-ex/actions/runs/45173939448/job/137690213616) 通过 26 项测试；[界面作业](https://github.com/xzcode/shell-ex/actions/runs/45173939448/job/137690213209) 的 2 项 Playwright 测试通过，报告总耗时 38.1 秒；[Linux 作业](https://github.com/xzcode/shell-ex/actions/runs/45173939358/job/137690212872) 的原生通道清理测试 2 项通过、0 失败、0 忽略，耗时 0.01 秒。合计 **30 项通过：26 + 2 + 2**。核心测试、平台构建与界面验收分别记录，不能互相替代。当前 macOS 包采用 ad-hoc 签名，未做 Apple Developer 公证；Windows 包未做 Authenticode 签名。

## 本机安装

macOS：打开 DMG，把 Shell EX 拖入 Applications。当前构建使用 ad-hoc 签名，不代表 Apple Developer 身份验证或公证。系统如果要求允许打开，应先核对下载来自此私有仓库的预期构建；不需要关闭全局 Gatekeeper。

Windows：运行 NSIS 安装程序。没有 Authenticode 证书的个人构建可能显示未识别发布者。Linux：用系统包管理器安装 `.deb`，需要图形会话；已确认包的 `Depends` 包含 `fonts-noto-cjk`、`libwebkit2gtk-4.1-0` 和 `libgtk-3-0`，分别提供中文字体及桌面运行时；保存密码还需要可用的 Secret Service。

Linux 包在 Ubuntu 24.04 x64 上构建；其它发行版需具备兼容的系统库，当前没有覆盖所有 Linux 发行版的安装验证。macOS 本次仅提供 Apple Silicon 产物。

本机源码启动步骤在 README。CI 的产物构建成功只证明对应工具链成功完成打包，不代替每台真实设备上的登录、系统凭据库和交互验收。

## 终端异常时的使用行为

终端确认通信短暂失败时会自动重试，每次调用 5 秒超时、最多 3 次尝试。持续失败会停止该终端输入，显示错误并关闭所属会话及关联资源；其它连接继续独立工作。前端事件无法送达时，原生后端也会触发所属会话清理。不能确认关闭成功时，界面保留关闭失败提示。

手动关闭源会话会取消它的整条自动重连流程；身份探测、凭据检查及连接步骤返回后都会检查取消状态。已经发出的连接请求如果随后成功，应用会立即请求关闭新会话，不重新打开已取消的连接。若关闭失败，会保留可操作的错误标签页并停止该会话的自动重连，供用户重试关闭。

重新连接创建新的远程 shell，不承诺恢复断线前的进程。应用退出也会取消重连流程。安装升级或退出应用前应保存编辑内容、处理正在进行的传输；当前传输队列不支持跨应用重启恢复。

## macOS 正式公证

正式分发时在受控构建环境提供 Developer ID Application 证书与公证身份。使用 GitHub secrets 或本机钥匙串，不把私钥、P12 或密码写进仓库。Tauri 支持 `APPLE_CERTIFICATE`、`APPLE_CERTIFICATE_PASSWORD`、`APPLE_SIGNING_IDENTITY` 和相应公证凭据，具体按照官方签名文档核对配置。

默认 `signingIdentity` 为 `-`。正式发行通过额外配置覆盖为实际身份。没有证书时不应把 ad-hoc 包标记成“已公证”。

## 更新信任根

应用支持签名更新，但默认不启用。发行者需要：

1. 在本机生成并妥善保存 updater 签名私钥。私钥只进入安全构建环境。
2. 构建时设置 `SHELL_EX_UPDATE_PUBKEY`（公开验证密钥）和 `SHELL_EX_UPDATE_ENDPOINT`（HTTPS 版本清单）。
3. 使用 Tauri 签名工具生成更新包，启用 `bundle.createUpdaterArtifacts`，清单列出版本、平台、下载 URL 与签名。
4. 先验证错误签名、旧包伪装成新版本、错误平台均被拒绝，再开放更新通道。

本版要求 `requireSignedVersion=true`；签名必须带有版本且与清单匹配。构建脚本通过配置文件覆盖启用 artifact，例如：

```json
{
  "bundle": { "createUpdaterArtifacts": true }
}
```

```bash
npm run tauri -- build --config src-tauri/tauri.release.conf.json
```

不要把私有 GitHub 下载链接直接当作无需认证的公共更新源。当前个人构建可先手动下载安装包；这不会影响 SSH/SFTP 功能。

## 版本与回退

更新产品版本时同步根 Cargo.toml、apps/desktop/package.json 与 tauri.conf.json，并更新两份锁文件。每次发行记录提交、平台、构建结果与已知边界。升级前导出加密备份；默认不携带凭据，确需迁移凭据时显式勾选。

数据库迁移当前为版本 1，采用 schema_migrations 记录。未来破坏性迁移需先有可恢复备份与兼容策略，不能假设旧程序总能读新格式。

官方参考：[Tauri GitHub 构建](https://v2.tauri.app/distribute/pipelines/github/)、[macOS 签名](https://v2.tauri.app/distribute/sign/macos/)、[Updater](https://v2.tauri.app/plugin/updater/)、[GitHub runner](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)。
