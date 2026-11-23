# Shell EX

个人专属的 SSH 桌面工作台：终端、文件、服务器状态和常用运维操作在同一个窗口完成。

**Tauri 2 · Rust / Tokio · React / TypeScript · xterm.js · Monaco**

当前版本：`0.1.0`。macOS Apple Silicon 为首发平台，同时提供 Windows x64 和 Linux x64 构建。产品功能按 M0–M5 实现；各平台的实际验证结果与发布条件见 [交付状态](docs/milestones/STATUS.md)，不能用代码存在代替验收结果。

## 功能

| 工作域 | 已实现的能力 |
| --- | --- |
| 主机 | 分组、搜索、收藏、复制、配置编辑、SSH config 导入预览、加密迁移 |
| 终端 | SSH 密码/私钥/Agent/交互式认证，本地 PTY，多标签、上下/左右分屏、搜索、字体与主题、尺寸同步、重连 |
| 文件 | SFTP 浏览、多选、目录创建、重命名、权限修改、删除文件/空目录、拖拽上传 |
| 传输 | 上传/下载、目录规划、覆盖策略、有界并发、真实进度、暂停/续传/取消、SHA-256 校验 |
| 编辑 | 本地 Monaco、UTF-8 文本、语法高亮、搜索替换、冲突检测、临时文件与原子替换、另存为 |
| 监控 | Linux CPU、内存、负载、根文件系统容量、网络速率、进程列表与明确触发的信号操作 |
| 网络 | SOCKS5 / HTTP CONNECT、跳板、SSH 本地/远程/动态转发 |
| 运维 | 快捷命令、Docker 容器与镜像列表、日志、启动/停止/重启 |
| 数据 | SQLite 配置、系统凭据库、Argon2id + AES-256-GCM 备份、工作区布局恢复 |

不需要登录产品账号，不依赖自建服务端。程序不包含遥测或自动上传配置。

## 启动桌面应用

需要 Node.js 22+、Rust 1.100+ 和当前平台的 Tauri 开发依赖。macOS 需要 Xcode Command Line Tools；Windows 需要 MSVC C++ 工具链与 WebView2；Linux 需要 GTK 3 / WebKitGTK 4.1 开发包。

```bash
git clone https://github.com/xzcode/shell-ex.git
cd shell-ex/apps/desktop
npm ci
npm run tauri dev
```

只查看界面可运行 `npm run dev`。浏览器会明确显示“界面预览”：主机和设置可在预览中编辑，但不能建立 SSH、本地终端或执行文件操作，也不会保存密码。

## 第一次连接

1. 新建连接，填写主机、端口、用户名，选择密码、私钥、SSH Agent 或交互式认证。
2. 双击连接，核对服务器提供的 SHA-256 公钥指纹后确认信任。指纹变化不会自动接受。
3. 输入当次凭据，或在连接配置中选择保存到系统凭据库。不能访问凭据库时可使用当次输入。
4. 终端打开后，底部可切换文件、传输、快捷命令、隧道和 Docker；右侧显示 Linux 状态。

私钥路径只保存引用。Agent 使用当前用户的系统 Agent，macOS/Linux 通过 `SSH_AUTH_SOCK`，Windows 通过 OpenSSH Agent 命名管道。配置跳板机时，先连接跳板，再连接目标。

普通 SSH 重连会打开新 shell；要让远程任务独立于网络连接，请在服务器上使用 `tmux` 等会话工具。工作区恢复记录配置与布局，不恢复已退出的远程进程。

## 打包

```bash
# 在 macOS 上打包 Apple Silicon 版本
cd apps/desktop
rustup target add aarch64-apple-darwin
npm run tauri -- build --target aarch64-apple-darwin --bundles app,dmg
```

Windows 使用 `--bundles nsis`，Linux 使用 `--bundles deb`。GitHub 的 **Desktop packages** 工作流会分别构建三个平台，将安装包、SHA-256 校验文件与构建来源保存在仓库 **Releases** 中的 `build-提交前12位` 草稿；工作流摘要提供入口。当前 macOS 默认采用 ad-hoc 签名；开发者身份证书、公证与 Windows 代码签名是单独的正式分发条件，详见 [发行说明](docs/RELEASE.md)。

## 必要验证

```bash
# 根目录：核心单元与认证协议测试
cargo test --locked -p shell-ex-core --lib --test auth_protocol

# 根目录：临时回环 OpenSSH，完成后清理；不连接个人服务器
python3 scripts/ssh_fixture.py cargo test --locked -p shell-ex-core \
  --test ssh_integration --test files_integration -- --ignored --test-threads=1

# 前端类型检查与生产构建
cd apps/desktop
npm run build
```

目录、编辑、续传、认证和转发都有实际行为测试。不同变更选择对应验证；不要求为文档或样式改动反复执行全部网络测试。

## 使用边界

- 编辑器只处理 UTF-8、最大 5 MiB 文本；非文本文件使用下载功能。
- 同一运行期可暂停/校验/续传；重启应用不会自动续传遗留任务。目录复制每次最多 1000 个文件，跳过符号链接并显示清单。
- 原文件替换依赖服务器的 OpenSSH `posix-rename` 扩展；不支持时返回明确错误，原文件保留。保留传统权限和 UID/GID，不复制 ACL/xattrs。
- SSH config 导入采用明确支持的字段子集，不执行 `Include`、`Match`、`ProxyCommand` 或本地命令；不支持的路由不会悄悄改成直连。
- 代理认证、旧算法兼容开关、云同步和 MCP 适配未纳入本版。普通 SSH 终端内仍可按服务器策略交互使用 `sudo`；文件面板不会自动提权。
- 签名更新的代码已接入；只有构建时配置可信公钥及 HTTPS 更新源才启用，默认构建不会请求未配置的更新服务。

## 文档导航

- [产品需求与验收](docs/product/PRD.md)
- [界面设计规范](docs/design/UI.md)
- [架构与技术决策](docs/architecture/ARCHITECTURE.md)
- [安全与数据约定](docs/SECURITY.md)
- [发行与升级](docs/RELEASE.md)
- [开发交接](docs/HANDOFF.md)
- [M0–M5 状态和验证](docs/milestones/STATUS.md)

本项目为个人定制软件。应用代码的使用授权见 `LICENSE`；依赖保留各自许可，见 `THIRD_PARTY_NOTICES.md`。
