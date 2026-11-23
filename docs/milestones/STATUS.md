# M0–M5 实现与验证状态

版本 0.1.0，2026-11-23。此表区分功能实现、行为测试、平台构建和正式签名，避免把其中一种结果替代另一种。

## 功能交付

| 阶段 | 已提交的功能 | 验证 |
| --- | --- | --- |
| M0 | PRD、界面规范、架构/安全/发行决策、IPC 协议和交接 | 文档对应实际代码，功能边界已列出 |
| M1 | 主机管理、身份验证、4 种认证、真实 SSH/本地 PTY、多标签、凭据库、SQLite | 核心编译通过，单元/认证协议/真实 OpenSSH service 测试通过 |
| M2 | SFTP、文件/目录上传下载、队列、校验续传、取消、安全编辑与另存为 | 2 项真实 OpenSSH 文件/目录集成通过 |
| M3 | Linux 资源和进程、信号操作、本地终端、快捷命令 | 实际 /proc 采集及本地 PTY 行列验证通过，解析边界测试通过 |
| M4 | 上下/左右分屏、代理、跳板、3 种隧道、保守 SSH config 导入、工作区恢复 | 真实 OpenSSH 跳板/转发/代理通过，导入边界测试通过 |
| M5 | Docker 容器/镜像/日志/动作、加密备份与恢复、桌面打包流水线、条件启用的签名更新 | 参数与备份验证通过；平台构建和浏览器验收见后续构建记录 |

## 当前本地验证记录

- `cargo check -p shell-ex-core`：通过。
- `cargo test -p shell-ex-core --lib --test auth_protocol`：20 个核心单元测试、1 个认证/PTY 协议测试通过。
- 隔离回环 OpenSSH：2 项 SSH/代理/转发测试通过；2 项文件与目录测试通过。
- `npm run build`：TypeScript 与 Vite 生产构建通过，包含本地 Monaco workers。
- 完整桌面 Rust 编译（`cargo check -p shell-ex`）：通过，包括 Tauri IPC、GTK/WebKitGTK 绑定与所有业务模块。
- Playwright 浏览器执行：本地 Chromium 由于运行环境禁止 Unix socket 无法启动，已加入 CI，不记作本地通过。

## 实机和分发边界

当前测试容器不是用户的 Mac。Apple Silicon 的 Keychain、macOS 交互、Windows 系统凭据与安装体验需要对应系统证据。测试未连接或改动用户的生产服务器。

本地非 root OpenSSH 不能写登录记录，所以实际 OpenSSH PTY 分支在本地排除；真实本地 PTY与受控 SSH PTY 协议已分别通过。SSH Agent 因 Unix socket 限制在本地排除，CI 有权限时会启用。

Docker 模块具备实际命令实现，尚未对真实 Docker daemon 执行容器生命周期验证。不会把纯参数校验称为 Docker 实机成功。

默认安装包没有 Apple Developer 公证或 Windows Authenticode 证书；macOS 使用 ad-hoc。自动更新需要发行公钥、HTTPS 清单和签名包，当前未配置。相应代码与构建入口已交付，不声称已经开通可信发布服务。

## 功能约束

传输恢复仅限当前进程。UTF-8 编辑上限 5 MiB。目录规划上限 1000 文件/2048 条目/32 层。ACL/xattrs 没有完整复制，原子覆盖依赖服务器扩展。详见 [文件验证](FILE_TRANSFER_EVIDENCE.md)、[SSH 验证](SSH_EVIDENCE.md)、[安全说明](../SECURITY.md)。
