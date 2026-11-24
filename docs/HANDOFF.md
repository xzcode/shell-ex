# Shell EX 开发交接

## 当前任务与决策

用户已选择完整 FinalShell 替代品方向，并授权直接完成 M0–M5。仓库 `xzcode/shell-ex`，默认 master。当前实现版本 0.3.0；首发 macOS Apple Silicon，三平台构建。正式 Release 暂因 GitHub Runner 启动作业失败而未发布，文件已在构建草稿中。界面使用专业深浅主题、长方形按钮，代码和用户数据均不依赖云账号。

## 代码入口

| 入口 | 职责 |
| --- | --- |
| apps/desktop/src/App.tsx | 会话、主机、布局、认证交互 |
| apps/desktop/src/TerminalView.tsx | xterm 输出、ACK、尺寸、搜索、剪贴板 |
| apps/desktop/src/terminalAck.ts | 按序确认、超时与有界重试、终止后清理 |
| apps/desktop/src/FilePanel.tsx / RemoteEditor.tsx | 文件操作与草稿 |
| apps/desktop/src/OperationsPanels.tsx | 传输、命令、隧道、容器 |
| apps/desktop/src-tauri/src/lib.rs | IPC、配置/凭据事务协调、生命周期 |
| crates/shell-ex-core/src/ssh.rs / pty.rs / tunnels.rs | 连接、终端、转发 |
| crates/shell-ex-core/src/files.rs / transfers.rs / directory_transfers.rs | 文件完整性、传输队列与目录规划 |
| crates/shell-ex-core/src/storage.rs / credentials.rs / backup.rs | 数据、信任、系统凭据与备份 |
| crates/shell-ex-core/src/import.rs | 保守的 SSH config 导入 |
| crates/shell-ex-core/src/monitor.rs / docker.rs | 受控运维操作 |

## 已验证与实机边界

见 [状态表](milestones/STATUS.md)、[SSH 证据](milestones/SSH_EVIDENCE.md)、[文件证据](milestones/FILE_TRANSFER_EVIDENCE.md)。以实际结果为准，不能从某个模块编译通过推断三个系统全部实机通过。

本次交付的构建来源为 `7c5b2e547dabb48de4d42cfd00ed4dde5181cf87`，已包含终端 ACK 恢复及关闭自动重连链的补丁。[Verify 核心作业](https://github.com/xzcode/shell-ex/actions/runs/45173939448/job/137690213616) 的 26 项测试、[界面作业](https://github.com/xzcode/shell-ex/actions/runs/45173939448/job/137690213209) 的 2 项 Playwright 测试，以及 [Linux 原生通道清理作业](https://github.com/xzcode/shell-ex/actions/runs/45173939358/job/137690212872) 的 2 项测试均通过，合计 **30 项**。

[Verify 45173939448](https://github.com/xzcode/shell-ex/actions/runs/45173939448) 与 [Desktop packages 45173939358](https://github.com/xzcode/shell-ex/actions/runs/45173939358) 均成功完成。macOS Apple Silicon、Windows x64 和 Linux x64 的安装包、SHA-256 文件及构建记录已随 [正式 Release v0.1.0](https://github.com/xzcode/shell-ex/releases/tag/v0.1.0) 发布。[发布作业 45182812179](https://github.com/xzcode/shell-ex/actions/runs/45182812179) 成功，Release 为非草稿、非预发布并设为 Latest；标签指向上文来源提交，原有 12 份资产的 ID、大小和摘要保持不变。

版本内容见 [v0.1.0 说明](releases/v0.1.0.md)，完整状态与校验值分别记录在 [状态表](milestones/STATUS.md) 和 [发行说明](RELEASE.md)。后续文档和截图继续按各自产物的来源提交记录。三平台构建通过不代替用户设备上的安装、系统凭据库与交互体验验收。

本地沙箱限制 Unix socket，不能启动 Chromium 或 SSH Agent；非 root OpenSSH 不能写登录记录。GitHub Linux CI 已补齐真实 OpenSSH PTY、Agent、SFTP/转发和 Docker daemon 的实际验证，共 26 项通过。对应日志与来源提交保存在状态和各模块证据文档中。

开发构建使用 `scripts/publish_build.py` 保存到按提交区分的 Release 草稿；每个文件包含运行编号和重试序号，既有产物不被覆盖。普通 master 构建不自动发布正式版，正式发布独立执行；普通构建也不能覆盖已发布版本。浏览器测试使用保留测试地址，不建立 SSH；截图与报告独立保存。

## 终端传递与关闭语义

SSH 和本地 PTY 的终端输出使用同一套按序号确认机制：只有 xterm 处理该帧并触发 `write` 完成回调后才发送 ACK。后端每个会话最多保留 32 个尚未确认的数据帧，每帧最多 16 KiB；这是输出流控窗口，不是应用总内存上限。重复或晚到的同序号 ACK 不重复释放额度。

`TerminalAckController` 对每次 IPC 调用设置 5 秒期限，同一 ACK 最多尝试 3 次，两次重试分别等待 250 ms、750 ms。按 `write` 回调完成顺序串行发送，单帧持续失败后停止队列并只报告一次故障。会话结束、组件卸载或主动关闭会取消剩余等待与重试；已发出的 IPC 的晚到结果仍被接收处理，避免未捕获的异步拒绝。

ACK 无法恢复时，界面停止该终端输入、保留明确错误状态并请求关闭所属会话。Rust 向前端发送事件失败时也有独立清理路径：不可送达的认证提示取消等待，已注册的会话只触发一次关闭。远程关闭取消该会话的传输、监控和隧道后断开 SSH；本地关闭终止所属 PTY。其它主机和本地终端不参与这次清理。

每条自动重连链由源会话持有一个 `AbortController`。用户手动关闭源会话时，先标记 `closing`、中止对应 `AbortSignal` 并清除重连计时器；每次重连尝试及计时回调执行前检查取消状态，主机指纹探测、凭据检查、SSH 连接等异步步骤返回后再次检查。取消也会移除这次重连的认证请求，并以空响应结束仍在等待的认证交互。

这个前端取消信号不会直接撤回已发出的原生 SSH 连接调用；如果调用在取消后返回新会话 ID，界面会立即请求关闭该晚到会话。关闭成功后丢弃它的终端和状态缓存，不把它作为成功连接加入工作台。若关闭失败，则保留可操作的错误标签页，显示具体错误并禁止该会话再次自动重连，供用户重试关闭。源会话的关闭 IPC 若失败，也保留可见错误状态而非假报已关闭。

自动重连始终建立新 SSH 会话，不能恢复普通 shell 中已中断的远程进程；是否保留远程任务取决于服务器及 tmux 等工具。应用退出时也会中止所有自动重连链与计时器。

`apps/desktop/tests/terminal-ack.spec.ts` 已随本次界面作业执行并通过，包含在上文 2 项 Playwright 测试内。桌面 Rust 的 `terminal_delivery_tests` 在 Linux 作业中实测 2 项通过、0 失败、0 忽略，耗时 0.01 秒：认证事件早期传递失败后取消认证并仅关闭一次已注册会话，以及原生通道失败只关闭其所属本地 PTY。这两项计入上文 30 项总数。

## 后续工作方法

先核对远端 HEAD 和实际工作流结果，读取本文件及 STATUS，保留所有现有用户更改。修改对应模块并选择相关行为验证，避免无关测试。不要为了 CI 通过而关闭指纹校验、吞掉权限错误、删除目标文件模拟原子保存，或在浏览器预览伪造远程操作成功。

认证输入不得日志化；密钥和证书不得入库。应用配置与凭据变更必须经过现有串行化和恢复路径。后续配置迁移继续使用版本表。

## 明确未承诺

自动更新尚需真实发行公钥/HTTPS 清单/签名包，开发者证书与公证需要发行者身份材料。队列跨应用重启续传、ACL/xattrs 复制、全部 OpenSSH 配置语法、代理认证、远程文件自动 sudo 和 MCP 集成不属于本版已经通过验收的能力。


## v0.3.0 增量交接（2026-11-24）

源提交 `a247fc10f27466c781d8f9ed335e0063ecc62051`；功能 PR [#2](https://github.com/xzcode/shell-ex/pull/2) 已合并，核心、UI 与原生检查通过；三平台打包成功，见 [构建状态](RELEASE.md#v030-当前构建与发布状态2026-11-24)。

本地密码库：`crates/shell-ex-core/src/local_vault.rs` 实现 Argon2id/AES-256-GCM，`credentials.sqlite3` 在 Tauri app_data_dir。按主机选择 `local/system/session`，旧数据缺省 `system`；前端 `HostDialog.tsx` 合并认证页，`VaultDialog.tsx` 提供主密码生命周期，`SettingsDialog.tsx` 可锁定、解锁及换密码，`App.tsx` 连接前按需提示解锁。安全边界见 [安全说明](SECURITY.md)。

请不要把本版构建草稿标记成正式 Release；GitHub Actions 发布作业在 Runner 分配前失败，尚未创建 `v0.3.0` 标签，详情与三平台校验值见发行说明。已存在 `release/v0.3.0` 发布工作流，可在 Actions 服务恢复后重试，也可通过 GitHub UI 发布当前草稿。
