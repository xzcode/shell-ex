# 安全与数据约定

## 主机身份

首次 SSH 探测拒绝公钥继续认证，只获取算法和 SHA-256。用户通过可信渠道核对后建立应用信任；变化时自动连接被阻断。正式连接独立比对同一指纹后才发送认证信息。信任按地址、端口和算法绑定，复制主机配置不绕过身份验证。

Shell EX 的信任记录在应用数据库中，不会自动修改系统 `known_hosts`。本版不实现 OpenSSH CA 信任策略或自动信任新算法。

## 凭据生命周期

数据库、主机导入和浏览器预览不保存密码/私钥口令。用户输入会短暂存在于表单与 IPC 内存，提交/取消/失败后 UI 清空；Rust SecretInput 和备份明文/派生密钥采用尽力清零。不能承诺浏览器、系统库或 SSH 库所有内部副本都可被确定性清除。

新连接默认将凭据写入内置 AES-256-GCM 加密数据库，不在主机配置中保存明文；旧版连接继续使用原来指定的系统或本地加密库。私钥由 Rust 从本机路径读取或通过 Agent 签名，私钥内容不会返回前端。不得把密码、私钥、令牌、签名证书加入仓库或测试截图。

终端的远程输出本身可能包含用户执行命令产生的秘密；应用只在界面与有界 scrollback 中保留，不默认持久化完整输入输出。

## 传输与编辑

目标覆盖必须显式选择。只编辑普通 UTF-8 文本，符号链接需要打开清晰显示的实际目标。文件版本含内容摘要与元数据。保存尽量保持权限和所有者；不复制 ACL/xattrs，管理员配置可能需要终端内的专门工作流。

SFTP 无通用跨进程写锁或 compare-and-swap，本版只能核验写前与发布前状态，无法消除最终重命名瞬间的外部竞争。对此保持明确边界。

目录复制不跟随符号链接或 Windows reparse point。目录计划有上限与有效期，源变化时重新规划；空目录可创建，部分失败不回滚已成功传输的独立文件。

新文件下载采用避免覆盖的发布方式；文件系统不支持相应原子操作时失败并说明暂存位置。不能在网络磁盘/FAT 等环境中无条件承诺相同语义。

## 本地与远程操作

本地终端仅执行当前用户的 shell。SSH、Docker、进程管理不默认 sudo，不打开公网转发监听。进程操作校验 PID 和信号；Docker 动作使用固定枚举，不拼接任意动作字符串。

从远程终端请求剪贴板的 OSC 52 默认阻断。多行粘贴默认确认，允许用户自行修改设置。远程终端文本以终端解析器处理，不插入 HTML。

## 备份格式

`SHEX` 版本化头部 + 16 字节盐 + 12 字节随机 nonce + AES-256-GCM 密文与认证标签。固定 Argon2id 参数：64 MiB、3 次、单并行度，派生 32 字节密钥。头部作为附加认证数据。读取最多 32 MiB，禁止由文件内容任意指定 KDF 资源消耗。

口令至少 12 字符。默认不含凭据；显式勾选后才包含系统凭据库数据。私钥文件不打包。导入采用合并配置，主机信任记录不从备份恢复，需要重新核验。校验所有导入配置后才开始写凭据，失败时尝试恢复并明确报告恢复失败。

## 更新与发行

更新必须使用内置可信公钥验证下载包签名，并要求签名版本匹配清单。HTTPS 地址和签名信任根都未配置时完全关闭更新。开发者证书/公证与 updater 签名是两套独立机制。

维护者收到安全问题时应使用私密渠道核对最小复现，不要求用户上传真实私钥或全部服务器配置。先修复实际问题，再按影响范围验证。


## v0.3.0 应用内本地加密密码库

新增独立的 `credentials.sqlite3`，保存在 Tauri `app_data_dir`。新连接默认选择应用内密码库；旧连接的 `credentialStore` 缺省为 `system`，不自动迁移已有 Keychain 条目。

使用随机 16 字节盐、Argon2id（64 MiB/3 轮/1 线程）派生 256 位主密钥，以随机 96 位 nonce、AES-256-GCM、主机 UUID 作为认证附加数据加密每条凭据。没有主密码时不能从持久化密文恢复 SSH 密码；主密码及派生密钥不写入磁盘。手动锁定和应用退出会清除内存中的派生密钥；强制终止进程时操作系统回收内存。Unix 系统设置应用目录 0700、凭据文件 0600（Windows 依赖用户目录 ACL）。

主密码遗忘不可恢复；旧系统凭据库数据保持原有存储模式。切换模式时先保存目标密文、确认配置持久化，再尝试删除旧项。若旧 Keychain 无法访问但用户已明确提供新的本地密码，旧项可能残留，界面会提示用户手工清除。

备份包含凭据时应在密码库解锁后执行，加密备份不可替代主密码管理；避免将含凭据的备份上传公开位置。


## v0.3.1 免主密码自动加密模式

新连接默认 `credentialStore=auto`。这与 v0.3.0 引入的 `local`（Argon2id 主密码派生）是**两个不同的凭据仓库**，升级不覆盖旧密码库。

自动模式首次启动时在本机应用数据目录生成随机 256 位密钥 `auto-vault.key`，使用 AES-256-GCM 将每台主机的密码/私钥口令加密存入 `auto-vault.sqlite3`。每条记录具有独立随机 nonce，并把主机 UUID 加入 AAD，防止替换密文绕过认证。Unix 上目录与文件权限分别收紧为 0700、0600，Windows 依赖本机用户权限。

这不是硬编码所有用户共享的密钥，但**也不是独立主密码的保护等级**：拥有当前用户应用数据目录读权限的人可能同时取得密钥与密文。应依赖系统账户隔离与全盘加密，并避免直接分享整个应用数据目录。带凭据的安全迁移应使用原有加密备份导出功能，且妥善保管备份口令。


## v0.3.2 内置统一离线加密

新建 SSH 连接默认 `credentialStore=builtin`，使用内置、跨安装稳定的 AES-256-GCM 加密密钥，保存在应用代码中。每条记录仍以 CSPRNG 产生 12 字节 nonce，使用主机 UUID 作为认证附加数据，密文保存在应用数据目录的 `builtin-vault.sqlite3`。**不要求用户设置主密码、不创建或读取单独的密钥文件**。

必须明确安全边界：密钥随程序发布，可被提取；任何有软件程序和密文数据库的人都可能解密。此方案用于离线自用场景、减少明文暴露，而不抵御能分析程序或窃取本机文件的攻击者。推荐由用户自行保护登录账户与磁盘。

旧 `credentialStore=auto` 对应的 `auto-vault.sqlite3 + auto-vault.key` 在存在时才打开，保持原有加密方式、原始文件及读取路径，不创建新的旧版密钥文件。旧 `local` 主密码加密库及 `system` 系统凭据库继续兼容。没有被用户要求切换保存位置时，不强行迁移旧凭据或删除密码文件。

## v0.4.1 — no operating-system credential store

Shell EX no longer links or calls the keyring crate. Legacy host JSON records that omit credentialStore or specify system are interpreted as builtin, including older encrypted backups. Existing host IDs, settings, trust records and application vault data are preserved; the old operating-system entries are neither read nor deleted. A password present only in an OS vault must be entered again. On a successful connection with a newly entered password or key passphrase, the default builtin option saves it locally unless the user unchecks the save control. If saving fails, the authenticated session remains available and a separate error is shown. Session-only connections are never persisted; legacy local/auto vaults retain their original formats. Explicit SSH Agent use remains separate from Shell EX password storage and may invoke platform-dependent agent behavior.

The shared built-in AES key is not a substitute for disk encryption or access controls. The OS/WebView and third-party authentication may independently display security prompts; native macOS launch behavior requires real-device verification.
