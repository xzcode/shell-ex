# Docker 真实集成验收

日期：2026-11-23。

测试文件：`crates/shell-ex-core/tests/docker_integration.rs`。

## 当前证据状态

- 已实现真实 Docker 集成测试，调用现有 `DockerService`，经回环 OpenSSH 连接访问 Docker CLI；没有模拟 Docker 输出。
- 测试默认忽略，且需要显式设置 `SHELL_EX_TEST_DOCKER=1`。
- 本地开发容器没有 Docker CLI/daemon，因此这里只完成测试编译；不能把编译通过当作 Docker 生命周期实测通过。
- CI 实测结果以 GitHub Actions 对应提交的日志为准。成功日志必须同时包含 `Validated through SSH` 与 `Confirmed exact owned Docker container removed`，并且测试实际启用了开关；`SKIP Docker lifecycle` 不属于实测证据。

## CI 准备及执行

在具备 Docker 和 OpenSSH 的临时 GitHub Ubuntu Runner 上执行。SSH fixture 的用户需要能访问该 Runner 的本地 Docker Unix socket。

```sh
docker pull busybox:1.37.0
SHELL_EX_TEST_DOCKER=1 SHELL_EX_TEST_SSHD_SUDO=1 \
  python3 scripts/ssh_fixture.py \
  cargo test -p shell-ex-core --test docker_integration --locked -- \
  --ignored --test-threads=1 --nocapture
```

`busybox:1.37.0` 已核对为 [Docker Official Image 支持的版本标签](https://github.com/docker-library/official-images/blob/master/library/busybox)。测试固定使用该版本标签，要求 CI 预先拉取，并通过 `--pull=never` 禁止测试过程隐式拉取其它镜像；标签不等同于不可变 digest 固定。

## 验收内容

| 验证 | 成功条件 |
| --- | --- |
| 镜像列表 | 能从真实 JSON 中找到 `busybox:1.37.0`，正确解析完整 ID、大小、创建时间 |
| 容器列表 | 根据本次创建的完整 ID 找到唯一容器，名称匹配，最初状态为 `created` |
| 启动 | 调用 `DockerService::action(start)` 后真实状态为 `running` |
| 日志 | stdout 与 stderr 两个标记均能通过 `DockerService::logs` 取得 |
| 停止 | 调用 stop 后真实状态为 `exited` |
| 再次启动 | 状态再次变为 `running` |
| 重启 | 状态为 `running`，并独立检查 `.State.StartedAt` 已改变，避免只检查命令返回值 |
| 清理 | 重新核对本次 UUID 标签，仅删除完整 ID 对应的容器，随后确认该 ID 不在列表中 |

## 隔离范围

- SSH 地址只允许 fixture 的回环地址；Docker context 和 `DOCKER_HOST` 必须指向本地 Unix socket。
- 容器名为 `shell-ex-ci-<随机 UUID>`，附带相同 UUID 的所有权标签。
- 容器没有端口发布、宿主目录挂载或网络连接；根文件系统只读，移除 capabilities，并设置 no-new-privileges、进程、内存与 CPU 上限。
- 容器只打印两个标记后休眠，最长 300 秒；停止等待上限 2 秒。
- 断言失败通过异步 panic 捕获仍会尝试清理这个确切 ID。测试不执行 prune、不删除镜像、不批量停止容器，也不按模糊名称清理其它资源。
- Runner 被强制终止时依赖临时 Runner 回收；不声称能在进程被强杀后继续执行清理。
