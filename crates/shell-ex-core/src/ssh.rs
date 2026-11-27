//! SSH transports, terminal streams and explicit authentication handoffs.
//!
//! A probe deliberately refuses the key after collecting its fingerprint. No
//! credentials are sent during probing. Every real connection independently
//! compares its key before the user-authentication exchange starts.
use crate::error::{AppError, Result};
use crate::models::{
    AuthPrompt, EventSink, ExecOutput, Host, HostKeyInfo, SecretInput, TerminalEvent,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use russh::{client, keys, Channel, ChannelMsg, ChannelOpenFailure, ChannelWriteHalf, Disconnect};
use russh_sftp::client::{RawSftpSession, SftpSession};
use std::{
    collections::{BTreeMap, HashMap},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex as StdMutex,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::TcpStream,
    sync::{oneshot, Mutex, OwnedSemaphorePermit, RwLock, Semaphore},
    time::timeout,
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

const FRAME_SIZE: usize = 16 * 1024;
const OUTPUT_WINDOW: usize = 32;
const EXEC_LIMIT: usize = 2 * 1024 * 1024;

pub(crate) trait SshIo: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> SshIo for T {}

/// Acknowledged frames bound the data waiting inside the WebView IPC bridge.
/// The UI releases the permit only after xterm has consumed the corresponding
/// frame. Cancellation unblocks a terminal even when its WebView disappears.
pub(crate) struct OutputFlow {
    credits: Arc<Semaphore>,
    outstanding: StdMutex<BTreeMap<u64, OwnedSemaphorePermit>>,
    next: AtomicU64,
    pub cancel: CancellationToken,
}
impl OutputFlow {
    pub fn new(cancel: CancellationToken) -> Self {
        Self {
            credits: Arc::new(Semaphore::new(OUTPUT_WINDOW)),
            outstanding: StdMutex::new(BTreeMap::new()),
            next: AtomicU64::new(1),
            cancel,
        }
    }
    pub fn ack(&self, sequence: u64) {
        if let Ok(mut pending) = self.outstanding.lock() {
            // Exact acknowledgement tolerates out-of-order IPC requests without
            // releasing frames which the terminal has not rendered yet.
            pending.remove(&sequence);
        }
    }
    pub async fn send(&self, session_id: &str, bytes: &[u8], sink: &EventSink) -> bool {
        for chunk in bytes.chunks(FRAME_SIZE) {
            let credit = tokio::select! {
                _ = self.cancel.cancelled() => return false,
                permit = self.credits.clone().acquire_owned() => match permit { Ok(p) => p, Err(_) => return false },
            };
            let sequence = self.next.fetch_add(1, Ordering::Relaxed);
            if let Ok(mut pending) = self.outstanding.lock() {
                pending.insert(sequence, credit);
            } else {
                return false;
            }
            sink(TerminalEvent::Data {
                session_id: session_id.into(),
                data: STANDARD.encode(chunk),
                sequence,
            });
        }
        true
    }
}

#[derive(Clone)]
pub(crate) struct RemoteRoute {
    pub host: String,
    pub port: u16,
    pub cancel: CancellationToken,
    pub connections: Arc<Semaphore>,
}
pub(crate) type RemoteRoutes = Arc<RwLock<HashMap<(String, u32), RemoteRoute>>>;

pub(crate) struct ClientHandler {
    expected: Option<String>,
    seen: Arc<StdMutex<Option<HostKeyInfo>>>,
    pub routes: RemoteRoutes,
    cancel: CancellationToken,
}
impl client::Handler for ClientHandler {
    type Error = russh::Error;
    async fn check_server_key(
        &mut self,
        key: &keys::PublicKeyOrCertificate,
    ) -> std::result::Result<bool, Self::Error> {
        let key = key.public_key();
        let info = HostKeyInfo {
            algorithm: key.algorithm().to_string(),
            fingerprint: key.fingerprint(keys::HashAlg::Sha256).to_string(),
        };
        let accepted = self.expected.as_deref() == Some(info.fingerprint.as_str());
        if let Ok(mut seen) = self.seen.lock() {
            *seen = Some(info);
        }
        Ok(accepted)
    }
    async fn disconnected(
        &mut self,
        _reason: client::DisconnectReason<Self::Error>,
    ) -> std::result::Result<(), Self::Error> {
        self.cancel.cancel();
        Ok(())
    }
    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: Channel<client::Msg>,
        connected_address: &str,
        connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> std::result::Result<(), Self::Error> {
        let route = self
            .routes
            .read()
            .await
            .get(&(connected_address.to_string(), connected_port))
            .cloned();
        if let Some(route) = route {
            let permit = route.connections.clone().try_acquire_owned();
            if let Ok(permit) = permit {
                tokio::spawn(async move {
                    let _permit = permit;
                    let connection = tokio::select! {
                        _ = route.cancel.cancelled() => { reply.reject(ChannelOpenFailure::AdministrativelyProhibited).await; return; },
                        result = timeout(Duration::from_secs(10), TcpStream::connect((route.host.as_str(), route.port))) => result,
                    };
                    match connection {
                        Ok(Ok(mut socket)) => {
                            reply.accept().await;
                            let mut stream = channel.into_stream();
                            tokio::select! {
                                _ = route.cancel.cancelled() => {},
                                _ = tokio::io::copy_bidirectional(&mut socket, &mut stream) => {},
                            }
                            let _ = stream.shutdown().await;
                        }
                        _ => reply.reject(ChannelOpenFailure::ConnectFailed).await,
                    }
                });
                return Ok(());
            }
        }
        reply
            .reject(ChannelOpenFailure::AdministrativelyProhibited)
            .await;
        Ok(())
    }
}

pub(crate) struct SshSession {
    pub transport: Arc<client::Handle<ClientHandler>>,
    terminal: Option<Arc<ChannelWriteHalf<client::Msg>>>,
    sftp: Mutex<Option<Arc<SftpSession>>>,
    pub routes: RemoteRoutes,
    pub cancel: CancellationToken,
    flow: Arc<OutputFlow>,
    host_id: String,
}
// An elevated file capability is deliberately not an SSH session ID. It
// cannot be used for terminals, command execution, monitoring or forwarding.
#[derive(Clone)]
struct SudoFileContext {
    owner_id: String,
    session: Arc<SshSession>,
    server_path: &'static str,
    cancel: CancellationToken,
    sftp: Arc<SftpSession>,
}

struct AuthRequest {
    prompts: usize,
    reply: oneshot::Sender<Vec<String>>,
}

#[derive(Clone, Default)]
pub struct SshManager {
    sessions: Arc<RwLock<HashMap<String, Arc<SshSession>>>>,
    challenges: Arc<Mutex<HashMap<String, AuthRequest>>>,
    sudo_files: Arc<RwLock<HashMap<String, SudoFileContext>>>,
}
impl SshManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn probe(&self, host: &Host) -> Result<HostKeyInfo> {
        self.probe_internal(host, None).await
    }
    pub async fn probe_via(&self, host: &Host, jump_session_id: &str) -> Result<HostKeyInfo> {
        self.probe_internal(host, Some(jump_session_id)).await
    }
    async fn probe_internal(&self, host: &Host, jump: Option<&str>) -> Result<HostKeyInfo> {
        let seen = Arc::new(StdMutex::new(None));
        let cancel = CancellationToken::new();
        let handler = ClientHandler {
            expected: None,
            seen: seen.clone(),
            routes: Arc::default(),
            cancel: cancel.clone(),
        };
        let result = timeout(connect_timeout(host), async {
            let socket = self.open_transport(host, jump).await?;
            client::connect_stream(config(host), socket, handler)
                .await
                .map_err(AppError::from)
        })
        .await;
        let captured = seen
            .lock()
            .map_err(|_| AppError::internal("Host key lock poisoned"))?
            .clone();
        cancel.cancel();
        if let Some(key) = captured {
            return Ok(key);
        }
        match result {
            Err(_) => Err(AppError::new(
                "CONNECT_TIMEOUT",
                "Connection timed out before receiving a host key",
            )),
            Ok(Err(error)) => Err(error),
            Ok(Ok(handle)) => {
                let _ = handle
                    .disconnect(Disconnect::ByApplication, "Key probe complete", "en")
                    .await;
                Err(AppError::new(
                    "HOST_KEY_MISSING",
                    "Server did not provide a host key",
                ))
            }
        }
    }

    pub async fn connect(
        &self,
        host: &Host,
        secret: SecretInput,
        expected_fingerprint: String,
        sink: EventSink,
    ) -> Result<String> {
        self.connect_internal(host, secret, expected_fingerprint, sink, None, true)
            .await
    }
    pub async fn connect_via(
        &self,
        host: &Host,
        secret: SecretInput,
        expected_fingerprint: String,
        sink: EventSink,
        jump_session_id: &str,
    ) -> Result<String> {
        self.connect_internal(
            host,
            secret,
            expected_fingerprint,
            sink,
            Some(jump_session_id),
            true,
        )
        .await
    }
    /// An authenticated SSH transport for jumps and file/command services.
    /// No shell or PTY is created, and terminal writes are explicitly rejected.
    pub async fn connect_service(
        &self,
        host: &Host,
        secret: SecretInput,
        expected_fingerprint: String,
        sink: EventSink,
    ) -> Result<String> {
        self.connect_internal(host, secret, expected_fingerprint, sink, None, false)
            .await
    }
    pub async fn connect_service_via(
        &self,
        host: &Host,
        secret: SecretInput,
        expected_fingerprint: String,
        sink: EventSink,
        jump_session_id: &str,
    ) -> Result<String> {
        self.connect_internal(
            host,
            secret,
            expected_fingerprint,
            sink,
            Some(jump_session_id),
            false,
        )
        .await
    }
    async fn connect_internal(
        &self,
        host: &Host,
        secret: SecretInput,
        expected: String,
        sink: EventSink,
        jump: Option<&str>,
        interactive: bool,
    ) -> Result<String> {
        if !expected.starts_with("SHA256:") {
            return Err(AppError::new(
                "HOST_UNTRUSTED",
                "An explicitly trusted SHA256 host fingerprint is required",
            ));
        }
        if host
            .startup_directory
            .as_deref()
            .is_some_and(|p| p.contains(['\0', '\r', '\n']) || p.len() > 4096)
        {
            return Err(AppError::new(
                "INVALID_PATH",
                "Startup directory is invalid",
            ));
        }
        let id = Uuid::new_v4().to_string();
        state(&sink, &id, "connecting", None);
        let seen = Arc::new(StdMutex::new(None));
        let cancel = CancellationToken::new();
        let routes: RemoteRoutes = Arc::default();
        let handler = ClientHandler {
            expected: Some(expected.clone()),
            seen: seen.clone(),
            routes: routes.clone(),
            cancel: cancel.clone(),
        };
        let connected = timeout(connect_timeout(host), async {
            let socket = self.open_transport(host, jump).await?;
            client::connect_stream(config(host), socket, handler)
                .await
                .map_err(AppError::from)
        })
        .await;
        let mut handle = match connected {
            Ok(Ok(handle)) => handle,
            error => {
                let changed = seen
                    .lock()
                    .ok()
                    .and_then(|s| s.clone())
                    .is_some_and(|s| s.fingerprint != expected);
                state(
                    &sink,
                    &id,
                    "failed",
                    Some(if changed {
                        "Host fingerprint changed; connection blocked"
                    } else {
                        "SSH connection failed"
                    }),
                );
                cancel.cancel();
                return if changed {
                    Err(AppError::new("HOST_KEY_CHANGED", "Server identity differs from the trusted fingerprint; no credentials were sent"))
                } else {
                    match error {
                        Err(_) => Err(AppError::new("CONNECT_TIMEOUT", "SSH handshake timed out")),
                        Ok(Err(e)) => Err(e),
                        _ => unreachable!(),
                    }
                };
            }
        };
        state(&sink, &id, "authenticating", None);
        if let Err(error) = self
            .authenticate(&mut handle, host, secret, &id, &sink)
            .await
        {
            let _ = handle
                .disconnect(Disconnect::ByApplication, "Authentication ended", "en")
                .await;
            cancel.cancel();
            state(&sink, &id, "failed", Some(&error.message));
            return Err(error);
        }
        let setup = timeout(Duration::from_secs(15), async {
            if !interactive {
                return Ok(None);
            }
            let mut channel = handle.channel_open_session().await?;
            channel
                .request_pty(true, "xterm-256color", 100, 30, 0, 0, &[])
                .await?;
            wait_success(&mut channel, "PTY request").await?;
            channel.request_shell(true).await?;
            wait_success(&mut channel, "Shell request").await?;
            Ok::<_, AppError>(Some(channel))
        })
        .await;
        let channel = match setup {
            Ok(Ok(channel)) => channel,
            failure => {
                let _ = handle
                    .disconnect(Disconnect::ByApplication, "Terminal setup failed", "en")
                    .await;
                cancel.cancel();
                state(
                    &sink,
                    &id,
                    "failed",
                    Some("Remote terminal could not be opened"),
                );
                return match failure {
                    Err(_) => Err(AppError::new(
                        "CHANNEL_TIMEOUT",
                        "Remote terminal setup timed out",
                    )),
                    Ok(Err(e)) => Err(e),
                    _ => unreachable!(),
                };
            }
        };
        let (reader, writer) = if let Some(channel) = channel {
            let (r, w) = channel.split();
            (Some(r), Some(Arc::new(w)))
        } else {
            (None, None)
        };
        let flow = Arc::new(OutputFlow::new(cancel.clone()));
        let session = Arc::new(SshSession {
            transport: Arc::new(handle),
            terminal: writer,
            sftp: Mutex::new(None),
            routes,
            cancel: cancel.clone(),
            flow: flow.clone(),
            host_id: host.id.clone(),
        });
        self.sessions
            .write()
            .await
            .insert(id.clone(), session.clone());
        state(&sink, &id, "connected", None);
        let sessions = self.sessions.clone();
        let task_id = id.clone();
        let task_session = session.clone();
        let task_sink = sink.clone();
        tokio::spawn(async move {
            let mut exit_code = None;
            if let Some(mut reader) = reader {
                loop {
                    let msg = tokio::select! { _ = cancel.cancelled() => break, msg = reader.wait() => msg };
                    match msg {
                        Some(ChannelMsg::Data { data })
                        | Some(ChannelMsg::ExtendedData { data, .. }) => {
                            if !flow.send(&task_id, &data, &task_sink).await {
                                break;
                            }
                        }
                        Some(ChannelMsg::ExitStatus { exit_status }) => {
                            exit_code = Some(exit_status)
                        }
                        Some(ChannelMsg::Close) | None => break,
                        _ => {}
                    }
                }
            } else {
                // The handler cancels this token when the underlying transport
                // is disconnected. Service sessions have no fake terminal.
                cancel.cancelled().await;
            }
            cancel.cancel();
            task_sink(TerminalEvent::Exit {
                session_id: task_id.clone(),
                code: exit_code,
            });
            state(
                &task_sink,
                &task_id,
                "disconnected",
                Some("The SSH session ended; reconnect starts a new remote shell"),
            );
            let _ = task_session
                .transport
                .disconnect(Disconnect::ByApplication, "Terminal closed", "en")
                .await;
            sessions.write().await.remove(&task_id);
        });
        if let Some(directory) = host
            .startup_directory
            .as_deref()
            .filter(|p| interactive && !p.is_empty())
        {
            // Shell argument is quoted; no untrusted command interpolation.
            if let Err(error) = self
                .write(
                    &id,
                    format!("cd -- {}\n", shell_quote(directory)).as_bytes(),
                )
                .await
            {
                let _ = self.disconnect(&id).await;
                return Err(error);
            }
        }
        Ok(id)
    }

    async fn authenticate(
        &self,
        handle: &mut client::Handle<ClientHandler>,
        host: &Host,
        secret: SecretInput,
        id: &str,
        sink: &EventSink,
    ) -> Result<()> {
        let result = match host.auth_method.as_str() {
            "password" => {
                let password = secret.password.as_ref().ok_or_else(|| {
                    AppError::new("CREDENTIAL_REQUIRED", "Enter the SSH password")
                })?;
                timeout(
                    Duration::from_secs(60),
                    handle.authenticate_password(&host.username, password.as_str()),
                )
                .await
                .map_err(|_| AppError::new("AUTH_TIMEOUT", "Password authentication timed out"))??
            }
            "key" => {
                let path = host
                    .private_key_path
                    .as_ref()
                    .ok_or_else(|| AppError::new("KEY_REQUIRED", "Select a private key"))?;
                let path = expand_home(path);
                let key_secret = secret.clone();
                let key = tokio::task::spawn_blocking(move || {
                    if std::fs::metadata(&path)?.len() > 4 * 1024 * 1024 {
                        return Err(AppError::new(
                            "KEY_TOO_LARGE",
                            "Private key file exceeds 4 MiB",
                        ));
                    }
                    keys::load_secret_key(path, key_secret.passphrase.as_deref())
                        .map_err(|e| AppError::new("KEY_ERROR", e.to_string()))
                })
                .await
                .map_err(AppError::internal)??;
                let hash = handle.best_supported_rsa_hash().await?.flatten();
                timeout(
                    Duration::from_secs(60),
                    handle.authenticate_publickey(
                        &host.username,
                        keys::PrivateKeyWithHashAlg::new(Arc::new(key), hash),
                    ),
                )
                .await
                .map_err(|_| AppError::new("AUTH_TIMEOUT", "Key authentication timed out"))??
            }
            "agent" => {
                return timeout(
                    Duration::from_secs(120),
                    self.authenticate_agent(handle, &host.username, id, sink),
                )
                .await
                .map_err(|_| AppError::new("AUTH_TIMEOUT", "SSH Agent authentication timed out"))?
            }
            "interactive" => {
                return self
                    .authenticate_interactive(handle, &host.username, id, sink)
                    .await
            }
            _ => {
                return Err(AppError::new(
                    "AUTH_METHOD",
                    "Unknown authentication method",
                ))
            }
        };
        match result {
            client::AuthResult::Success => Ok(()),
            client::AuthResult::Failure {
                partial_success: true,
                ..
            } => {
                self.authenticate_interactive(handle, &host.username, id, sink)
                    .await
            }
            _ => Err(AppError::new(
                "AUTH_REJECTED",
                "The server rejected the supplied credentials",
            )),
        }
    }

    async fn authenticate_interactive(
        &self,
        handle: &mut client::Handle<ClientHandler>,
        username: &str,
        session_id: &str,
        sink: &EventSink,
    ) -> Result<()> {
        let mut response = timeout(
            Duration::from_secs(30),
            handle.authenticate_keyboard_interactive_start(username, None),
        )
        .await
        .map_err(|_| {
            AppError::new("AUTH_TIMEOUT", "Interactive authentication did not respond")
        })??;
        for _ in 0..8 {
            match response {
                client::KeyboardInteractiveAuthResponse::Success => return Ok(()),
                client::KeyboardInteractiveAuthResponse::Failure { .. } => {
                    return Err(AppError::new(
                        "AUTH_REJECTED",
                        "Interactive authentication was rejected",
                    ))
                }
                client::KeyboardInteractiveAuthResponse::InfoRequest {
                    name,
                    instructions,
                    prompts,
                } => {
                    if prompts.len() > 16
                        || name.len()
                            + instructions.len()
                            + prompts.iter().map(|p| p.prompt.len()).sum::<usize>()
                            > 32768
                    {
                        return Err(AppError::new(
                            "AUTH_PROTOCOL",
                            "Server authentication challenge exceeds the safety limit",
                        ));
                    }
                    let answers = if prompts.is_empty() {
                        Vec::new()
                    } else {
                        let request_id = Uuid::new_v4().to_string();
                        let (reply, receive) = oneshot::channel();
                        self.challenges.lock().await.insert(
                            request_id.clone(),
                            AuthRequest {
                                prompts: prompts.len(),
                                reply,
                            },
                        );
                        sink(TerminalEvent::Auth {
                            session_id: session_id.into(),
                            request_id: request_id.clone(),
                            name,
                            instructions,
                            prompts: prompts
                                .into_iter()
                                .map(|p| AuthPrompt {
                                    prompt: p.prompt,
                                    echo: p.echo,
                                })
                                .collect(),
                        });
                        let answer = timeout(Duration::from_secs(120), receive).await;
                        self.challenges.lock().await.remove(&request_id);
                        answer
                            .map_err(|_| {
                                AppError::new("AUTH_TIMEOUT", "Authentication prompt expired")
                            })?
                            .map_err(|_| {
                                AppError::new("AUTH_CANCELLED", "Authentication was cancelled")
                            })?
                    };
                    response = timeout(
                        Duration::from_secs(30),
                        handle.authenticate_keyboard_interactive_respond(answers),
                    )
                    .await
                    .map_err(|_| {
                        AppError::new("AUTH_TIMEOUT", "Server did not respond to authentication")
                    })??;
                }
            }
        }
        Err(AppError::new(
            "AUTH_ROUNDS",
            "Too many authentication rounds",
        ))
    }
    async fn authenticate_agent(
        &self,
        handle: &mut client::Handle<ClientHandler>,
        username: &str,
        id: &str,
        sink: &EventSink,
    ) -> Result<()> {
        #[cfg(unix)]
        let mut agent = keys::agent::client::AgentClient::connect_env()
            .await
            .map_err(|e| AppError::new("AGENT_ERROR", e.to_string()))?;
        #[cfg(windows)]
        let mut agent =
            keys::agent::client::AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent")
                .await
                .map_err(|e| AppError::new("AGENT_ERROR", e.to_string()))?;
        if let Some(binding) = handle.agent_session_binding() {
            match agent.bind_session(binding, false).await {
                Ok(()) | Err(keys::Error::AgentFailure) => {} // Older agents lack session-bind.
                Err(e) => return Err(AppError::new("AGENT_ERROR", e.to_string())),
            }
        }
        let identities = agent
            .request_identities()
            .await
            .map_err(|e| AppError::new("AGENT_ERROR", e.to_string()))?;
        let hash = handle.best_supported_rsa_hash().await?.flatten();
        for identity in identities.into_iter().take(6) {
            let result = match identity {
                keys::agent::AgentIdentity::PublicKey { key, .. } => {
                    handle
                        .authenticate_publickey_with(username, key, hash, &mut agent)
                        .await
                }
                keys::agent::AgentIdentity::Certificate { certificate, .. } => {
                    handle
                        .authenticate_certificate_with(username, certificate, hash, &mut agent)
                        .await
                }
            }
            .map_err(|e| AppError::new("AGENT_ERROR", e.to_string()))?;
            match result {
                client::AuthResult::Success => return Ok(()),
                client::AuthResult::Failure {
                    partial_success: true,
                    ..
                } => {
                    return self
                        .authenticate_interactive(handle, username, id, sink)
                        .await
                }
                _ => {}
            }
        }
        Err(AppError::new(
            "AGENT_REJECTED",
            "No accepted SSH Agent identity was found among the first six keys",
        ))
    }
    pub async fn auth_respond(&self, request_id: &str, responses: Vec<String>) -> Result<()> {
        let request = self
            .challenges
            .lock()
            .await
            .remove(request_id)
            .ok_or_else(|| {
                AppError::new("AUTH_EXPIRED", "Authentication request is no longer active")
            })?;
        if responses.len() != request.prompts || responses.iter().any(|r| r.len() > 16384) {
            return Err(AppError::new(
                "AUTH_CANCELLED",
                "Authentication cancelled or response count does not match the prompts",
            ));
        }
        request
            .reply
            .send(responses)
            .map_err(|_| AppError::new("AUTH_EXPIRED", "Authentication request expired"))
    }

    pub async fn write(&self, id: &str, data: &[u8]) -> Result<()> {
        if data.len() > 1024 * 1024 {
            return Err(AppError::new(
                "INPUT_TOO_LARGE",
                "Terminal input exceeds 1 MiB per request",
            ));
        }
        let session = self.session(id).await?;
        let terminal = session.terminal.as_ref().ok_or_else(|| {
            AppError::new(
                "NO_TERMINAL",
                "This connection is a service transport without a terminal",
            )
        })?;
        timeout(Duration::from_secs(15), terminal.data(data))
            .await
            .map_err(|_| AppError::new("WRITE_TIMEOUT", "Terminal input timed out"))??;
        Ok(())
    }
    pub async fn resize(&self, id: &str, cols: u32, rows: u32) -> Result<()> {
        validate_size(cols, rows)?;
        let session = self.session(id).await?;
        session
            .terminal
            .as_ref()
            .ok_or_else(|| AppError::new("NO_TERMINAL", "This connection has no terminal"))?
            .window_change(cols, rows, 0, 0)
            .await?;
        Ok(())
    }
    pub async fn ack(&self, id: &str, sequence: u64) -> Result<()> {
        if let Some(session) = self.sessions.read().await.get(id) {
            session.flow.ack(sequence);
        }
        Ok(())
    }
    pub async fn disconnect(&self, id: &str) -> Result<()> {
        if let Some(session) = self.sessions.write().await.remove(id) {
            session.cancel.cancel();
            if let Some(terminal) = session.terminal.as_ref() {
                let _ = timeout(Duration::from_secs(2), terminal.close()).await;
            }
            let _ = timeout(
                Duration::from_secs(2),
                session
                    .transport
                    .disconnect(Disconnect::ByApplication, "Closed by user", "en"),
            )
            .await;
        }
        Ok(())
    }
    pub async fn close_all(&self) {
        let ids: Vec<_> = self.sessions.read().await.keys().cloned().collect();
        for id in ids {
            let _ = self.disconnect(&id).await;
        }
        self.challenges.lock().await.clear();
    }
    pub async fn get_by_host(&self, host_id: &str) -> Option<String> {
        self.sessions
            .read()
            .await
            .iter()
            .find(|(_, s)| {
                s.host_id == host_id && !s.cancel.is_cancelled() && !s.transport.is_closed()
            })
            .map(|(id, _)| id.clone())
    }
    pub(crate) async fn session(&self, id: &str) -> Result<Arc<SshSession>> {
        let session = self
            .sessions
            .read()
            .await
            .get(id)
            .cloned()
            .ok_or_else(|| AppError::new("SESSION_CLOSED", "SSH session is not connected"))?;
        if session.cancel.is_cancelled() || session.transport.is_closed() {
            return Err(AppError::new("SESSION_CLOSED", "SSH session has ended"));
        }
        Ok(session)
    }
    pub async fn exec(&self, id: &str, command: &str) -> Result<ExecOutput> {
        self.exec_with_timeout(id, command, Duration::from_secs(30))
            .await
    }

    pub(crate) async fn exec_with_timeout(
        &self,
        id: &str,
        command: &str,
        deadline: Duration,
    ) -> Result<ExecOutput> {
        if command.len() > 65536 || command.contains('\0') {
            return Err(AppError::new(
                "COMMAND_INVALID",
                "Command exceeds the size limit or contains a NUL",
            ));
        }
        let session = self.session(id).await?;
        let mut channel = timeout(
            Duration::from_secs(10),
            session.transport.channel_open_session(),
        )
        .await
        .map_err(|_| AppError::new("EXEC_TIMEOUT", "Command channel timed out"))??;
        let operation = async {
            channel.exec(true, command.as_bytes().to_vec()).await?;
            let (mut stdout, mut stderr, mut status) = (Vec::new(), Vec::new(), None);
            loop {
                let message = tokio::select! { _ = session.cancel.cancelled() => return Err(AppError::new("SESSION_CLOSED", "SSH session ended")), msg = channel.wait() => msg };
                match message {
                    Some(ChannelMsg::Data { data }) => stdout.extend_from_slice(&data),
                    Some(ChannelMsg::ExtendedData { data, .. }) => stderr.extend_from_slice(&data),
                    Some(ChannelMsg::ExitStatus { exit_status }) => status = Some(exit_status),
                    Some(ChannelMsg::Failure) => {
                        return Err(AppError::new(
                            "EXEC_REJECTED",
                            "The server rejected the command request",
                        ))
                    }
                    Some(ChannelMsg::Close) | None => break,
                    _ => {}
                }
                if stdout.len() + stderr.len() > EXEC_LIMIT {
                    return Err(AppError::new("OUTPUT_LIMIT", "Command output exceeded 2 MiB; use an interactive terminal for streaming output"));
                }
            }
            Ok(ExecOutput {
                stdout: String::from_utf8_lossy(&stdout).into_owned(),
                stderr: String::from_utf8_lossy(&stderr).into_owned(),
                status: status.ok_or_else(|| {
                    AppError::new(
                        "EXEC_INCOMPLETE",
                        "The command channel closed without an exit status",
                    )
                })?,
            })
        };
        let result = timeout(deadline, operation).await.map_err(|_| {
            AppError::new(
                "EXEC_TIMEOUT",
                format!(
                    "Command exceeded the {} second deadline",
                    deadline.as_secs()
                ),
            )
        });
        let _ = channel.close().await;
        result?
    }
    /// Open a distinct, revocable SFTP capability using the server's existing
    /// non-interactive sudo policy. No password or sudoers change is attempted.
    pub async fn sudo_files_enable(&self, id: &str) -> Result<String> {
        let session = self.session(id).await?;
        const PATHS: [&str; 3] = [
            "/usr/lib/openssh/sftp-server",
            "/usr/libexec/openssh/sftp-server",
            "/usr/lib/ssh/sftp-server",
        ];
        let probe = self
            .exec(
                id,
                "for p in /usr/lib/openssh/sftp-server /usr/libexec/openssh/sftp-server /usr/lib/ssh/sftp-server; do if [ -x \"$p\" ]; then printf '%s\\n' \"$p\"; exit 0; fi; done; exit 1",
            )
            .await?;
        let server_path = PATHS
            .into_iter()
            .find(|path| probe.status == 0 && probe.stdout.trim() == *path)
            .ok_or_else(|| {
                AppError::new(
                    "SUDO_SFTP_SERVER_MISSING",
                    "OpenSSH sftp-server was not found at a supported path",
                )
            })?;
        let cancel = session.cancel.child_token();
        let initialized = timeout(Duration::from_secs(20), async {
            let stream =
                open_elevated_sftp_stream(&session, server_path, cancel.clone(), true).await?;
            SftpSession::new(stream).await.map_err(|_| {
                AppError::new(
                    "SUDO_SFTP_DENIED",
                    "The server did not allow non-interactive sudo SFTP. Password-based sudo is not supported yet.",
                )
            })
        })
        .await;
        let sftp = match initialized {
            Ok(Ok(sftp)) => Arc::new(sftp),
            Ok(Err(error)) => {
                cancel.cancel();
                return Err(error);
            }
            Err(_) => {
                cancel.cancel();
                return Err(AppError::new(
                    "SUDO_SFTP_TIMEOUT",
                    "Elevated SFTP initialization timed out",
                ));
            }
        };
        sftp.set_timeout(30);
        let context_id = Uuid::new_v4().to_string();
        {
            let mut contexts = self.sudo_files.write().await;
            if cancel.is_cancelled() {
                return Err(AppError::new("SESSION_CLOSED", "SSH session has ended"));
            }
            if contexts
                .values()
                .any(|c| c.owner_id == id && !c.cancel.is_cancelled())
            {
                cancel.cancel();
                return Err(AppError::new(
                    "SUDO_SFTP_ALREADY_ACTIVE",
                    "An elevated file context is already active for this session",
                ));
            }
            contexts.insert(
                context_id.clone(),
                SudoFileContext {
                    owner_id: id.to_owned(),
                    session,
                    server_path,
                    cancel: cancel.clone(),
                    sftp,
                },
            );
        }
        let contexts = Arc::downgrade(&self.sudo_files);
        let cleanup_id = context_id.clone();
        tokio::spawn(async move {
            cancel.cancelled().await;
            if let Some(contexts) = contexts.upgrade() {
                contexts.write().await.remove(&cleanup_id);
            }
        });
        Ok(context_id)
    }

    pub async fn sudo_files_disable(&self, owner_id: &str, context_id: &str) -> Result<()> {
        let mut contexts = self.sudo_files.write().await;
        if let Some(context) = contexts.get(context_id) {
            if context.owner_id != owner_id {
                return Err(AppError::new(
                    "SUDO_SFTP_OWNER_MISMATCH",
                    "The elevated file context belongs to a different SSH session",
                ));
            }
        }
        if let Some(context) = contexts.remove(context_id) {
            context.cancel.cancel();
        }
        Ok(())
    }

    // Transfers are not yet exposed to privileged capabilities. They may
    // outlive a file panel, so revocation and cleanup need a separate design.
    pub(crate) async fn require_transfer_session(&self, id: &str) -> Result<()> {
        if self.sudo_files.read().await.contains_key(id) {
            return Err(AppError::new(
                "SUDO_TRANSFER_UNAVAILABLE",
                "File transfers are not available in sudo mode",
            ));
        }
        self.session(id).await?;
        Ok(())
    }

    pub async fn sftp(&self, id: &str) -> Result<Arc<SftpSession>> {
        if let Some(context) = self.sudo_files.read().await.get(id).cloned() {
            if context.cancel.is_cancelled() {
                return Err(AppError::new("SESSION_CLOSED", "Elevated SFTP has ended"));
            }
            return Ok(context.sftp);
        }
        let session = self.session(id).await?;
        let mut cached = session.sftp.lock().await;
        if let Some(sftp) = cached.as_ref() {
            return Ok(sftp.clone());
        }
        let sftp = timeout(Duration::from_secs(15), async {
            let mut channel = session.transport.channel_open_session().await?;
            channel.request_subsystem(true, "sftp").await?;
            wait_success(&mut channel, "SFTP subsystem").await?;
            let sftp = SftpSession::new(channel.into_stream())
                .await
                .map_err(|e| AppError::new("SFTP_ERROR", e.to_string()))?;
            sftp.set_timeout(30);
            Ok::<_, AppError>(Arc::new(sftp))
        })
        .await
        .map_err(|_| AppError::new("SFTP_TIMEOUT", "SFTP initialization timed out"))??;
        *cached = Some(sftp.clone());
        Ok(sftp)
    }
    /// A dedicated uninitialized raw subsystem for negotiated SFTP extensions.
    pub async fn sftp_raw(&self, id: &str) -> Result<RawSftpSession> {
        if let Some(context) = self.sudo_files.read().await.get(id).cloned() {
            let stream = open_elevated_sftp_stream(
                &context.session,
                context.server_path,
                context.cancel,
                false,
            )
            .await?;
            return Ok(RawSftpSession::new(stream));
        }
        let session = self.session(id).await?;
        timeout(Duration::from_secs(15), async {
            let mut channel = session.transport.channel_open_session().await?;
            channel.request_subsystem(true, "sftp").await?;
            wait_success(&mut channel, "SFTP subsystem").await?;
            Ok(RawSftpSession::new(channel.into_stream()))
        })
        .await
        .map_err(|_| AppError::new("SFTP_TIMEOUT", "SFTP channel timed out"))?
    }
    pub(crate) async fn direct(
        &self,
        id: &str,
        host: &str,
        port: u16,
    ) -> Result<Channel<client::Msg>> {
        validate_address(host)?;
        let session = self.session(id).await?;
        timeout(
            Duration::from_secs(15),
            session
                .transport
                .channel_open_direct_tcpip(host, port as u32, "127.0.0.1", 0),
        )
        .await
        .map_err(|_| AppError::new("TUNNEL_TIMEOUT", "Forwarded channel timed out"))?
        .map_err(AppError::from)
    }
    async fn open_transport(&self, host: &Host, jump: Option<&str>) -> Result<Box<dyn SshIo>> {
        validate_address(&host.address)?;
        if host.port == 0 {
            return Err(AppError::new(
                "INVALID_PORT",
                "SSH port must be between 1 and 65535",
            ));
        }
        if let Some(id) = jump {
            if host.proxy.is_some() {
                return Err(AppError::new(
                    "NETWORK_CONFLICT",
                    "Choose a jump host or a proxy, not both on the same target",
                ));
            }
            return Ok(Box::new(
                self.direct(id, &host.address, host.port)
                    .await?
                    .into_stream(),
            ));
        }
        if host.jump_host_id.is_some() {
            return Err(AppError::new(
                "JUMP_REQUIRED",
                "Connect the configured jump host before this host",
            ));
        }
        let Some(proxy) = &host.proxy else {
            let socket = TcpStream::connect((host.address.as_str(), host.port)).await?;
            socket.set_nodelay(true)?;
            return Ok(Box::new(socket));
        };
        validate_address(&proxy.host)?;
        if proxy.port == 0 {
            return Err(AppError::new("INVALID_PORT", "Proxy port must be nonzero"));
        }
        let mut socket = TcpStream::connect((proxy.host.as_str(), proxy.port)).await?;
        socket.set_nodelay(true)?;
        match proxy.kind.as_str() {
            "socks5" => socks_connect(&mut socket, &host.address, host.port).await?,
            "http" => http_connect(&mut socket, &host.address, host.port).await?,
            _ => return Err(AppError::new("PROXY_KIND", "Unsupported proxy type")),
        }
        Ok(Box::new(socket))
    }
}

fn config(host: &Host) -> Arc<client::Config> {
    Arc::new(client::Config {
        keepalive_interval: (host.keep_alive_seconds > 0)
            .then(|| Duration::from_secs(host.keep_alive_seconds.clamp(5, 600) as u64)),
        keepalive_max: 3,
        channel_buffer_size: 32,
        window_size: 1024 * 1024,
        nodelay: true,
        ..Default::default()
    })
}
fn connect_timeout(host: &Host) -> Duration {
    Duration::from_secs(host.connect_timeout_seconds.clamp(3, 120) as u64)
}
pub(crate) fn validate_size(cols: u32, rows: u32) -> Result<()> {
    if !(2..=1000).contains(&cols) || !(1..=1000).contains(&rows) {
        return Err(AppError::new(
            "INVALID_SIZE",
            "Terminal size is outside the supported range",
        ));
    }
    Ok(())
}
pub(crate) fn validate_address(address: &str) -> Result<()> {
    if address.is_empty()
        || address.len() > 255
        || address
            .chars()
            .any(|c| c.is_whitespace() || c.is_control() || matches!(c, '/' | '\\'))
    {
        return Err(AppError::new(
            "INVALID_ADDRESS",
            "Invalid hostname or IP address",
        ));
    }
    Ok(())
}
fn state(sink: &EventSink, id: &str, value: &str, message: Option<&str>) {
    sink(TerminalEvent::State {
        session_id: id.into(),
        state: value.into(),
        message: message.map(str::to_string),
    });
}
pub(crate) fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
fn expand_home(path: &str) -> std::path::PathBuf {
    if let Some(relative) = path.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(relative);
        }
    }
    path.into()
}
// Pump binary SFTP data without a PTY. Keep the channel write half so every
// primary or atomic-rename channel can be closed on capability revocation.
async fn open_elevated_sftp_stream(
    session: &SshSession,
    server_path: &'static str,
    cancel: CancellationToken,
    primary: bool,
) -> Result<tokio::io::DuplexStream> {
    let mut channel = timeout(
        Duration::from_secs(10),
        session.transport.channel_open_session(),
    )
    .await
    .map_err(|_| AppError::new("SUDO_SFTP_TIMEOUT", "Elevated SFTP channel timed out"))??;
    let setup = timeout(Duration::from_secs(10), async {
        // server_path is selected exclusively from a fixed absolute allowlist.
        channel
            .exec(
                true,
                format!("sudo -n -u root -- {server_path}").into_bytes(),
            )
            .await?;
        wait_success(&mut channel, "sudo SFTP command").await
    })
    .await;
    if !matches!(setup, Ok(Ok(()))) || cancel.is_cancelled() {
        let _ = timeout(Duration::from_secs(2), channel.close()).await;
        return Err(AppError::new(
            "SUDO_SFTP_DENIED",
            "The server did not allow non-interactive sudo SFTP. Password-based sudo is not supported yet.",
        ));
    }
    let (mut reader, writer) = channel.split();
    let (local, bridge) = tokio::io::duplex(64 * 1024);
    let (mut input, mut output) = tokio::io::split(bridge);
    tokio::spawn(async move {
        let send = async {
            let mut buf = [0_u8; 16 * 1024];
            while let Ok(n) = input.read(&mut buf).await {
                if n == 0 || writer.data(&buf[..n]).await.is_err() {
                    break;
                }
            }
        };
        let receive = async {
            while let Some(message) = reader.wait().await {
                match message {
                    ChannelMsg::Data { data } => {
                        if output.write_all(&data).await.is_err() {
                            break;
                        }
                    }
                    ChannelMsg::Close | ChannelMsg::Eof | ChannelMsg::ExitStatus { .. } => break,
                    // stderr is not part of the binary SFTP protocol.
                    _ => {}
                }
            }
        };
        tokio::select! {
            biased;
            _ = cancel.cancelled() => {}
            _ = send => {}
            _ = receive => {}
        }
        if primary {
            cancel.cancel();
        }
        drop(input);
        drop(output);
        let _ = timeout(Duration::from_secs(2), writer.close()).await;
    });
    Ok(local)
}

async fn wait_success(channel: &mut Channel<client::Msg>, what: &str) -> Result<()> {
    while let Some(message) = channel.wait().await {
        match message {
            ChannelMsg::Success => return Ok(()),
            ChannelMsg::Failure | ChannelMsg::Close | ChannelMsg::Eof => {
                return Err(AppError::new(
                    "CHANNEL_REJECTED",
                    format!("Server rejected {what}"),
                ))
            }
            _ => {}
        }
    }
    Err(AppError::new(
        "CHANNEL_CLOSED",
        format!("Connection closed during {what}"),
    ))
}
async fn socks_connect(socket: &mut TcpStream, address: &str, port: u16) -> Result<()> {
    socket.write_all(&[5, 1, 0]).await?;
    let mut greeting = [0; 2];
    socket.read_exact(&mut greeting).await?;
    if greeting != [5, 0] {
        return Err(AppError::new(
            "PROXY_AUTH",
            "SOCKS5 proxy requires unsupported authentication",
        ));
    }
    let mut request = vec![5, 1, 0];
    match address.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V4(ip)) => {
            request.push(1);
            request.extend(ip.octets());
        }
        Ok(std::net::IpAddr::V6(ip)) => {
            request.push(4);
            request.extend(ip.octets());
        }
        Err(_) => {
            request.extend([3, address.len() as u8]);
            request.extend(address.as_bytes());
        }
    }
    request.extend(port.to_be_bytes());
    socket.write_all(&request).await?;
    let mut response = [0; 4];
    socket.read_exact(&mut response).await?;
    if response[0] != 5 || response[1] != 0 || response[2] != 0 {
        return Err(AppError::new(
            "PROXY_CONNECT",
            format!("SOCKS5 proxy rejected connection (code {})", response[1]),
        ));
    }
    let length = match response[3] {
        1 => 4,
        4 => 16,
        3 => socket.read_u8().await? as usize,
        _ => {
            return Err(AppError::new(
                "PROXY_PROTOCOL",
                "Invalid SOCKS5 address type",
            ))
        }
    };
    let mut tail = vec![0; length + 2];
    socket.read_exact(&mut tail).await?;
    Ok(())
}
async fn http_connect(socket: &mut TcpStream, address: &str, port: u16) -> Result<()> {
    let authority = if address.contains(':') {
        format!("[{address}]:{port}")
    } else {
        format!("{address}:{port}")
    };
    socket
        .write_all(format!("CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\n\r\n").as_bytes())
        .await?;
    let mut response = Vec::with_capacity(1024);
    // Read only the CONNECT header, leaving coalesced SSH bytes in the socket.
    while !response.ends_with(b"\r\n\r\n") {
        if response.len() >= 16384 {
            return Err(AppError::new(
                "PROXY_PROTOCOL",
                "HTTP CONNECT response headers exceed 16 KiB",
            ));
        }
        response.push(socket.read_u8().await?);
    }
    let line = String::from_utf8_lossy(&response);
    let mut parts = line.lines().next().unwrap_or("").split_whitespace();
    let protocol = parts.next().unwrap_or("");
    let status = parts.next().unwrap_or("");
    if !matches!(protocol, "HTTP/1.0" | "HTTP/1.1") || status != "200" {
        return Err(AppError::new(
            "PROXY_CONNECT",
            format!("HTTP CONNECT rejected ({status})"),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shell_arguments_and_proxy_authorities_cannot_inject_commands() {
        assert_eq!(shell_quote("/a'b;$(id)"), "'/a'\\''b;$(id)'");
        assert!(validate_address("host\r\nX: yes").is_err());
        assert!(validate_address("host/path").is_err());
        assert!(validate_address("::1").is_ok());
    }
    #[tokio::test]
    async fn terminal_acknowledgement_bounds_the_output_queue() {
        let flow = Arc::new(OutputFlow::new(CancellationToken::new()));
        let frames = Arc::new(StdMutex::new(Vec::new()));
        let output = frames.clone();
        let sink: EventSink = Arc::new(move |event| {
            if let TerminalEvent::Data { sequence, .. } = event {
                output.lock().unwrap().push(sequence);
            }
        });
        assert!(
            flow.send("test", &vec![42; FRAME_SIZE * OUTPUT_WINDOW], &sink)
                .await
        );
        assert_eq!(frames.lock().unwrap().len(), OUTPUT_WINDOW);
        assert!(timeout(
            Duration::from_millis(20),
            flow.send("test", b"blocked", &sink)
        )
        .await
        .is_err());
        flow.ack(1);
        assert!(flow.send("test", b"released", &sink).await);
        flow.cancel.cancel();
        assert!(!flow.send("test", b"cancelled", &sink).await);
    }
}
