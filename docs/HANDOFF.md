# Shell EX 开发交接

## 当前任务与决策

用户已选择完整 FinalShell 替代品方向，并授权直接完成 M0–M5。仓库 `xzcode/shell-ex`，默认 master。当前实现版本 0.1.0；首发 macOS Apple Silicon，三平台构建。界面使用专业深浅主题、长方形按钮，代码和用户数据均不依赖云账号。

## 代码入口

| 入口 | 职责 |
| --- | --- |
| apps/desktop/src/App.tsx | 会话、主机、布局、认证交互 |
| apps/desktop/src/TerminalView.tsx | xterm 输出、ACK、尺寸、搜索、剪贴板 |
| apps/desktop/src/FilePanel.tsx / RemoteEditor.tsx | 文件操作与草稿 |
| apps/desktop/src/OperationsPanels.tsx | 传输、命令、隧道、容器 |
| apps/desktop/src-tauri/src/lib.rs | IPC、配置/凭据事务协调、生命周期 |
| crates/shell-ex-core/src/ssh.rs / pty.rs / tunnels.rs | 连接、终端、转发 |
| crates/shell-ex-core/src/files.rs / transfers.rs | 文件完整性与队列 |
| crates/shell-ex-core/src/storage.rs / credentials.rs / backup.rs | 数据、信任、系统凭据与备份 |
| crates/shell-ex-core/src/import.rs | 保守的 SSH config 导入 |
| crates/shell-ex-core/src/monitor.rs / docker.rs | 受控运维操作 |

## 已验证和待验证

见 [状态表](milestones/STATUS.md)、[SSH 证据](milestones/SSH_EVIDENCE.md)、[文件证据](milestones/FILE_TRANSFER_EVIDENCE.md)。以实际结果为准，不能从某个模块编译通过推断三个系统全部实机通过。

本地沙箱限制 Unix socket，不能启动 Chromium 或 SSH Agent；非 root OpenSSH 不能写登录记录。已分别用真实本地 PTY、受控 SSH 认证/PTY 协议、真实 OpenSSH service/SFTP/转发测试覆盖，完整 OpenSSH PTY、Agent 与浏览器截图由 CI/对应系统补充。

## 后续工作方法

先核对远端 HEAD 和实际工作流结果，读取本文件及 STATUS，保留所有现有用户更改。修改对应模块并选择相关行为验证，避免无关测试。不要为了 CI 通过而关闭指纹校验、吞掉权限错误、删除目标文件模拟原子保存，或在浏览器预览伪造远程操作成功。

认证输入不得日志化；密钥和证书不得入库。应用配置与凭据变更必须经过现有串行化和恢复路径。后续配置迁移继续使用版本表。

## 明确未承诺

自动更新尚需真实发行公钥/HTTPS 清单/签名包，开发者证书与公证需要发行者身份材料。队列跨应用重启续传、ACL/xattrs 复制、全部 OpenSSH 配置语法、代理认证、远程文件自动 sudo 和 MCP 集成不属于本版已经通过验收的能力。
