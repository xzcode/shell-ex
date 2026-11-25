// Offline bilingual Linux command reference. Examples are documentation only.
export type LocalizedHelp = readonly [zh: string, en: string];
export const commandCategories = [
  [
    "files",
    "文件与目录",
    "Files & directories"
  ],
  [
    "text",
    "文本与日志",
    "Text & logs"
  ],
  [
    "system",
    "系统与磁盘",
    "System & disks"
  ],
  [
    "process",
    "进程管理",
    "Processes"
  ],
  [
    "network",
    "网络排查",
    "Networking"
  ],
  [
    "services",
    "服务与定时任务",
    "Services & scheduling"
  ],
  [
    "permissions",
    "用户与权限",
    "Users & permissions"
  ],
  [
    "archive",
    "压缩与校验",
    "Archives & checksums"
  ],
  [
    "packages",
    "软件包管理",
    "Package management"
  ],
  [
    "containers",
    "Docker 容器",
    "Docker containers"
  ],
  [
    "remote",
    "SSH 与会话",
    "SSH & sessions"
  ]
] as const;
export type CommandCategory = (typeof commandCategories)[number][0];
export type CommandHelpEntry = {
  category: CommandCategory;
  name: string;
  description: LocalizedHelp;
  options: LocalizedHelp;
  example: string;
  exampleNote: LocalizedHelp;
  warning?: LocalizedHelp;
};
export const linuxCommands: readonly CommandHelpEntry[] = [
  {"category":"files","name":"pwd","description":["显示当前工作目录。","Print the current working directory."],"options":["-P 显示解析符号链接后的真实路径。","-P resolves symbolic links."],"example":"pwd","exampleNote":["显示当前路径。","Show the current path."]},
  {"category":"files","name":"ls","description":["列出目录内容及文件属性。","List directory contents and file attributes."],"options":["-l 详细列表；-a 包含隐藏文件；-h 以易读单位显示大小；-t 按修改时间排序。","-l long listing; -a hidden files; -h human-readable sizes; -t modification time."],"example":"ls -lah /var/log","exampleNote":["查看日志目录的全部文件。","List all files in the log directory."]},
  {"category":"files","name":"cd","description":["切换 Shell 的当前工作目录。","Change the shell's working directory."],"options":[".. 上一级；~ 用户主目录；- 上次目录。",".. parent; ~ home; - previous directory."],"example":"cd /var/log","exampleNote":["进入系统日志目录。","Enter the system log directory."]},
  {"category":"files","name":"mkdir","description":["创建目录。","Create directories."],"options":["-p 创建缺失的父目录；-m 指定权限。","-p creates missing parents; -m sets mode."],"example":"mkdir -p ./demo/logs","exampleNote":["创建示例目录及其父目录。","Create the example directory and parents."]},
  {"category":"files","name":"touch","description":["创建空文件，或更新已有文件的时间戳。","Create an empty file or update timestamps."],"options":["-c 不创建新文件；-t 指定时间。","-c do not create; -t set a timestamp."],"example":"touch ./example.txt","exampleNote":["创建示例文件（存在时更新时间）。","Create an example file, or update its timestamp."]},
  {"category":"files","name":"cp","description":["复制文件或目录。","Copy files or directories."],"options":["-a 保留常用属性并递归复制；-i 覆盖前询问；-r 递归复制。","-a archive copy; -i prompt before overwrite; -r recursive."],"example":"cp -i ./example.txt ./backup.txt","exampleNote":["复制文件，遇到同名目标先询问。","Copy a file, prompting before overwrite."],"warning":["核对目标路径，避免误覆盖。","Check the destination to avoid overwriting important files."]},
  {"category":"files","name":"mv","description":["移动或重命名文件、目录。","Move or rename files and directories."],"options":["-i 覆盖前询问；-n 不覆盖已有文件。","-i prompt before overwrite; -n do not overwrite."],"example":"mv -i ./old.txt ./new.txt","exampleNote":["重命名示例文件。","Rename an example file."],"warning":["移动或覆盖会改变源、目标状态。","Moving or overwriting changes the source or destination."]},
  {"category":"files","name":"rm","description":["删除文件或目录。","Remove files or directories."],"options":["-i 删除前询问；-r 递归删除；-f 强制且不询问。","-i prompt; -r recursive; -f force without prompting."],"example":"rm -i ./example.txt","exampleNote":["删除指定示例文件，并先询问。","Prompt before deleting the example file."],"warning":["删除通常无法撤销；不要对未经核对的路径使用 -rf。","Deletion is usually irreversible; do not use -rf on unverified paths."]},
  {"category":"files","name":"find","description":["按名称、类型、时间等条件查找文件。","Find files by name, type, time, or other conditions."],"options":["-type f 普通文件；-type d 目录；-name 名称模式；-mtime 修改天数。","-type f files; -type d directories; -name pattern; -mtime modification age."],"example":"find . -type f -name '*.log'","exampleNote":["在当前目录树查找日志文件。","Find log files below the current directory."]},
  {"category":"files","name":"stat","description":["查看文件大小、权限、时间戳等元数据。","Display file metadata such as size, permissions and timestamps."],"options":["-c 自定义输出格式（GNU stat）。","-c custom output format (GNU stat)."],"example":"stat ./example.txt","exampleNote":["查看指定文件的详细属性。","Inspect an example file's attributes."]},
  {"category":"files","name":"ln","description":["创建硬链接或符号链接。","Create hard links or symbolic links."],"options":["-s 创建符号链接；-i 覆盖前询问。","-s symbolic link; -i prompt before overwrite."],"example":"ln -s ./example.txt ./example-link","exampleNote":["创建指向示例文件的符号链接。","Create a symbolic link to the example file."]},
  {"category":"text","name":"cat","description":["输出文本文件内容。","Print text file contents."],"options":["-n 显示行号；-b 为非空行编号。","-n number all lines; -b number nonblank lines."],"example":"cat -n ./app.log","exampleNote":["带行号查看示例日志。","Display an example log with line numbers."]},
  {"category":"text","name":"less","description":["分页查看较长的文本文件。","Page through a long text file."],"options":["-N 显示行号；/ 搜索；n 下一处；q 退出。","-N line numbers; / search; n next match; q quit."],"example":"less -N ./app.log","exampleNote":["分页阅读日志。","Read a log one page at a time."]},
  {"category":"text","name":"head","description":["查看文件开头。","Show the beginning of a file."],"options":["-n 指定行数；-c 指定字节数。","-n number of lines; -c number of bytes."],"example":"head -n 20 ./app.log","exampleNote":["显示前 20 行。","Show the first 20 lines."]},
  {"category":"text","name":"tail","description":["查看文件末尾，可持续追踪追加内容。","Show the end of a file and follow appended output."],"options":["-n 指定行数；-f 追踪追加；-F 按文件名重试跟踪。","-n lines; -f follow; -F follow by name and retry."],"example":"tail -n 100 -f ./app.log","exampleNote":["查看最后 100 行并持续追踪；Ctrl+C 停止。","Show the last 100 lines and follow; Ctrl+C stops."]},
  {"category":"text","name":"grep","description":["按字符串或正则表达式搜索文本。","Search text by strings or regular expressions."],"options":["-i 忽略大小写；-n 行号；-E 扩展正则；-r 递归搜索。","-i ignore case; -n line numbers; -E extended regex; -r recursive."],"example":"grep -nEi 'error|warn' ./app.log","exampleNote":["查找错误和警告并显示行号。","Find errors and warnings with line numbers."]},
  {"category":"text","name":"awk","description":["按字段处理结构化文本。","Process structured text by fields."],"options":["-F 指定分隔符；$1 第一列；$NF 最后一列。","-F field separator; $1 first field; $NF last field."],"example":"awk '{print $1}' ./app.log","exampleNote":["输出每行的第一列。","Print the first field of each line."]},
  {"category":"text","name":"sed","description":["按行筛选或转换文本。","Filter or transform text line by line."],"options":["-n 关闭默认输出；p 打印；s/旧/新/ 替换；-i 原地编辑。","-n suppress default output; p print; s/old/new/ substitute; -i edit in place."],"example":"sed -n '1,20p' ./app.log","exampleNote":["只显示前 20 行，不修改文件。","Print the first 20 lines without editing."],"warning":["-i 会修改文件，先备份并验证规则。","-i modifies files; back up and verify the expression first."]},
  {"category":"text","name":"sort","description":["对文本行排序。","Sort lines of text."],"options":["-n 数值排序；-r 逆序；-u 去重。","-n numeric; -r reverse; -u unique."],"example":"sort -u ./names.txt","exampleNote":["排序并去除重复行，输出到终端。","Sort unique lines and print them."]},
  {"category":"text","name":"wc","description":["统计行数、单词数或字节数。","Count lines, words or bytes."],"options":["-l 行数；-w 单词数；-c 字节数。","-l lines; -w words; -c bytes."],"example":"wc -l ./app.log","exampleNote":["统计日志中的换行数。","Count newline characters in the log."]},
  {"category":"text","name":"cut","description":["按列或指定分隔符提取内容。","Extract selected characters or delimited fields."],"options":["-d 分隔符；-f 字段编号；-c 字符位置。","-d delimiter; -f fields; -c character positions."],"example":"cut -d: -f1 /etc/passwd","exampleNote":["查看本机账号名称列表。","List local account names."]},
  {"category":"text","name":"diff","description":["比较两个文本文件的差异。","Compare two text files."],"options":["-u 统一差异格式；-r 递归比较目录。","-u unified diff; -r recursive directory comparison."],"example":"diff -u ./old.conf ./new.conf","exampleNote":["查看两份配置的差异。","Compare two configuration files."]},
  {"category":"system","name":"df","description":["查看文件系统的总容量和可用空间。","Report filesystem capacity and free space."],"options":["-h 易读单位；-T 文件系统类型；-i inode 使用量。","-h human-readable; -T filesystem type; -i inode usage."],"example":"df -hT","exampleNote":["查看所有已挂载文件系统的容量。","Inspect mounted filesystem usage."]},
  {"category":"system","name":"du","description":["统计文件或目录的磁盘占用。","Estimate disk usage of files and directories."],"options":["-s 汇总；-h 易读单位；--max-depth=1 查看一级子目录（GNU）。","-s summarize; -h human-readable; --max-depth=1 first-level totals (GNU)."],"example":"du -sh ./logs","exampleNote":["查看日志目录占用空间。","Check the log directory's disk usage."]},
  {"category":"system","name":"lsblk","description":["列出块设备、分区和挂载信息。","List block devices, partitions and mount information."],"options":["-f 文件系统信息；-o 指定列。","-f filesystem details; -o select columns."],"example":"lsblk -f","exampleNote":["查看磁盘、分区及文件系统。","Inspect disks, partitions and filesystems."]},
  {"category":"system","name":"free","description":["查看内存及交换分区使用情况。","Display memory and swap usage."],"options":["-h 易读单位；-m MiB；-s 指定刷新间隔。","-h human-readable; -m MiB; -s repeat interval."],"example":"free -h","exampleNote":["查看可用内存（available）和 Swap。","Check available memory and swap."]},
  {"category":"system","name":"uptime","description":["查看系统运行时长、登录人数及负载。","Show uptime, logged-in users and load averages."],"options":["-p 易读运行时长；-s 启动时间。","-p pretty uptime; -s boot time."],"example":"uptime","exampleNote":["查看当前 1、5、15 分钟负载。","Inspect 1-, 5- and 15-minute load averages."]},
  {"category":"system","name":"uname","description":["查看内核及系统架构信息。","Display kernel and architecture information."],"options":["-a 全部常用信息；-r 内核版本；-m 机器架构。","-a all common information; -r kernel release; -m machine architecture."],"example":"uname -a","exampleNote":["查看 Linux 内核和架构。","Inspect kernel and architecture."]},
  {"category":"system","name":"lscpu","description":["查看 CPU 架构、核心及线程信息。","Display CPU architecture and topology."],"options":["-e 扩展 CPU 列表；-J JSON 输出（支持时）。","-e extended CPU list; -J JSON output when supported."],"example":"lscpu","exampleNote":["查看 CPU 配置。","Inspect CPU configuration."]},
  {"category":"system","name":"vmstat","description":["采样进程、内存、I/O 及 CPU 状态。","Sample processes, memory, I/O and CPU activity."],"options":["delay count：刷新间隔和采样次数。","delay count: sampling interval and count."],"example":"vmstat 1 5","exampleNote":["每秒采样，输出 5 次。","Sample once per second, five times."]},
  {"category":"system","name":"iostat","description":["查看 CPU 和磁盘 I/O 统计。","Display CPU and device I/O statistics."],"options":["-x 扩展设备指标；-z 隐藏无活动设备；需 sysstat 软件包。","-x extended statistics; -z omit inactive devices; requires sysstat."],"example":"iostat -xz 1 3","exampleNote":["查看 3 次磁盘 I/O 统计。","Inspect three I/O reports."]},
  {"category":"process","name":"ps","description":["查看进程快照。","Show a snapshot of running processes."],"options":["aux 使用 BSD 风格列出所有用户进程；-ef 使用完整格式。","aux BSD-style all-user listing; -ef full-format listing."],"example":"ps aux --sort=-%cpu","exampleNote":["按 CPU 使用率降序查看进程（procps）。","List processes sorted by CPU usage (procps)."]},
  {"category":"process","name":"top","description":["实时查看进程及资源使用情况。","Monitor processes and resource usage live."],"options":["-p 指定 PID；-b 批处理模式；q 退出。","-p select PID; -b batch mode; q quit."],"example":"top","exampleNote":["实时查看系统及进程负载。","Monitor live system and process activity."]},
  {"category":"process","name":"pgrep","description":["按进程名称或条件查找 PID。","Find process IDs by name or criteria."],"options":["-a 同时显示命令行；-f 匹配完整命令行；-x 精确匹配名称。","-a include command line; -f match full command line; -x exact name."],"example":"pgrep -a nginx","exampleNote":["查找 nginx 进程及命令行。","Find nginx processes and command lines."]},
  {"category":"process","name":"kill","description":["向进程发送信号。","Send a signal to a process."],"options":["-TERM 请求正常终止；-KILL 强制终止；-l 列出信号。","-TERM request termination; -KILL force termination; -l list signals."],"example":"kill -TERM 12345","exampleNote":["向示例 PID 发送 TERM 信号。","Send TERM to an example PID."],"warning":["先用 ps 核对真实 PID；终止进程可能影响服务。","Verify the real PID with ps; termination may disrupt services."]},
  {"category":"process","name":"jobs","description":["查看当前 Shell 的后台作业。","List jobs managed by the current shell."],"options":["-l 显示 PID；-p 仅显示 PID。","-l include PIDs; -p PIDs only."],"example":"jobs -l","exampleNote":["查看当前 Shell 的作业列表。","List jobs in the current shell."]},
  {"category":"process","name":"nohup","description":["让命令忽略挂断信号，配合后台运行。","Run a command ignoring hangup signals, often in the background."],"options":["& 放到后台；> 重定向标准输出；2>&1 合并标准错误。","& background; > redirect stdout; 2>&1 merge stderr."],"example":"nohup ./job.sh > ./job.log 2>&1 &","exampleNote":["后台启动示例脚本并记录输出。","Start an example script in the background and log output."],"warning":["会启动真实程序且 > 会截断已有日志；先检查脚本和路径。","Starts a real program; > truncates an existing log. Check the script and path."]},
  {"category":"process","name":"lsof","description":["查看进程打开的文件及套接字。","List open files and sockets."],"options":["-p PID；-i 网络连接；-nP 不解析主机名及端口名称。","-p PID; -i network connections; -nP numeric hosts and ports."],"example":"lsof -nP -iTCP:8080 -sTCP:LISTEN","exampleNote":["查找监听 8080 端口的进程（需安装 lsof）。","Find processes listening on port 8080 (requires lsof)."]},
  {"category":"network","name":"ip addr","description":["查看或配置网络接口的 IP 地址。","Display or configure IP addresses on network interfaces."],"options":["-br 简洁格式；show 查看；add/del 修改地址。","-br brief format; show inspect; add/del change addresses."],"example":"ip -br addr","exampleNote":["简洁查看各接口地址。","List interface addresses in brief form."]},
  {"category":"network","name":"ip route","description":["查看或配置路由表。","Display or configure routing tables."],"options":["show 查看路由；get 查询目标路由；add/del 修改路由。","show list routes; get query route; add/del change routes."],"example":"ip route show","exampleNote":["查看默认网关和路由。","Inspect routes and the default gateway."],"warning":["修改路由可能导致 SSH 断开。","Changing routes can disconnect SSH."]},
  {"category":"network","name":"ss","description":["查看套接字、连接与监听端口。","Inspect sockets, connections and listening ports."],"options":["-l 监听；-n 数字地址端口；-t TCP；-u UDP；-p 进程。","-l listening; -n numeric; -t TCP; -u UDP; -p processes."],"example":"ss -lntp","exampleNote":["查看 TCP 监听端口和关联进程（部分需权限）。","Show TCP listeners and processes (some require permission)."]},
  {"category":"network","name":"ping","description":["用 ICMP 检查目标连通性和往返时延。","Check reachability and round-trip latency with ICMP."],"options":["-c 发送次数；-W 单次等待时间（Linux）。","-c packet count; -W reply timeout (Linux)."],"example":"ping -c 4 example.com","exampleNote":["发送 4 次连通性探测。","Send four reachability probes."]},
  {"category":"network","name":"curl","description":["发送 HTTP 等协议的请求。","Make HTTP and other protocol requests."],"options":["-I 仅请求响应头；-L 跟随重定向；-o 保存文件；--max-time 总超时。","-I headers only; -L redirects; -o output file; --max-time overall timeout."],"example":"curl -I --max-time 10 https://example.com","exampleNote":["检查网站响应头和状态。","Inspect HTTP response headers and status."]},
  {"category":"network","name":"wget","description":["下载网络资源。","Download network resources."],"options":["-O 指定输出文件；-c 续传；--timeout 设置网络超时。","-O output file; -c continue; --timeout network timeout."],"example":"wget --spider https://example.com","exampleNote":["检查资源是否可访问，不保存正文。","Check a resource without saving its body."],"warning":["下载时指定 -O 可能截断同名文件。","Using -O for a download may truncate an existing file."]},
  {"category":"network","name":"dig","description":["查询 DNS 记录。","Query DNS records."],"options":["+short 简洁输出；@server 指定 DNS 服务器；A/AAAA/MX 指定记录类型。","+short concise output; @server DNS resolver; A/AAAA/MX record type."],"example":"dig +short example.com A","exampleNote":["查询域名的 IPv4 地址（需 DNS 工具包）。","Query IPv4 records (requires DNS tools)."]},
  {"category":"network","name":"traceroute","description":["查看到目标的网络路径。","Trace the network path to a destination."],"options":["-n 不解析主机名；-m 最大跳数。","-n numeric addresses; -m max hops."],"example":"traceroute -n example.com","exampleNote":["查看到示例域名的路由跳点（需安装）。","Trace hops to the example domain (requires installation)."]},
  {"category":"network","name":"nc","description":["检查指定 TCP 端口是否可连接。","Check connectivity to a TCP port."],"options":["-z 仅探测；-v 详细信息；-w 超时（不同实现略有差异）。","-z probe only; -v verbose; -w timeout (implementation-dependent)."],"example":"nc -vz -w 3 example.com 443","exampleNote":["测试目标的 443 端口。","Check connectivity to port 443."]},
  {"category":"services","name":"systemctl","description":["管理 systemd 服务和单元。","Manage systemd services and units."],"options":["status 查看状态；start/stop/restart 启停重启；enable/disable 开机启动。","status inspect; start/stop/restart control; enable/disable boot activation."],"example":"systemctl status nginx","exampleNote":["查看 nginx 服务状态（systemd 系统）。","Inspect nginx service status on a systemd host."],"warning":["启停或重启服务会影响在线业务；先核对服务名。","Starting or stopping services can affect live workloads; verify the unit."]},
  {"category":"services","name":"journalctl","description":["查看 systemd 日志。","Read the systemd journal."],"options":["-u 指定单元；-n 最近行数；-f 追踪；--since 指定起始时间。","-u unit; -n recent lines; -f follow; --since start time."],"example":"journalctl -u nginx -n 100 --no-pager","exampleNote":["查看 nginx 最近 100 行日志。","Read the last 100 nginx journal lines."]},
  {"category":"services","name":"crontab","description":["查看或编辑当前用户的 Cron 定时任务。","List or edit the current user's cron jobs."],"options":["-l 列出任务；-e 编辑；-r 删除整个任务表。","-l list; -e edit; -r remove entire crontab."],"example":"crontab -l","exampleNote":["查看当前用户的定时任务。","List the current user's scheduled jobs."],"warning":["-r 会删除当前任务表。","-r removes the entire current crontab."]},
  {"category":"services","name":"date","description":["显示当前日期、时间或指定格式。","Display the current date and time or a custom format."],"options":["-Iseconds ISO 8601 时间；-u UTC；+FORMAT 自定义格式。","-Iseconds ISO 8601; -u UTC; +FORMAT custom format."],"example":"date -Iseconds","exampleNote":["查看含时区偏移的当前时间（GNU date）。","Show current time with timezone offset (GNU date)."]},
  {"category":"services","name":"timedatectl","description":["查看系统时间、时区和同步状态。","Inspect system clock, timezone and synchronization."],"options":["status 查看；list-timezones 列出时区；set-timezone 修改。","status inspect; list-timezones list; set-timezone change."],"example":"timedatectl status","exampleNote":["查看 systemd 系统时间及 NTP 状态。","Inspect clock and synchronization status on systemd."]},
  {"category":"permissions","name":"whoami","description":["显示当前有效用户名称。","Show the effective username."],"options":["通常无额外参数。","Usually used without options."],"example":"whoami","exampleNote":["确认当前操作身份。","Check the current effective user."]},
  {"category":"permissions","name":"id","description":["查看用户 UID、GID 和所属用户组。","Display user and group IDs."],"options":["-u 用户 ID；-g 主组 ID；-G 所有组 ID。","-u user ID; -g primary group ID; -G all group IDs."],"example":"id","exampleNote":["查看当前用户及权限组。","Inspect the current user's groups."]},
  {"category":"permissions","name":"chmod","description":["修改文件或目录权限。","Change file or directory permissions."],"options":["八进制如 640；u/g/o 表示所有者/组/其他人；-R 递归。","Octal modes such as 640; u/g/o owner/group/others; -R recursive."],"example":"chmod 640 ./example.txt","exampleNote":["所有者读写、所属组只读、其他人无权限。","Owner read/write, group read, others no access."],"warning":["递归修改或错误权限可能导致服务无法访问文件。","Recursive or incorrect permissions can break access."]},
  {"category":"permissions","name":"chown","description":["修改文件的所有者和所属组。","Change file owner and group."],"options":["USER:GROUP 指定属主和组；-R 递归。","USER:GROUP sets ownership; -R recursive."],"example":"chown appuser:appgroup ./example.txt","exampleNote":["将示例文件交给指定用户和组。","Assign an example file to a user and group."],"warning":["需适当权限；替换示例用户组，避免改变系统文件。","Requires appropriate permission; replace the example names and avoid system files."]},
  {"category":"permissions","name":"sudo","description":["以其他身份执行获准的命令。","Run authorized commands as another user."],"options":["-l 列出授权；-u 指定用户；-n 不交互询问。","-l list privileges; -u target user; -n non-interactive."],"example":"sudo -l","exampleNote":["检查当前用户拥有的 sudo 权限。","Inspect permitted sudo commands."]},
  {"category":"permissions","name":"getent","description":["从系统名称服务查询账号、组等信息。","Query system name-service databases."],"options":["passwd 用户数据库；group 组数据库；hosts 主机记录。","passwd users; group groups; hosts host database."],"example":"getent passwd appuser","exampleNote":["查询示例用户的账号信息。","Look up an example user account."]},
  {"category":"archive","name":"tar","description":["打包文件或解包归档，常配合 gzip。","Create or extract archives, often with gzip compression."],"options":["-c 创建；-x 解包；-t 列表；-z gzip；-f 归档文件；-C 切换目录。","-c create; -x extract; -t list; -z gzip; -f archive file; -C directory."],"example":"tar -tzf ./backup.tar.gz","exampleNote":["先查看压缩包内容，不解压。","List a compressed archive without extracting."],"warning":["解包或创建归档可能覆盖文件；优先解到新的空目录。","Extraction or creation can overwrite files; prefer a new empty directory."]},
  {"category":"archive","name":"gzip","description":["以 gzip 压缩单个文件。","Compress individual files using gzip."],"options":["-k 保留源文件；-d 解压；-l 查看压缩信息。","-k keep source; -d decompress; -l list compression details."],"example":"gzip -k ./example.log","exampleNote":["生成 .gz 文件并保留源日志。","Compress an example log and keep its source."]},
  {"category":"archive","name":"gunzip","description":["解压 gzip 文件。","Decompress gzip files."],"options":["-k 保留压缩包；-c 输出到标准输出。","-k keep archive; -c write to stdout."],"example":"gunzip -k ./example.log.gz","exampleNote":["解压并保留原压缩包。","Decompress and retain the original archive."]},
  {"category":"archive","name":"zip","description":["创建或更新 ZIP 压缩包。","Create or update a ZIP archive."],"options":["-r 递归；-9 高压缩级别；-q 安静模式。","-r recursive; -9 maximum compression; -q quiet."],"example":"zip -r ./demo.zip ./demo","exampleNote":["将示例目录打包为 ZIP（需 zip）。","Archive an example directory (requires zip)."],"warning":["已有同名 ZIP 可能被更新。","An existing ZIP archive may be updated."]},
  {"category":"archive","name":"unzip","description":["查看或解压 ZIP 压缩包。","List or extract ZIP archives."],"options":["-l 查看列表；-n 不覆盖；-d 指定解压目录。","-l list; -n never overwrite; -d destination directory."],"example":"unzip -l ./demo.zip","exampleNote":["只查看压缩包内容。","List archive contents without extracting."]},
  {"category":"archive","name":"sha256sum","description":["计算或验证文件的 SHA-256 摘要。","Compute or verify SHA-256 file digests."],"options":["-c 按校验清单验证；--quiet 仅显示失败。","-c verify checksum list; --quiet show failures only."],"example":"sha256sum ./backup.tar.gz","exampleNote":["计算压缩包的校验值。","Compute the archive checksum."]},
  {"category":"packages","name":"apt","description":["Debian/Ubuntu 系列的软件包管理。","Manage packages on Debian/Ubuntu systems."],"options":["update 刷新索引；install 安装；remove 卸载；list --installed 已安装列表。","update refresh indexes; install; remove; list --installed."],"example":"apt list --installed","exampleNote":["查看已安装软件包。","List installed packages."],"warning":["安装、升级、卸载会改变系统；先核对变更。","Installation, upgrades and removal change the system; review changes first."]},
  {"category":"packages","name":"dnf","description":["Fedora、较新 RHEL/CentOS 及 Amazon Linux 2023 等的包管理工具。","Package manager on Fedora, newer RHEL/CentOS and Amazon Linux 2023."],"options":["list installed 已安装；search 搜索；install/remove 安装卸载；upgrade 升级。","list installed; search; install/remove; upgrade."],"example":"dnf list installed","exampleNote":["查看已安装软件包。","List installed packages."]},
  {"category":"packages","name":"yum","description":["CentOS 7 等较早 RPM 系统的软件包管理工具。","Package manager on older RPM systems such as CentOS 7."],"options":["list installed 已安装；search 搜索；install 安装；remove 卸载。","list installed; search; install; remove."],"example":"yum list installed","exampleNote":["查看已安装软件包。","List installed packages."]},
  {"category":"packages","name":"dpkg","description":["查询及管理 Debian 软件包。","Query and manage Debian packages."],"options":["-l 列表；-L 列出包文件；-s 状态；-i 安装本地包。","-l list; -L package files; -s status; -i install local package."],"example":"dpkg -l","exampleNote":["查看 Debian 软件包状态。","List Debian package states."]},
  {"category":"packages","name":"rpm","description":["查询及管理 RPM 软件包。","Query and manage RPM packages."],"options":["-qa 列出已安装；-qi 包信息；-ql 包内文件。","-qa list installed; -qi details; -ql package files."],"example":"rpm -qa","exampleNote":["列出已安装 RPM 软件包。","List installed RPM packages."]},
  {"category":"containers","name":"docker ps","description":["查看容器及运行状态。","List containers and their status."],"options":["-a 包含已停止容器；-q 仅 ID；--format 自定义输出。","-a include stopped; -q IDs only; --format customize output."],"example":"docker ps -a","exampleNote":["查看全部容器。","List all containers."]},
  {"category":"containers","name":"docker logs","description":["读取容器标准输出和标准错误日志。","Read container stdout and stderr logs."],"options":["--tail 最近行数；-f 跟踪；--since 起始时间。","--tail recent lines; -f follow; --since starting time."],"example":"docker logs --tail 100 demo","exampleNote":["查看示例容器最近 100 行日志。","Read the last 100 lines of an example container."]},
  {"category":"containers","name":"docker stats","description":["查看容器 CPU、内存和网络等资源使用。","Monitor container CPU, memory and network usage."],"options":["--no-stream 只采样一次；指定容器名称可筛选。","--no-stream single sample; specify containers to filter."],"example":"docker stats --no-stream","exampleNote":["获取一次运行中容器的资源快照。","Take a single resource snapshot."]},
  {"category":"containers","name":"docker inspect","description":["查看 Docker 对象详细配置。","Display detailed Docker object configuration."],"options":["--format Go 模板筛选字段；--type 指定对象类型。","--format Go template; --type object type."],"example":"docker inspect demo","exampleNote":["查看示例容器详细配置。","Inspect the example container."],"warning":["详细配置可能含环境变量等敏感信息，勿直接公开。","Configuration may include sensitive environment variables; avoid sharing it."]},
  {"category":"containers","name":"docker images","description":["列出本地 Docker 镜像。","List locally stored images."],"options":["-a 包含中间镜像；-q 仅 ID。","-a include intermediate images; -q IDs only."],"example":"docker images","exampleNote":["查看镜像及大小。","List images and sizes."]},
  {"category":"containers","name":"docker compose","description":["管理 Compose 多容器应用。","Manage multi-container Compose applications."],"options":["ps 查看；logs 日志；up -d 启动；down 停止并移除项目容器和网络。","ps list; logs read; up -d start; down stop and remove project containers/networks."],"example":"docker compose ps","exampleNote":["查看当前 Compose 项目状态（需 Compose）。","Inspect current Compose project status (requires Compose)."],"warning":["down 等操作会中断服务；先确认项目目录和配置。","Commands such as down can interrupt service; verify the project."]},
  {"category":"containers","name":"docker exec","description":["在运行中的容器里执行命令。","Run a command inside a running container."],"options":["-i 保持标准输入；-t 分配终端；-u 指定用户。","-i keep stdin; -t allocate terminal; -u user."],"example":"docker exec -it demo sh","exampleNote":["进入示例容器的 Shell。","Open a shell in an example container."]},
  {"category":"containers","name":"docker system df","description":["查看 Docker 磁盘占用。","Show Docker disk usage."],"options":["-v 详细空间统计。","-v detailed usage."],"example":"docker system df -v","exampleNote":["查看镜像、容器、卷和构建缓存占用。","Inspect image, container, volume and build-cache usage."]},
  {"category":"remote","name":"ssh","description":["建立 SSH 远程连接。","Open an SSH remote connection."],"options":["-p 端口；-i 私钥文件；-J 跳板机；-v 调试输出。","-p port; -i identity file; -J jump host; -v verbose."],"example":"ssh -p 22 user@192.0.2.10","exampleNote":["连接示例地址；替换为自己的服务器。","Connect to a documentation address; replace with your own server."]},
  {"category":"remote","name":"scp","description":["通过 SSH 复制文件。","Copy files over SSH."],"options":["-P SSH 端口；-p 保留时间权限；-r 递归；-i 私钥。","-P SSH port; -p preserve times/mode; -r recursive; -i identity."],"example":"scp -P 22 user@192.0.2.10:/tmp/example.txt ./","exampleNote":["从示例主机复制文件到当前目录。","Copy a file from an example host to the current directory."],"warning":["scp 可能覆盖同名目标；先选择空目录或核对目标。","scp can overwrite an existing destination; use an empty directory or check first."]},
  {"category":"remote","name":"rsync","description":["增量同步本地或远程文件。","Synchronize local or remote files incrementally."],"options":["-a 归档模式；-v 详细；-z 压缩；--dry-run 预演。","-a archive; -v verbose; -z compress; --dry-run preview."],"example":"rsync -av --dry-run ./demo/ ./backup/","exampleNote":["预览目录同步，不实际写入。","Preview directory synchronization without writes."],"warning":["--delete 会删除目标端多余文件；先预演并核对路径。","--delete removes extra destination files; preview and verify paths."]},
  {"category":"remote","name":"tmux","description":["在 SSH 断线后保留终端会话中的任务。","Keep terminal sessions and tasks available after SSH disconnects."],"options":["new -s NAME 新建；ls 列表；attach -t NAME 恢复；Ctrl+B 后 D 分离。","new -s NAME create; ls list; attach -t NAME attach; Ctrl+B then D detach."],"example":"tmux ls","exampleNote":["查看 tmux 会话（需安装 tmux）。","List tmux sessions (requires tmux)."]},
  {"category":"remote","name":"screen","description":["管理可分离的终端会话。","Manage detachable terminal sessions."],"options":["-S NAME 新建命名会话；-ls 列表；-r 恢复；Ctrl+A 后 D 分离。","-S NAME create named session; -ls list; -r resume; Ctrl+A then D detach."],"example":"screen -ls","exampleNote":["查看 screen 会话（需安装 screen）。","List screen sessions (requires screen)."]},
  {"category":"remote","name":"history","description":["查看 Shell 保存的命令历史。","Display the shell's command history."],"options":["数字指定最近条数；不同 Shell 支持的选项不同。","A number selects recent entries; options vary by shell."],"example":"history 20","exampleNote":["查看 Bash 最近 20 条命令。","Show the last 20 Bash history entries."],"warning":["历史可能包含敏感信息，不要直接分享。","History may contain sensitive information; do not share it indiscriminately."]},
  {"category":"remote","name":"command -v","description":["检查 Shell 能否找到指定命令。","Check how the shell resolves a command."],"options":["-v 输出命令路径或名称；-V 详细描述。","-v path/name; -V verbose description."],"example":"command -v docker","exampleNote":["检查 docker 命令是否可用。","Check whether docker is available."]},
  {"category":"remote","name":"man","description":["阅读系统安装的命令手册。","Read installed manual pages."],"options":["-k 关键词查找；节号指定手册章节；q 退出。","-k keyword search; section number; q quit."],"example":"man ls","exampleNote":["查看 ls 的完整帮助；Shell 内置命令可用 help。","Read the ls manual; use help for Bash built-ins."]},
];
