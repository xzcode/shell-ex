# M0–M5 实现与验证状态

版本 0.1.0，2026-11-23。当前代码覆盖 M0–M5。此表区分功能实现、行为测试、平台构建和正式签名，避免把其中一种结果替代另一种。

## 功能交付

| 阶段 | 已提交的功能 | 验证 |
| --- | --- | --- |
| M0 | PRD、界面规范、架构/安全/发行决策、IPC 协议和交接 | 文档对应实际代码，功能边界已列出 |
| M1 | 主机管理、身份验证、4 种认证、真实 SSH/本地 PTY、多标签、凭据库、SQLite | 编译、认证协议及真实 OpenSSH PTY/Agent/exec 测试通过 |
| M2 | SFTP、文件/目录上传下载、队列、校验续传、取消、安全编辑与另存为 | 2 项真实 OpenSSH 文件/目录集成通过 |
| M3 | Linux 资源和进程、信号操作、本地终端、快捷命令 | 实际 /proc 采集及本地 PTY 行列验证通过，解析边界测试通过 |
| M4 | 上下/左右分屏、代理、跳板、3 种隧道、保守 SSH config 导入、工作区恢复 | 真实 OpenSSH 跳板/转发/代理通过，导入边界测试通过 |
| M5 | Docker 容器/镜像/日志/动作、加密备份与恢复、桌面打包流水线、条件启用的签名更新 | 真实 Docker 生命周期与日志、加密备份验证通过；安装说明见 [发行说明](../RELEASE.md) |

## 当前本地验证记录

- `cargo check -p shell-ex-core`：通过。
- `cargo test -p shell-ex-core --lib --test auth_protocol`：20 个核心单元测试、1 个认证/PTY 协议测试通过。
- 隔离回环 OpenSSH：2 项 SSH/代理/转发测试通过；2 项文件与目录测试通过。
- `npm run build`：TypeScript 与 Vite 生产构建通过，包含本地 Monaco workers。
- 完整桌面 Rust 编译（`cargo check -p shell-ex`）：通过，包括 Tauri IPC、GTK/WebKitGTK 绑定与所有业务模块。
- Playwright 浏览器执行：本地 Chromium 由于运行环境禁止 Unix socket 无法启动，已加入 CI，不记作本地通过。

## 真实 CI 证据

本次交付来源为 `7c5b2e547dabb48de4d42cfd00ed4dde5181cf87`，已包含终端 ACK 恢复和关闭自动重连链的补丁。[核心验收作业](https://github.com/xzcode/shell-ex/actions/runs/45173939448/job/137690213616) 已成功完成，共 **26 项通过**：

| 验证范围 | 通过数 | 执行时间，不含编译 |
| --- | ---: | ---: |
| 核心单元测试 | 20 | 8.14 秒 |
| 认证与终端协议 | 1 | 0.15 秒 |
| 真实 OpenSSH PTY、Agent、跳板、代理、隧道 | 2 | 1.27 秒 |
| SFTP、目录、传输完整性与监控 | 2 | 2.78 秒 |
| 真实 Docker 生命周期与日志 | 1 | 12.11 秒 |

该次 Linux CI 确认了本地环境未能执行的真实 OpenSSH PTY 与 SSH Agent。Docker 实际验证镜像和容器列表、两路日志、启动/停止/重启，并确认测试容器被清理。参见 [SSH 证据](SSH_EVIDENCE.md)、[文件证据](FILE_TRANSFER_EVIDENCE.md)、[Docker 证据](DOCKER_EVIDENCE.md)。

[界面验收作业](https://github.com/xzcode/shell-ex/actions/runs/45173939448/job/137690213209) 已成功，Playwright 结果为 **2 passed，报告总耗时 38.1 秒**；其中终端 ACK 用例 36 ms、工作台用例 4.7 秒。工作台验收包含主机操作、凭据存储边界、预览禁止远程执行、主题与主机持久化、1024px 无横向溢出；ACK 用例覆盖有界重试、超时、顺序恢复与取消后的晚到结果。截图按来源提交单独记录，参见 [界面证据](../design/UI.md#本次实现的实际截图)。

[Linux 桌面作业](https://github.com/xzcode/shell-ex/actions/runs/45173939358/job/137690212872) 中的 `terminal_delivery_tests` 也已实际通过：**2 passed，0 failed，0 ignored，0.01 秒**。两个用例为 `early_delivery_failure_cancels_auth_and_closes_after_registration_once` 和 `failed_native_channel_closes_only_its_registered_local_pty`，分别验证早期认证事件传递失败后的取消及单次清理，以及失效原生通道只关闭所属的真实本地 PTY。

最终确认 **30 项测试通过：核心 26 项 + Playwright 2 项 + Linux 原生通道 2 项**。[Verify 45173939448](https://github.com/xzcode/shell-ex/actions/runs/45173939448) 与 [Desktop packages 45173939358](https://github.com/xzcode/shell-ex/actions/runs/45173939358) 均已成功完成。

## 三平台安装包

三平台原生安装包采用独立任务构建，均已成功上传。每个平台提供安装包、SHA-256 文件及 `build.json`，共 9 份平台资产。因账户 Actions artifact 配额已满，安装包保存为 [构建草稿 build-7c5b2e547dab](https://github.com/xzcode/shell-ex/releases/tag/untagged-6d29ca13145ab69d76fb)。以下结果来自同一来源提交的 [Desktop packages 45173939358](https://github.com/xzcode/shell-ex/actions/runs/45173939358)，文档提交本身不改变安装包代码。具体文件名、大小和校验值见 [发行说明](../RELEASE.md#本次构建结果)。

| 平台 | 安装包 | 当前结果 | 作业证据 |
| --- | --- | --- | --- |
| macOS Apple Silicon | `.dmg` | 构建与草稿上传成功；ad-hoc 签名，未公证 | [macOS 作业](https://github.com/xzcode/shell-ex/actions/runs/45173939358/job/137690212900) |
| Windows x64 | NSIS `.exe` | 构建与草稿上传成功；未做 Authenticode 签名 | [Windows 作业](https://github.com/xzcode/shell-ex/actions/runs/45173939358/job/137690212384) |
| Linux x64 | `.deb` | 构建与草稿上传成功，原生通道清理 2 项测试通过 | [Linux 作业](https://github.com/xzcode/shell-ex/actions/runs/45173939358/job/137690212872) |

## 终端恢复与关闭语义

以下行为已写入本次来源提交。核心背压测试、包含 ACK 恢复的界面测试及 Linux 原生通道清理测试均已实际执行并通过。

| 行为 | 实际实现与边界 |
| --- | --- |
| 有界 ACK 恢复 | xterm 的 write 完成回调后按顺序确认；每次 IPC 5 秒期限，最多 3 次尝试，重试等待 250/750 ms；重复确认幂等 |
| 输出背压 | 每会话最多 32 个待确认帧，每帧最多 16 KiB；不无限向界面堆积待确认输出 |
| 失败后终止 | ACK 持续失败时禁用所属终端输入、显示错误并关闭该会话；原生事件无法送达时同样清理所属会话，认证提示无法送达则取消等待 |
| 关联资源清理 | 远程会话清理只处理其传输、监控、隧道和 SSH；本地只终止所属 PTY；不关闭其它会话 |
| 关闭与重连 | 源会话持有 AbortController；手动关闭先标记 closing、中止信号并清除计时器；探测、凭据检查和 SSH 调用返回后检查取消状态，取消等待中的认证交互 |
| 晚到的新连接 | 前端信号不直接撤回原生连接调用；取消后返回的新会话立即请求关闭，成功后清理缓存；关闭失败保留可操作的错误标签页且禁止该会话再次自动重连 |
| 关闭失败可见 | 源会话的关闭 IPC 失败也保留错误状态，供用户重试关闭，不假报已关闭；应用退出中止所有重连链与计时器 |
| 取消后的异步结果 | 退出会话或卸载组件会停止重试；晚到的 IPC 成功/失败被处理，不继续推进已终止的 ACK 队列 |

验证入口为 `terminal-ack.spec.ts` 和桌面 Rust `terminal_delivery_tests`，分别在本次界面作业和 Linux 桌面作业通过。核心背压测试、界面恢复与原生通道清理是三个验收范围，结果分别记录。

## 实机和分发边界

当前测试容器不是用户的 Mac。Apple Silicon 的 Keychain、macOS 交互、Windows 系统凭据与安装体验需要对应系统证据。测试未连接或改动用户的生产服务器。

本地非 root OpenSSH 不能写登录记录，所以实际 OpenSSH PTY 分支在本地排除；真实本地 PTY 与受控 SSH PTY 协议已分别通过。SSH Agent 因 Unix socket 限制在本地排除；这些本地限制已由上文 Linux CI 的真实 PTY 与 Agent 验证补齐。

Docker 已在 Linux CI 的真实 daemon 上通过生命周期验收；这不代表用户服务器上的 Docker 权限策略也相同。

默认安装包没有 Apple Developer 公证或 Windows Authenticode 证书；macOS 使用 ad-hoc。自动更新需要发行公钥、HTTPS 清单和签名包，当前未配置。相应代码与构建入口已交付，不声称已经开通可信发布服务。

## 功能约束

传输恢复仅限当前进程。UTF-8 编辑上限 5 MiB。目录规划上限 1000 文件/2048 条目/32 层。ACL/xattrs 没有完整复制，原子覆盖依赖服务器扩展。详见 [文件验证](FILE_TRANSFER_EVIDENCE.md)、[SSH 验证](SSH_EVIDENCE.md)、[安全说明](../SECURITY.md)。
