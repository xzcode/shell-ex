# 构建、安装与签名更新

## 自动构建

`.github/workflows/desktop.yml` 在 master 代码推送或手动触发时构建：

| 目标 | Runner | 产物 |
| --- | --- | --- |
| Apple Silicon | macos-15 / aarch64-apple-darwin | `.app` 构建，分发 `.dmg` |
| Windows x64 | windows-latest / x86_64-pc-windows-msvc | NSIS `.exe` |
| Linux x64 | ubuntu-24.04 / x86_64-unknown-linux-gnu | `.deb` |

在 GitHub → Actions → Desktop packages → 对应运行摘要的 **Download build draft** 下载，或进入仓库 Releases 找到 `build-提交前12位` 草稿。每个平台同时提供 SHA-256 校验文件、来源提交和工作流记录。草稿保持未发布状态，需要仓库相应权限才能访问。

2026-11-23 首轮 macOS 原生构建和 DMG 已成功生成，但账户 Actions artifact 存储配额耗尽，阻止附件上传。发行流程因此采用 GitHub Release 资产存储；不删除其他项目产物、不调整账户付费设置。不同平台独立构建并添加到同一来源提交的草稿，故下载前需确认所选平台任务已成功。文件名包含运行编号及重试序号，重复运行保留既有文件，不替换安装包或修改已发布发行版。

`verify.yml` 独立运行核心风险/回环 OpenSSH 测试与 Playwright 交互/截图检查。master 的界面报告也存入对应构建草稿，测试截图来自专用 TEST-NET 虚构主机。PR 不上传发行资产。构建不会公开仓库或上传用户主机配置。

## 本机安装

macOS：打开 DMG，把 Shell EX 拖入 Applications。当前构建使用 ad-hoc 签名，不代表 Apple Developer 身份验证或公证。系统如果要求允许打开，应先核对下载来自此私有仓库的预期构建；不需要关闭全局 Gatekeeper。

Windows：运行 NSIS 安装程序。没有 Authenticode 证书的个人构建可能显示未识别发布者。Linux：用系统包管理器安装 `.deb`，需要图形会话与 WebKitGTK 4.1 运行时；保存密码还需要可用的 Secret Service。

本机源码启动步骤在 README。CI 的产物构建成功只证明对应工具链成功完成打包，不代替每台真实设备上的登录、系统凭据库和交互验收。

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
