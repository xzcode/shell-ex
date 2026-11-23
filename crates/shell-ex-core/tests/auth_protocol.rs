//! Protocol-level tests against an in-process SSH server. The server implements
//! a deliberate byte-echo PTY fixture; it is not a claim of OpenSSH PTY coverage.
#![cfg(unix)]
use base64::{engine::general_purpose::STANDARD, Engine};
use russh::{
    server::{self, Server as _},
    Channel, ChannelId, Pty,
};
use shell_ex_core::{
    models::{EventSink, Host, SecretInput, TerminalEvent},
    ssh::SshManager,
};
use std::{
    borrow::Cow,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::{net::TcpListener, time::timeout};

#[derive(Clone)]
struct Fixture {
    auth_calls: Arc<AtomicUsize>,
}
impl server::Server for Fixture {
    type Handler = Self;
    fn new_client(&mut self, _: Option<std::net::SocketAddr>) -> Self {
        self.clone()
    }
}
impl server::Handler for Fixture {
    type Error = russh::Error;
    async fn auth_password(
        &mut self,
        user: &str,
        password: &str,
    ) -> Result<server::Auth, Self::Error> {
        self.auth_calls.fetch_add(1, Ordering::Relaxed);
        Ok(if user == "fixture" && password == "test-only-password" {
            server::Auth::Accept
        } else {
            server::Auth::reject()
        })
    }
    async fn auth_keyboard_interactive<'a>(
        &'a mut self,
        _: &str,
        _: &str,
        response: Option<server::Response<'a>>,
    ) -> Result<server::Auth, Self::Error> {
        self.auth_calls.fetch_add(1, Ordering::Relaxed);
        if let Some(mut response) = response {
            let a = response.next();
            let b = response.next();
            Ok(
                if a.as_deref() == Some(b"123456") && b.as_deref() == Some(b"fixture-label") {
                    server::Auth::Accept
                } else {
                    server::Auth::reject()
                },
            )
        } else {
            Ok(server::Auth::Partial {
                name: Cow::Borrowed("Fixture challenge"),
                instructions: Cow::Borrowed("Respond to both fields"),
                prompts: Cow::Owned(vec![
                    (Cow::Borrowed("Code:"), false),
                    (Cow::Borrowed("Label:"), true),
                ]),
            })
        }
    }
    async fn channel_open_session(
        &mut self,
        _: Channel<server::Msg>,
        reply: server::ChannelOpenHandle,
        _: &mut server::Session,
    ) -> Result<(), Self::Error> {
        reply.accept().await;
        Ok(())
    }
    async fn pty_request(
        &mut self,
        channel: ChannelId,
        _: &str,
        cols: u32,
        rows: u32,
        _: u32,
        _: u32,
        _: &[(Pty, u32)],
        session: &mut server::Session,
    ) -> Result<(), Self::Error> {
        assert_eq!((cols, rows), (100, 30));
        session.channel_success(channel)?;
        Ok(())
    }
    async fn shell_request(
        &mut self,
        channel: ChannelId,
        session: &mut server::Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        Ok(())
    }
    async fn data(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut server::Session,
    ) -> Result<(), Self::Error> {
        session.data(channel, data.to_vec())?;
        Ok(())
    }
    async fn window_change_request(
        &mut self,
        channel: ChannelId,
        cols: u32,
        rows: u32,
        _: u32,
        _: u32,
        session: &mut server::Session,
    ) -> Result<(), Self::Error> {
        session.data(channel, format!("RESIZE:{cols}:{rows}").into_bytes())?;
        Ok(())
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn password_interactive_fingerprint_and_terminal_protocol() {
    let temporary = tempfile::tempdir().unwrap();
    let key_path = temporary.path().join("hostkey");
    assert!(std::process::Command::new("ssh-keygen")
        .args(["-q", "-t", "ed25519", "-N", "", "-f"])
        .arg(&key_path)
        .status()
        .unwrap()
        .success());
    let config = Arc::new(server::Config {
        keys: vec![russh::keys::load_secret_key(key_path, None).unwrap()],
        auth_rejection_time: Duration::ZERO,
        auth_rejection_time_initial: Some(Duration::ZERO),
        ..Default::default()
    });
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let calls = Arc::new(AtomicUsize::new(0));
    let mut fixture = Fixture {
        auth_calls: calls.clone(),
    };
    let server =
        tokio::spawn(async move { fixture.run_on_socket(config, &listener).await.unwrap() });
    let ssh = Arc::new(SshManager::new());
    let mut host = Host {
        id: "fixture".into(),
        name: "Protocol fixture".into(),
        address: "127.0.0.1".into(),
        port,
        username: "fixture".into(),
        group: "tests".into(),
        auth_method: "password".into(),
        private_key_path: None,
        proxy: None,
        jump_host_id: None,
        startup_directory: None,
        keep_alive_seconds: 10,
        connect_timeout_seconds: 10,
        favorite: false,
        color: "#63AFFF".into(),
        notes: String::new(),
    };
    let key = ssh.probe(&host).await.unwrap();
    let silent: EventSink = Arc::new(|_| {});
    let secret = SecretInput {
        password: Some("test-only-password".into()),
        passphrase: None,
    };
    let denied = ssh
        .connect(&host, secret.clone(), "SHA256:wrong".into(), silent.clone())
        .await
        .unwrap_err();
    assert_eq!(denied.code, "HOST_KEY_CHANGED");
    assert_eq!(
        calls.load(Ordering::Relaxed),
        0,
        "No authentication may happen before host identity acceptance"
    );
    let rejected = ssh
        .connect(
            &host,
            SecretInput {
                password: Some("wrong".into()),
                passphrase: None,
            },
            key.fingerprint.clone(),
            silent,
        )
        .await
        .unwrap_err();
    assert_eq!(rejected.code, "AUTH_REJECTED");
    let bytes = Arc::new(Mutex::new(Vec::new()));
    let output = bytes.clone();
    let responder = ssh.clone();
    let events: EventSink = Arc::new(move |event| match event {
        TerminalEvent::Data {
            session_id,
            data,
            sequence,
        } => {
            output
                .lock()
                .unwrap()
                .extend(STANDARD.decode(data).unwrap());
            let ssh = responder.clone();
            tokio::spawn(async move {
                ssh.ack(&session_id, sequence).await.unwrap();
            });
        }
        TerminalEvent::Auth {
            request_id,
            prompts,
            ..
        } => {
            assert_eq!(prompts.len(), 2);
            assert!(!prompts[0].echo);
            assert!(prompts[1].echo);
            let ssh = responder.clone();
            tokio::spawn(async move {
                ssh.auth_respond(&request_id, vec!["123456".into(), "fixture-label".into()])
                    .await
                    .unwrap();
            });
        }
        _ => {}
    });
    let id = ssh
        .connect(&host, secret, key.fingerprint.clone(), events.clone())
        .await
        .unwrap();
    let raw = b"\x1b[31m\xe4\xb8\xad\xe6\x96\x87\x1b[0m\r\n";
    ssh.write(&id, raw).await.unwrap();
    ssh.resize(&id, 132, 44).await.unwrap();
    timeout(Duration::from_secs(5), async {
        loop {
            let ready = {
                let b = bytes.lock().unwrap();
                b.windows(raw.len()).any(|w| w == raw)
                    && b.windows(13).any(|w| w == b"RESIZE:132:44")
            };
            if ready {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    ssh.disconnect(&id).await.unwrap();
    host.auth_method = "interactive".into();
    let interactive = ssh
        .connect(&host, SecretInput::default(), key.fingerprint, events)
        .await
        .unwrap();
    ssh.disconnect(&interactive).await.unwrap();
    server.abort();
}
