use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use shell_ex_core::{
    auto_vault::AutoVault,
    backup,
    builtin_vault::BuiltinVault,
    credentials::{CredentialVault, RoutedVault},
    docker::{ContainerInfo, DockerImage, DockerService},
    error::{AppError, Result},
    files::{EditorFile, FileEntry, FileService},
    local_vault::{LocalVault, VaultStatus},
    models::*,
    monitor::{MonitorService, MonitorSnapshot},
    pty::PtyManager,
    ssh::SshManager,
    storage::{Storage, TrustStatus},
    transfers::{DirectoryPlan, DirectoryStartResult, Transfer, TransferManager},
    tunnels::{TunnelInfo, TunnelManager},
};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, Weak,
    },
    time::Duration,
};
use tauri::{ipc::Channel, Manager, State};
use zeroize::Zeroizing;

struct AppState {
    store: Arc<Storage>,
    vault: Arc<RoutedVault>,
    ssh: Arc<SshManager>,
    pty: Arc<PtyManager>,
    files: FileService,
    transfers: Arc<TransferManager>,
    monitor: Arc<MonitorService>,
    docker: DockerService,
    tunnels: Arc<TunnelManager>,
    probes: Mutex<HashMap<String, (String, u16, HostKeyInfo)>>,
    mutation: Arc<Mutex<()>>,
}
impl AppState {
    fn new(path: PathBuf) -> Result<Self> {
        let store = Arc::new(Storage::open(&path.join("shell-ex.sqlite3"))?);
        let local_vault = Arc::new(LocalVault::open(&path.join("credentials.sqlite3"))?);
        // Existing v0.3.1 auto-vault users keep their original encrypted records.
        // Do not create a legacy key file on a fresh v0.3.2 installation.
        let legacy_auto =
            if path.join("auto-vault.sqlite3").exists() || path.join("auto-vault.key").exists() {
                Some(Arc::new(AutoVault::open(&path)?))
            } else {
                None
            };
        let builtin = Arc::new(BuiltinVault::open(&path)?);
        let vault = Arc::new(RoutedVault::new(
            store.clone(),
            local_vault,
            legacy_auto,
            builtin,
        ));
        let ssh = Arc::new(SshManager::new());
        Ok(Self {
            transfers: Arc::new(TransferManager::new(
                ssh.clone(),
                store.settings()?.transfer_concurrency as usize,
            )),
            files: FileService::new(ssh.clone()),
            monitor: Arc::new(MonitorService::new(ssh.clone())),
            docker: DockerService::new(ssh.clone()),
            tunnels: Arc::new(TunnelManager::new(ssh.clone())),
            store,
            vault,
            ssh,
            pty: Arc::new(PtyManager::new()),
            probes: Mutex::new(HashMap::new()),
            mutation: Arc::new(Mutex::new(())),
        })
    }
    async fn jump_session(&self, host: &Host) -> Result<Option<String>> {
        if let Some(jump) = &host.jump_host_id {
            self.ssh.get_by_host(jump).await.map(Some).ok_or_else(|| {
                AppError::new(
                    "JUMP_NOT_CONNECTED",
                    "请先连接已配置的跳板机，再连接此主机。",
                )
            })
        } else {
            Ok(None)
        }
    }
    async fn probe_host(&self, host: &Host) -> Result<HostKeyInfo> {
        match self.jump_session(host).await? {
            Some(id) => self.ssh.probe_via(host, &id).await,
            None => self.ssh.probe(host).await,
        }
    }
    fn session_owner(&self, local: bool) -> SessionOwner {
        if local {
            SessionOwner::Local(Arc::downgrade(&self.pty))
        } else {
            SessionOwner::Ssh {
                ssh: Arc::downgrade(&self.ssh),
                transfers: Arc::downgrade(&self.transfers),
                monitor: Arc::downgrade(&self.monitor),
                tunnels: Arc::downgrade(&self.tunnels),
            }
        }
    }
}

// A stream callback must not keep the owning managers alive through its session.
#[derive(Clone)]
enum SessionOwner {
    Local(Weak<PtyManager>),
    Ssh {
        ssh: Weak<SshManager>,
        transfers: Weak<TransferManager>,
        monitor: Weak<MonitorService>,
        tunnels: Weak<TunnelManager>,
    },
}
impl SessionOwner {
    async fn close(&self, session_id: String) -> Result<()> {
        match self {
            Self::Local(manager) => {
                if let Some(manager) = manager.upgrade() {
                    tokio::task::spawn_blocking(move || manager.close(&session_id))
                        .await
                        .map_err(join_error)??;
                }
            }
            Self::Ssh {
                ssh,
                transfers,
                monitor,
                tunnels,
            } => {
                if let Some(transfers) = transfers.upgrade() {
                    transfers.cancel_session(&session_id).await;
                }
                if let Some(monitor) = monitor.upgrade() {
                    monitor.forget_session(&session_id).await;
                }
                if let Some(tunnels) = tunnels.upgrade() {
                    tunnels.stop_session(&session_id).await;
                }
                if let Some(ssh) = ssh.upgrade() {
                    ssh.disconnect(&session_id).await?;
                }
            }
        }
        Ok(())
    }
}

fn sink(channel: Channel<TerminalEvent>, owner: SessionOwner) -> EventSink {
    let auth_owner = owner.clone();
    guarded_sink(
        channel,
        move |session_id| {
            let owner = owner.clone();
            tauri::async_runtime::spawn(async move {
                let _ = owner.close(session_id).await;
            });
        },
        move |request_id| {
            if let SessionOwner::Ssh { ssh, .. } = &auth_owner {
                if let Some(ssh) = ssh.upgrade() {
                    tauri::async_runtime::spawn(async move {
                        // An undeliverable challenge cannot receive an answer.
                        let _ = ssh.auth_respond(&request_id, Vec::new()).await;
                    });
                }
            }
        },
    )
}

fn guarded_sink(
    channel: Channel<TerminalEvent>,
    close: impl Fn(String) + Send + Sync + 'static,
    cancel_auth: impl Fn(String) + Send + Sync + 'static,
) -> EventSink {
    let failed = AtomicBool::new(false);
    let cleanup_started = AtomicBool::new(false);
    Arc::new(move |event| {
        let registered_session = match &event {
            TerminalEvent::Data { session_id, .. } | TerminalEvent::Exit { session_id, .. } => {
                Some(session_id.clone())
            }
            TerminalEvent::State {
                session_id, state, ..
            } if matches!(state.as_str(), "connected" | "disconnected") => Some(session_id.clone()),
            _ => None,
        };
        let auth_request = match &event {
            TerminalEvent::Auth { request_id, .. } => Some(request_id.clone()),
            _ => None,
        };
        if !failed.load(Ordering::Acquire) && channel.send(event).is_ok() {
            return;
        }
        failed.store(true, Ordering::Release);
        if let Some(request_id) = auth_request {
            cancel_auth(request_id);
        }
        // SSH emits connecting/auth events before registration. Do not consume
        // the one-shot cleanup until a registered session can actually close.
        // Both managers insert before connected/data emission, and cleanup's
        // exit events re-enter this sink without scheduling another close.
        if let Some(session_id) = registered_session {
            if !cleanup_started.swap(true, Ordering::AcqRel) {
                close(session_id);
            }
        }
    })
}
fn join_error(e: tokio::task::JoinError) -> AppError {
    AppError::new("TASK_FAILED", e.to_string())
}

#[cfg(test)]
mod terminal_delivery_tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    fn state_event(state: &str) -> TerminalEvent {
        TerminalEvent::State {
            session_id: "owning-session".into(),
            state: state.into(),
            message: None,
        }
    }

    #[test]
    fn early_delivery_failure_cancels_auth_and_closes_after_registration_once() {
        let attempts = Arc::new(AtomicUsize::new(0));
        let delivered = attempts.clone();
        let closed = Arc::new(Mutex::new(Vec::new()));
        let close_events = closed.clone();
        let cancelled = Arc::new(Mutex::new(Vec::new()));
        let auth_events = cancelled.clone();
        let events = guarded_sink(
            Channel::new(move |_| {
                delivered.fetch_add(1, Ordering::SeqCst);
                Err(tauri::Error::FailedToReceiveMessage)
            }),
            move |id| close_events.lock().unwrap().push(id),
            move |request| auth_events.lock().unwrap().push(request),
        );
        events(state_event("connecting"));
        events(TerminalEvent::Auth {
            session_id: "owning-session".into(),
            request_id: "undeliverable-challenge".into(),
            name: String::new(),
            instructions: String::new(),
            prompts: vec![AuthPrompt {
                prompt: "One-time code".into(),
                echo: false,
            }],
        });
        assert!(closed.lock().unwrap().is_empty());
        assert_eq!(*cancelled.lock().unwrap(), vec!["undeliverable-challenge"]);

        events(state_event("connected"));
        for sequence in 1..=64 {
            events(TerminalEvent::Data {
                session_id: "owning-session".into(),
                data: "YQ==".into(),
                sequence,
            });
        }
        events(TerminalEvent::Exit {
            session_id: "owning-session".into(),
            code: None,
        });
        events(state_event("disconnected"));
        assert_eq!(*closed.lock().unwrap(), vec!["owning-session"]);
        assert_eq!(attempts.load(Ordering::SeqCst), 1);
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread")]
    async fn failed_native_channel_closes_only_its_registered_local_pty() {
        let manager = Arc::new(PtyManager::new());
        let cwd = Some(std::env::temp_dir().to_string_lossy().into_owned());
        let other = manager.open(cwd.clone(), 80, 24, Arc::new(|_| {})).unwrap();
        let failed = manager
            .open(
                cwd,
                80,
                24,
                sink(
                    Channel::new(|_| Err(tauri::Error::FailedToReceiveMessage)),
                    SessionOwner::Local(Arc::downgrade(&manager)),
                ),
            )
            .unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            while manager.resize(&failed, 81, 25).is_ok() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        manager.resize(&other, 82, 26).unwrap();
        manager.close(&other).unwrap();
    }
}

#[tauri::command]
fn hosts_list(state: State<'_, AppState>) -> Result<Vec<Host>> {
    state.store.hosts()
}
#[tauri::command]
async fn host_save(
    state: State<'_, AppState>,
    mut host: Host,
    secret: Option<SecretInput>,
    remember_secret: bool,
) -> Result<Host> {
    if host.id.is_empty() {
        host.id = uuid::Uuid::new_v4().to_string();
    }
    shell_ex_core::storage::validate_host(&host)?;
    let store = state.store.clone();
    let vault = state.vault.clone();
    let mutation = state.mutation.clone();
    tokio::task::spawn_blocking(move || {
        let _guard = mutation.lock().map_err(AppError::internal)?;
        let old = store.host(&host.id).ok();
        let changing = old
            .as_ref()
            .is_some_and(|h| h.credential_store != host.credential_store);
        let has_secret = secret.as_ref().is_some_and(|s| {
            s.password.as_ref().is_some_and(|p| !p.is_empty())
                || s.passphrase.as_ref().is_some_and(|p| !p.is_empty())
        });
        let next_secret = if host.credential_store == "session" {
            None
        } else if remember_secret && has_secret {
            secret
        } else if changing {
            // Migration is explicit; copy an existing local secret before switching.
            match old.as_ref() {
                Some(previous_host) => vault.get_for_host(previous_host)?,
                None => None,
            }
        } else {
            None
        };
        let previous_target = if next_secret.is_some() {
            Some(vault.get_for_host(&host)?)
        } else {
            None
        };
        if let Some(secret) = next_secret.as_ref() {
            vault.set_for_host(&host, secret)?;
        }
        let saved = match store.save_host(host.clone()) {
            Ok(saved) => saved,
            Err(error) => {
                if let Some(previous) = previous_target {
                    let restored = match previous {
                        Some(s) => vault.set_for_host(&host, &s),
                        None => vault.delete_for_host(&host),
                    };
                    if restored.is_err() {
                        return Err(AppError::new(
                            "CREDENTIAL_ROLLBACK_FAILED",
                            "保存主机失败且新凭据回滚失败，请检查密码库后重试。",
                        ));
                    }
                }
                return Err(error);
            }
        };
        if changing {
            if let Some(previous_host) = old.as_ref() {
                if let Err(e) = vault.delete_for_host(previous_host) {
                    let host_restored = store.save_host(previous_host.clone());
                    let secret_restored = match previous_target {
                        Some(Some(s)) => vault.set_for_host(&host, &s),
                        Some(None) => vault.delete_for_host(&host),
                        None => Ok(()),
                    };
                    if host_restored.is_err() || secret_restored.is_err() {
                        return Err(AppError::new(
                            "CREDENTIAL_ROLLBACK_FAILED",
                            "切换凭据存储失败且回滚不完整；请检查旧凭据位置。",
                        ));
                    }
                    return Err(e);
                }
            }
        }
        Ok(saved)
    })
    .await
    .map_err(join_error)?
}
#[tauri::command]
async fn host_delete(state: State<'_, AppState>, id: String) -> Result<()> {
    if state.ssh.get_by_host(&id).await.is_some() {
        return Err(AppError::new("HOST_CONNECTED", "请先关闭该主机的连接"));
    }
    let store = state.store.clone();
    let vault = state.vault.clone();
    let mutation = state.mutation.clone();
    tokio::task::spawn_blocking(move || {
        let _guard = mutation.lock().map_err(AppError::internal)?;
        let host = store.host(&id)?;
        store.delete_host(&id)?;
        if let Err(e) = vault.delete_for_host(&host) {
            store.save_host(host)?;
            return Err(e);
        }
        Ok(())
    })
    .await
    .map_err(join_error)?
}
#[tauri::command]
async fn host_secret_status(state: State<'_, AppState>, id: String) -> Result<bool> {
    let host = state.store.host(&id)?;
    let vault = state.vault.clone();
    tokio::task::spawn_blocking(move || vault.get_for_host(&host).map(|v| v.is_some()))
        .await
        .map_err(join_error)?
}
#[tauri::command]
async fn host_secret_delete(state: State<'_, AppState>, id: String) -> Result<()> {
    let host = state.store.host(&id)?;
    let vault = state.vault.clone();
    let mutation = state.mutation.clone();
    tokio::task::spawn_blocking(move || {
        let _guard = mutation.lock().map_err(AppError::internal)?;
        vault.delete_for_host(&host)
    })
    .await
    .map_err(join_error)?
}
#[tauri::command]
fn vault_status(state: State<'_, AppState>) -> Result<VaultStatus> {
    state.vault.local().status()
}
#[tauri::command]
async fn vault_initialize(state: State<'_, AppState>, master_password: String) -> Result<()> {
    let password = Zeroizing::new(master_password);
    let vault = state.vault.clone();
    let mutation = state.mutation.clone();
    tokio::task::spawn_blocking(move || {
        let _guard = mutation.lock().map_err(AppError::internal)?;
        vault.local().initialize(&password)
    })
    .await
    .map_err(join_error)?
}
#[tauri::command]
async fn vault_unlock(state: State<'_, AppState>, master_password: String) -> Result<()> {
    let password = Zeroizing::new(master_password);
    let vault = state.vault.clone();
    tokio::task::spawn_blocking(move || vault.local().unlock(&password))
        .await
        .map_err(join_error)?
}
#[tauri::command]
async fn vault_lock(state: State<'_, AppState>) -> Result<()> {
    let vault = state.vault.clone();
    let mutation = state.mutation.clone();
    tokio::task::spawn_blocking(move || {
        let _guard = mutation.lock().map_err(AppError::internal)?;
        vault.local().lock()
    })
    .await
    .map_err(join_error)?
}
#[tauri::command]
async fn vault_change_password(
    state: State<'_, AppState>,
    old_password: String,
    new_password: String,
) -> Result<()> {
    let old = Zeroizing::new(old_password);
    let new = Zeroizing::new(new_password);
    let vault = state.vault.clone();
    let mutation = state.mutation.clone();
    tokio::task::spawn_blocking(move || {
        let _guard = mutation.lock().map_err(AppError::internal)?;
        vault.local().change_password(&old, &new)
    })
    .await
    .map_err(join_error)?
}
#[tauri::command]
async fn ssh_probe(state: State<'_, AppState>, host_id: String) -> Result<TrustStatus> {
    let host = state.store.host(&host_id)?;
    let key = state.probe_host(&host).await?;
    let status = state.store.trust_status(&host, key.clone())?;
    state
        .probes
        .lock()
        .map_err(AppError::internal)?
        .insert(host_id, (host.address, host.port, key));
    Ok(status)
}
#[tauri::command]
fn ssh_trust(
    state: State<'_, AppState>,
    host_id: String,
    algorithm: String,
    fingerprint: String,
    replace: bool,
) -> Result<()> {
    let host = state.store.host(&host_id)?;
    let pending = state
        .probes
        .lock()
        .map_err(AppError::internal)?
        .get(&host_id)
        .cloned()
        .ok_or_else(|| AppError::new("PROBE_REQUIRED", "请先重新测试连接并核对指纹"))?;
    if pending.0 != host.address
        || pending.1 != host.port
        || pending.2.algorithm != algorithm
        || pending.2.fingerprint != fingerprint
    {
        return Err(AppError::new(
            "PROBE_CHANGED",
            "配置或指纹已变化，请重新测试连接",
        ));
    }
    state.store.trust(&host, &algorithm, &fingerprint, replace)
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectResult {
    session_id: String,
    credential_save_failed: bool,
}
#[tauri::command]
async fn ssh_connect(
    state: State<'_, AppState>,
    host_id: String,
    secret: Option<SecretInput>,
    remember_secret: Option<bool>,
    on_event: Channel<TerminalEvent>,
) -> Result<ConnectResult> {
    let host = state.store.host(&host_id)?;
    // Re-probe immediately; the authenticated transport independently pins this same fingerprint.
    let key = state.probe_host(&host).await?;
    let status = state.store.trust_status(&host, key.clone())?;
    if !status.trusted {
        return Err(AppError::new(
            if status.changed {
                "HOST_KEY_CHANGED"
            } else {
                "HOST_KEY_UNKNOWN"
            },
            "服务器指纹未受信任，请先核对主机身份。",
        ));
    }
    let supplied = secret.is_some();
    let secret = if supplied {
        secret.unwrap_or_default()
    } else if ["password", "key"].contains(&host.auth_method.as_str()) {
        let vault = state.vault.clone();
        let id = host_id.clone();
        tokio::task::spawn_blocking(move || vault.get(&id))
            .await
            .map_err(join_error)??
            .unwrap_or_default()
    } else {
        SecretInput::default()
    };
    let remember = supplied
        && remember_secret.unwrap_or(false)
        && host.credential_store == "builtin"
        && match host.auth_method.as_str() {
            "password" => secret.password.as_ref().is_some_and(|v| !v.is_empty()),
            "key" => secret.passphrase.as_ref().is_some_and(|v| !v.is_empty()),
            _ => false,
        };
    let remembered = remember.then(|| secret.clone());
    let event_sink = sink(on_event, state.session_owner(false));
    let session_id = match state.jump_session(&host).await? {
        Some(jump) => {
            state
                .ssh
                .connect_via(&host, secret, key.fingerprint, event_sink, &jump)
                .await
        }
        None => {
            state
                .ssh
                .connect(&host, secret, key.fingerprint, event_sink)
                .await
        }
    }?;
    // A failed vault write must not hide or leak an already authenticated session.
    // Recheck the host under the mutation lock before persisting the secret.
    let credential_save_failed = if let Some(secret) = remembered {
        let vault = state.vault.clone();
        let store = state.store.clone();
        let mutation = state.mutation.clone();
        !matches!(
            tokio::task::spawn_blocking(move || {
                let _guard = mutation.lock().map_err(AppError::internal)?;
                let current = store.host(&host.id)?;
                if current.credential_store != "builtin"
                    || current.address != host.address
                    || current.port != host.port
                    || current.username != host.username
                    || current.auth_method != host.auth_method
                    || current.private_key_path != host.private_key_path
                    || current.jump_host_id != host.jump_host_id
                {
                    return Err(AppError::new(
                        "HOST_CHANGED",
                        "连接配置已改变，请编辑连接重新保存密码。",
                    ));
                }
                // Never overwrite a credential saved by another action during authentication.
                if vault.get_for_host(&current)?.is_none() {
                    vault.set_for_host(&current, &secret)?;
                }
                Ok(())
            })
            .await,
            Ok(Ok(()))
        )
    } else {
        false
    };
    Ok(ConnectResult {
        session_id,
        credential_save_failed,
    })
}
#[tauri::command]
async fn ssh_auth_respond(
    state: State<'_, AppState>,
    request_id: String,
    responses: Vec<String>,
) -> Result<()> {
    state.ssh.auth_respond(&request_id, responses).await
}
#[tauri::command]
async fn local_open(
    state: State<'_, AppState>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    on_event: Channel<TerminalEvent>,
) -> Result<String> {
    validate_size(cols as u32, rows as u32)?;
    let manager = state.pty.clone();
    let event_sink = sink(on_event, state.session_owner(true));
    tokio::task::spawn_blocking(move || manager.open(cwd, cols, rows, event_sink))
        .await
        .map_err(join_error)?
}
fn validate_size(cols: u32, rows: u32) -> Result<()> {
    if cols == 0 || rows == 0 || cols > 1000 || rows > 1000 {
        Err(AppError::new("INVALID_SIZE", "终端大小无效"))
    } else {
        Ok(())
    }
}
#[tauri::command]
async fn terminal_write(
    state: State<'_, AppState>,
    session_id: String,
    data: String,
    local: bool,
) -> Result<()> {
    if data.len() > 128 * 1024 {
        return Err(AppError::new("INPUT_TOO_LARGE", "请分批粘贴大文本"));
    }
    let bytes = Zeroizing::new(
        STANDARD
            .decode(data)
            .map_err(|_| AppError::new("INVALID_INPUT", "终端输入编码无效"))?,
    );
    if local {
        let manager = state.pty.clone();
        tokio::task::spawn_blocking(move || manager.write(&session_id, &bytes))
            .await
            .map_err(join_error)?
    } else {
        state.ssh.write(&session_id, &bytes).await
    }
}
#[tauri::command]
async fn terminal_resize(
    state: State<'_, AppState>,
    session_id: String,
    cols: u32,
    rows: u32,
    local: bool,
) -> Result<()> {
    validate_size(cols, rows)?;
    if local {
        state.pty.resize(&session_id, cols as u16, rows as u16)
    } else {
        state.ssh.resize(&session_id, cols, rows).await
    }
}
#[tauri::command]
async fn terminal_ack(
    state: State<'_, AppState>,
    session_id: String,
    sequence: u64,
    local: bool,
) -> Result<()> {
    if local {
        state.pty.ack(&session_id, sequence)
    } else {
        state.ssh.ack(&session_id, sequence).await
    }
}
#[tauri::command]
async fn session_close(state: State<'_, AppState>, session_id: String, local: bool) -> Result<()> {
    state.session_owner(local).close(session_id).await
}
#[tauri::command]
async fn sftp_realpath(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> Result<String> {
    state.files.canonicalize(&session_id, &path).await
}
#[tauri::command]
async fn sftp_list(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> Result<Vec<FileEntry>> {
    state.files.list(&session_id, &path).await
}
#[tauri::command]
async fn sftp_mkdir(state: State<'_, AppState>, session_id: String, path: String) -> Result<()> {
    state.files.mkdir(&session_id, &path).await
}
#[tauri::command]
async fn sftp_create_file(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> Result<()> {
    state.files.create_file(&session_id, &path).await
}
#[tauri::command]
async fn sftp_remove_tree(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> Result<()> {
    state.files.remove_tree(&session_id, &path).await
}
#[tauri::command]
async fn download_destination_exists(path: String) -> Result<bool> {
    TransferManager::download_destination_exists(&path).await
}
#[tauri::command]
async fn transfer_start_archive(
    state: State<'_, AppState>,
    session_id: String,
    paths: Vec<String>,
    local_path: String,
) -> Result<Transfer> {
    state
        .transfers
        .start_archive_download(session_id, paths, local_path)
        .await
}
#[tauri::command]
async fn sftp_rename(
    state: State<'_, AppState>,
    session_id: String,
    from: String,
    to: String,
) -> Result<()> {
    state.files.rename(&session_id, &from, &to).await
}
#[tauri::command]
async fn sftp_remove(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
    is_dir: bool,
) -> Result<()> {
    state.files.remove(&session_id, &path, is_dir).await
}
#[tauri::command]
async fn sftp_chmod(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
    mode: u32,
) -> Result<()> {
    state.files.chmod(&session_id, &path, mode).await
}
#[tauri::command]
async fn file_read(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> Result<EditorFile> {
    state.files.read(&session_id, &path).await
}
#[tauri::command]
async fn file_save(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
    text: String,
    expected_version: String,
) -> Result<EditorFile> {
    state
        .files
        .save(&session_id, &path, &text, &expected_version)
        .await
}
#[tauri::command]
async fn transfer_start(
    state: State<'_, AppState>,
    session_id: String,
    direction: String,
    local_path: String,
    remote_path: String,
    overwrite: bool,
) -> Result<Transfer> {
    state
        .transfers
        .start(session_id, direction, local_path, remote_path, overwrite)
        .await
}
#[tauri::command]
async fn transfer_plan_directory(
    state: State<'_, AppState>,
    session_id: String,
    direction: String,
    local_root: String,
    remote_root: String,
) -> Result<DirectoryPlan> {
    state
        .transfers
        .plan_directory(session_id, direction, local_root, remote_root)
        .await
}
#[tauri::command]
async fn transfer_start_directory(
    state: State<'_, AppState>,
    plan_id: String,
    conflict: String,
) -> Result<DirectoryStartResult> {
    state.transfers.start_directory(&plan_id, &conflict).await
}
#[tauri::command]
async fn transfers_list(state: State<'_, AppState>) -> Result<Vec<Transfer>> {
    Ok(state.transfers.list().await)
}
#[tauri::command]
async fn transfer_control(state: State<'_, AppState>, id: String, action: String) -> Result<()> {
    state.transfers.control(&id, &action).await
}
#[tauri::command]
async fn monitor_snapshot(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<MonitorSnapshot> {
    state.monitor.snapshot(&session_id).await
}
#[tauri::command]
async fn process_signal(
    state: State<'_, AppState>,
    session_id: String,
    pid: u32,
    signal: String,
) -> Result<()> {
    state
        .monitor
        .process_signal(&session_id, pid, &signal)
        .await
}
#[tauri::command]
async fn docker_list(state: State<'_, AppState>, session_id: String) -> Result<Vec<ContainerInfo>> {
    state.docker.list(&session_id).await
}
#[tauri::command]
async fn docker_images(state: State<'_, AppState>, session_id: String) -> Result<Vec<DockerImage>> {
    state.docker.images(&session_id).await
}
#[tauri::command]
async fn docker_action(
    state: State<'_, AppState>,
    session_id: String,
    id: String,
    action: String,
) -> Result<()> {
    state.docker.action(&session_id, &id, &action).await
}
#[tauri::command]
async fn docker_logs(state: State<'_, AppState>, session_id: String, id: String) -> Result<String> {
    state.docker.logs(&session_id, &id).await
}
#[tauri::command]
async fn tunnel_start(
    state: State<'_, AppState>,
    session_id: String,
    kind: String,
    bind_host: String,
    bind_port: u16,
    target_host: Option<String>,
    target_port: Option<u16>,
) -> Result<TunnelInfo> {
    state
        .tunnels
        .start(
            &session_id,
            &kind,
            &bind_host,
            bind_port,
            target_host,
            target_port,
        )
        .await
}
#[tauri::command]
async fn tunnels_list(state: State<'_, AppState>) -> Result<Vec<TunnelInfo>> {
    Ok(state.tunnels.list().await)
}
#[tauri::command]
async fn tunnel_stop(state: State<'_, AppState>, id: String) -> Result<()> {
    state.tunnels.stop(&id).await
}
#[tauri::command]
fn settings_get(state: State<'_, AppState>) -> Result<AppSettings> {
    state.store.settings()
}
#[tauri::command]
async fn settings_save(state: State<'_, AppState>, settings: AppSettings) -> Result<AppSettings> {
    let store = state.store.clone();
    let mutation = state.mutation.clone();
    let result = tokio::task::spawn_blocking(move || {
        let _guard = mutation.lock().map_err(AppError::internal)?;
        store.save_settings(&settings)?;
        Ok(settings)
    })
    .await
    .map_err(join_error)?;
    if let Ok(settings) = &result {
        state
            .transfers
            .set_concurrency(settings.transfer_concurrency as usize);
    }
    result
}
#[tauri::command]
fn workspace_get(state: State<'_, AppState>) -> Result<Workspace> {
    state.store.preference("workspace")
}
#[tauri::command]
async fn workspace_save(state: State<'_, AppState>, workspace: Workspace) -> Result<Workspace> {
    shell_ex_core::storage::validate_workspace(&workspace)?;
    let store = state.store.clone();
    let mutation = state.mutation.clone();
    tokio::task::spawn_blocking(move || {
        let _guard = mutation.lock().map_err(AppError::internal)?;
        store.set_preference("workspace", &workspace)?;
        Ok(workspace)
    })
    .await
    .map_err(join_error)?
}
#[tauri::command]
fn snippets_list(state: State<'_, AppState>) -> Result<Vec<Snippet>> {
    state.store.snippets()
}
#[tauri::command]
async fn snippet_save(state: State<'_, AppState>, snippet: Snippet) -> Result<Snippet> {
    let store = state.store.clone();
    let mutation = state.mutation.clone();
    tokio::task::spawn_blocking(move || {
        let _guard = mutation.lock().map_err(AppError::internal)?;
        store.save_snippet(snippet)
    })
    .await
    .map_err(join_error)?
}
#[tauri::command]
async fn snippet_delete(state: State<'_, AppState>, id: String) -> Result<()> {
    let store = state.store.clone();
    let mutation = state.mutation.clone();
    tokio::task::spawn_blocking(move || {
        let _guard = mutation.lock().map_err(AppError::internal)?;
        store.delete_snippet(&id)
    })
    .await
    .map_err(join_error)?
}
#[tauri::command]
fn ssh_config_import(text: String) -> Result<shell_ex_core::import::ImportPreview> {
    shell_ex_core::import::parse(&text)
}
#[tauri::command]
async fn hosts_import(state: State<'_, AppState>, hosts: Vec<Host>) -> Result<Vec<Host>> {
    let store = state.store.clone();
    let mutation = state.mutation.clone();
    tokio::task::spawn_blocking(move || {
        let _guard = mutation.lock().map_err(AppError::internal)?;
        store.import_configuration(
            &hosts,
            &[],
            &store.settings()?,
            &store.preference::<Workspace>("workspace")?,
        )?;
        Ok(hosts)
    })
    .await
    .map_err(join_error)?
}
fn backup_path(path: &str) -> Result<&Path> {
    let path = Path::new(path);
    if !path.is_absolute() || path.extension().is_none_or(|s| s != "shex") {
        return Err(AppError::new(
            "INVALID_BACKUP_PATH",
            "请选择扩展名为 .shex 的绝对文件路径",
        ));
    }
    Ok(path)
}
#[tauri::command]
async fn backup_export(
    state: State<'_, AppState>,
    path: String,
    passphrase: String,
    include_credentials: bool,
) -> Result<()> {
    backup_path(&path)?;
    let passphrase = Zeroizing::new(passphrase);
    let store = state.store.clone();
    let vault = state.vault.clone();
    let mutation = state.mutation.clone();
    tokio::task::spawn_blocking(move || {
        let _guard = mutation.lock().map_err(AppError::internal)?;
        backup::export(
            &store,
            &*vault,
            Path::new(&path),
            &passphrase,
            include_credentials,
        )
    })
    .await
    .map_err(join_error)?
}
#[tauri::command]
async fn backup_import(
    state: State<'_, AppState>,
    path: String,
    passphrase: String,
) -> Result<backup::ImportSummary> {
    backup_path(&path)?;
    let passphrase = Zeroizing::new(passphrase);
    let store = state.store.clone();
    let vault = state.vault.clone();
    let mutation = state.mutation.clone();
    tokio::task::spawn_blocking(move || {
        let _guard = mutation.lock().map_err(AppError::internal)?;
        backup::import(&store, &*vault, Path::new(&path), &passphrase)
    })
    .await
    .map_err(join_error)?
}
#[derive(Serialize)]
struct UpdateConfig {
    configured: bool,
    version: &'static str,
    reason: Option<&'static str>,
}
#[tauri::command]
fn update_config() -> UpdateConfig {
    let configured = updater_settings().is_some();
    UpdateConfig {
        configured,
        version: env!("CARGO_PKG_VERSION"),
        reason: if configured {
            None
        } else {
            Some("此构建未配置签名更新源。请从项目仓库获取经过核对的新安装包。")
        },
    }
}
fn updater_settings() -> Option<(&'static str, &'static str)> {
    let key = option_env!("SHELL_EX_UPDATE_PUBKEY")?;
    let endpoint = option_env!("SHELL_EX_UPDATE_ENDPOINT")?;
    if key.trim().is_empty()
        || !endpoint.starts_with("https://")
        || tauri::Url::parse(endpoint).is_err()
    {
        return None;
    }
    Some((key, endpoint))
}

pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init());
    let mut context = tauri::generate_context!();
    if let Some((key, endpoint)) = updater_settings() {
        context.config_mut().plugins.0.insert(
            "updater".into(),
            serde_json::json!({"pubkey":key,"endpoints":[endpoint],"requireSignedVersion":true}),
        );
        builder = builder.plugin(tauri_plugin_updater::Builder::new().pubkey(key).build());
    }
    let app = builder
        .setup(|app| {
            let state = AppState::new(app.path().app_data_dir()?)?;
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            hosts_list,
            host_save,
            host_delete,
            host_secret_status,
            host_secret_delete,
            vault_status,
            vault_initialize,
            vault_unlock,
            vault_lock,
            vault_change_password,
            ssh_probe,
            ssh_trust,
            ssh_connect,
            ssh_auth_respond,
            local_open,
            terminal_write,
            terminal_resize,
            terminal_ack,
            session_close,
            sftp_realpath,
            sftp_list,
            sftp_mkdir,
            sftp_create_file,
            sftp_remove_tree,
            download_destination_exists,
            transfer_start_archive,
            sftp_rename,
            sftp_remove,
            sftp_chmod,
            file_read,
            file_save,
            transfer_start,
            transfer_plan_directory,
            transfer_start_directory,
            transfers_list,
            transfer_control,
            monitor_snapshot,
            process_signal,
            docker_list,
            docker_images,
            docker_action,
            docker_logs,
            tunnel_start,
            tunnels_list,
            tunnel_stop,
            settings_get,
            settings_save,
            workspace_get,
            workspace_save,
            snippets_list,
            snippet_save,
            snippet_delete,
            ssh_config_import,
            hosts_import,
            backup_export,
            backup_import,
            update_config,
        ])
        .build(context)
        .expect("Shell EX could not initialize its local application data");
    app.run(|handle, event| {
        if let tauri::RunEvent::Exit = event {
            let state = handle.state::<AppState>();
            let _ = state.vault.local().lock();
            state.pty.close_all();
            tauri::async_runtime::block_on(async {
                let _ = tokio::time::timeout(Duration::from_secs(4), async {
                    state.transfers.cancel_all().await;
                    state.tunnels.close_all().await;
                    state.ssh.close_all().await;
                })
                .await;
            });
        }
    });
}
