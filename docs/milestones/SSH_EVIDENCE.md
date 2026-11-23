# SSH、终端与网络功能验证记录

日期：2026-11-23。本文记录此次本地构建和有针对性的验证结果；不把尚未执行的真实平台验收标为通过。

## 已实现的接口与行为

- `SshManager` 使用 Russh 0.65.4 建立真实 SSH 连接。密码、私钥、SSH Agent、交互式认证分别处理；主机密钥校验发生在认证之前。
- `probe` 在取得服务端公钥指纹后拒绝继续握手，不发送用户名密码；`connect` 独立复核已信任的 SHA256 指纹，防止探测和连接之间身份变化。
- `connect`/`connect_via` 创建交互式 PTY 与 shell；`connect_service`/`connect_service_via` 只创建已认证传输，用于跳板与文件服务，不创建或模拟终端。
- 交互式认证通过结构化事件通知前端，支持多字段、是否显示输入、最多八轮、每次回答超时。取消会使认证失败，不复用密码回答任意提示。
- 终端输入、输出均为字节流。输出按最多 16 KiB 分帧，最多保留 32 个未确认帧，前端在 xterm 消费数据后返回对应序号；持续输出受到背压限制。
- `exec` 通过独立 SSH channel 执行，分别保留 stdout/stderr/退出码；响应最多 2 MiB，执行期限 30 秒，适用于受控监控与管理命令。
- SFTP 按连接延迟初始化独立 subsystem；原始 SFTP 接口允许文件模块协商安全重命名扩展。
- 本地终端使用 portable-pty 的真实系统 PTY，支持输入、窗口尺寸变化、退出和关闭。
- 本地转发、远程转发、SOCKS5 动态转发有独立生命周期；监听限定在回环地址，每个监听最多 64 个并发转发连接，应用最多 32 条隧道。
- 支持通过不带认证的 SOCKS5 或 HTTP CONNECT 代理连接 SSH；跳板链通过已认证连接的 direct-tcpip channel 承载。

## 已通过的本地验证

### 核心编译与本地 PTY

执行 `cargo check -p shell-ex-core` 通过。

`pty::tests::local_shell_has_a_real_resizable_pty` 启动真实本地 shell，调整至 111 列、37 行，执行 `stty size` 并校验实际结果及输出标记，随后关闭进程。通过。

`ssh::tests::terminal_acknowledgement_bounds_the_output_queue` 验证发送 32 帧后停止接受额外输出、确认一帧后继续、取消后立即结束等待。通过。

`ssh::tests::shell_arguments_and_proxy_authorities_cannot_inject_commands` 和 `tunnels::tests::loopback_listeners_do_not_expose_forwarding_to_the_network` 验证路径引号、非法代理地址和监听地址约束。通过。

### 认证与终端协议

执行：

```sh
cargo test -p shell-ex-core --test auth_protocol
```

结果：1 项通过，运行约 0.30 秒（不含编译）。

测试使用进程内 SSH 服务端，其终端明确实现为测试用的字节回显器，验证：

1. 错误主机指纹被拒绝，服务端认证回调次数保持为零。
2. 正确密码通过，错误密码拒绝。
3. 交互式认证分别处理隐藏输入和可见输入，并正确接收两项回答。
4. 客户端正确发送 PTY、shell、窗口变化请求。
5. ANSI 控制序列与中文 UTF-8 原始字节往返保持一致。

这项协议测试不代表真实 OpenSSH 上 `vim`、`tmux` 等程序已完成验收。

### 真实 OpenSSH 的 SSH、跳板、代理与隧道

执行：

```sh
python3 scripts/ssh_fixture.py cargo test -p shell-ex-core \
  --test ssh_integration -- --ignored --test-threads=1
```

结果：2 项通过，运行约 0.97 秒（不含编译）。

夹具仅在 127.0.0.1 的临时端口运行 OpenSSH，生成临时服务端密钥和客户端密钥，授权文件仅位于临时目录。不会改动现有 `authorized_keys`、`known_hosts` 或系统 SSH 服务。测试结束后关闭夹具并删除临时密钥。

实际验证包括：

- Ed25519 密钥认证、错误指纹拒绝、独立命令的 stdout/stderr/非零退出码。
- 通过已有 SSH 会话探测并连接下一跳主机。
- 本地转发、远程转发与 SOCKS5 动态转发的真实 TCP 数据往返。
- 停止本地转发后监听端口关闭。
- SOCKS5 与 HTTP CONNECT 代理下建立 SSH 连接并执行命令。

## 当前环境限制与 CI 补充入口

本地测试容器的非 root OpenSSH 无法写系统登录记录，真实远程 PTY 请求会触发服务端的 `Attempt to write login records by non-root user`。因此上述本地 OpenSSH 测试使用服务型连接，明确没有执行真实 OpenSSH PTY 分支。

本地容器禁止 Unix 域套接字，临时 `ssh-agent` 启动失败并报告 `Operation not permitted`。因此 SSH Agent 登录分支在此次本地执行中明确排除；接口已编译，但没有据此声称 Agent 登录实际通过。

CI 为此设置以下入口：

```sh
sudo mkdir -p /run/sshd
SHELL_EX_TEST_SSHD_SUDO=1 python3 scripts/ssh_fixture.py \
  cargo test --locked -p shell-ex-core \
  --test ssh_integration --test files_integration -- \
  --ignored --test-threads=1
```

`SHELL_EX_TEST_SSHD_SUDO=1` 仅使隔离夹具的 OpenSSH 通过 `sudo -n` 启动，测试命令保持当前用户执行。成功进入该模式后夹具启用真实 PTY 分支；SSH Agent 在能启动私人测试套接字的环境中启用。只有取得 CI 的实际成功记录后，才能将这两项记为通过。

macOS 原生 Keychain、Windows OpenSSH Agent、真实服务器上的全屏交互程序、休眠唤醒后的网络恢复仍需要对应平台的验证。Mac 安装包签名与公证属于发布验证，不由上述核心测试替代。

## OpenSSH 配置导入的修复与边界

`cargo test -p shell-ex-core import::tests` 的 5 项有针对性测试通过，覆盖带等号的标准语法、带空格和 Windows 分隔符的密钥路径、重复 Host 块的首值语义、代理选项优先级，以及不能解析的代理/跳板和依赖它们的主机排除。

导入器处理明确的 Host 别名，不执行 `ProxyCommand`、`LocalCommand`、`RemoteCommand` 或 `Include`。遇到未展开的全局/条件路由或 Include 时，返回警告且不自动导入任何主机，避免将原本需要代理的连接悄悄变为直连。复杂配置应先展开为具体主机再导入。
