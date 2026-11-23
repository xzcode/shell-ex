# Shell EX implementation contract

Shared protocol for the initial M0–M5 implementation. JSON fields use camelCase.

## Core Rust modules

Root owns `models.rs`, `error.rs`, `storage.rs`, `credentials.rs`, `backup.rs`, desktop IPC and build manifests.
SSH owner owns `ssh.rs`, `pty.rs`, `tunnels.rs` and SSH integration tests.
Files owner owns `files.rs`, `transfers.rs`, `monitor.rs`, `docker.rs` and their tests.
UI owner owns `apps/desktop/src/**` (except root may add IPC types together with owner), frontend manifest/configuration.

Core error = `AppError { code: String, message: String }`; `Result<T>` alias. Constructors `AppError::new(code, message)`, `AppError::io`, `AppError::internal`. serde Serialize. From io/russh/anyhow/serde_json errors via string as needed.

`Host` = { id, name, address, port: u16, username, group, authMethod: "password"|"key"|"agent"|"interactive", privateKeyPath: Option<String>, proxy: Option<ProxyConfig>, jumpHostId: Option<String>, startupDirectory: Option<String>, keepAliveSeconds: u32, connectTimeoutSeconds: u32, favorite: bool, color: String, notes: String }. All String unless specified; no secrets persisted here.
`ProxyConfig` = { kind: "socks5"|"http", host: String, port: u16 } (no authentication in first implementation).
`SecretInput` = { password: Option<String>, passphrase: Option<String> }, never Debug/log.
`TerminalEvent` = serde tagged `type`: `data { sessionId, data: String(base64), sequence: u64 }`, `state { sessionId, state: String, message: Option<String> }`, `exit { sessionId, code: Option<u32> }`.
`EventSink` = `Arc<dyn Fn(TerminalEvent) + Send + Sync>`.

SSH module should expose `SshManager::new()`, async `probe(&Host)->Result<HostKeyInfo>` (HostKeyInfo {algorithm,fingerprint}), async `connect(&Host, SecretInput, expectedFingerprint: String, EventSink)->Result<String>` (returns session ID), async `write(session_id,&[u8])`, `resize(session_id, cols:u32,rows:u32)`, `disconnect(session_id)`, `exec(session_id, command:&str)->Result<ExecOutput>` (stdout/stderr/status), `sftp(session_id)->Result<Arc<russh_sftp::client::SftpSession>>`.
Root validates known-hosts before connect; connect must independently verify expectedFingerprint before AUTH. Host key changed must not be accepted implicitly. Add jump support via additional API as needed; coordinate.
PTY module exposes `PtyManager::new()`, `open(cwd:Option<String>, cols:u16,rows:u16,EventSink)->Result<String>`, `write`, `resize`, `close`.

## IPC command names and UI models

`hosts_list` -> Host[]; `host_save {host,secret?,rememberSecret:bool}` -> Host; `host_delete {id}`; `host_secret_status {id}` -> bool.
`ssh_probe {hostId}` -> {algorithm,fingerprint,trusted:bool,changed:bool,previousFingerprint?:string}; `ssh_trust {hostId,algorithm,fingerprint,replace:bool}`; `ssh_connect {hostId,secret?,onEvent: Channel<TerminalEvent>}` -> sessionId; `terminal_write {sessionId,data:string(base64),local:bool}`; `terminal_resize {sessionId,cols,rows,local}`; `session_close {sessionId,local}`; `local_open {cwd?,cols,rows,onEvent}` -> sessionId.
`sftp_list {sessionId,path}` -> FileEntry[] ({name,path,isDir,isSymlink,size:number,modified:number|null,permissions:number|null}); `sftp_mkdir {sessionId,path}`; `sftp_rename {sessionId,from,to}`; `sftp_remove {sessionId,path,isDir}` (nonrecursive by default); `sftp_chmod {sessionId,path,mode:number}`.
`file_read {sessionId,path}` -> {path,text,version:string,size:number}; `file_save {sessionId,path,text,expectedVersion:string}` -> same.
`transfer_start {sessionId,direction:"upload"|"download",localPath,remotePath,overwrite:bool}` -> Transfer; `transfers_list` -> Transfer[] ({id,sessionId,direction,localPath,remotePath,status,transferred,total,speed,error?:string}); `transfer_control {id,action:"pause"|"resume"|"cancel"}`.
`monitor_snapshot {sessionId}` -> {hostname,os,uptime,load:[number,number,number],cpuPercent:number|null,memoryTotal:number,memoryUsed:number,diskTotal:number,diskUsed:number,networkRx:number,networkTx:number,processes:ProcessInfo[]} (process {pid,user,cpu,memory,command}).
`process_signal {sessionId,pid,signal:"TERM"|"KILL"}`.
`docker_list {sessionId}` -> {id,name,image,state,status,ports}[]; `docker_action {sessionId,id,action:"start"|"stop"|"restart"}`; `docker_logs {sessionId,id}` -> string.
`tunnel_start {sessionId,kind:"local"|"remote"|"dynamic",bindHost,bindPort,targetHost?,targetPort?}` -> {id,sessionId,kind,bindHost,bindPort,targetHost?,targetPort?}; `tunnels_list` -> same[]; `tunnel_stop {id}`.
`settings_get`/`settings_save {settings}` -> AppSettings ({theme:"dark"|"light",fontSize:number,fontFamily:string,scrollback:number,monitorInterval:number,transferConcurrency:number,confirmMultilinePaste:bool,autoReconnect:bool}).
`workspace_get`/`workspace_save {workspace}` -> {hostIds:string[],activeHostId:string|null,sidebarWidth:number,filesHeight:number,monitorVisible:bool,filesVisible:bool,split:"none"|"horizontal"|"vertical"}.
`snippets_list` -> {id,name,command,group}[]; `snippet_save {snippet}`; `snippet_delete {id}`.
`ssh_config_import {text}` -> {hosts:Host[],warnings:string[]} (preview; saves separately).
`backup_export {path,passphrase,includeCredentials:bool}`; `backup_import {path,passphrase}` -> {hosts:number}.

Use native dialogs (`@tauri-apps/plugin-dialog`) for paths. Browser preview must clearly identify preview mode; no simulated successful SSH connections. Preferences and host edits may use browser localStorage only in explicit preview mode. Do not load external web/CDN scripts; local assets only.
