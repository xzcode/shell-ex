//! Run through scripts/ssh_fixture.py; never talks to a user's real servers.
use base64::{engine::general_purpose::STANDARD, Engine};
use shell_ex_core::{
    models::{EventSink, Host, ProxyConfig, SecretInput, TerminalEvent},
    ssh::SshManager,
    tunnels::TunnelManager,
};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    time::timeout,
};

fn host() -> Host {
    Host {
        id: "integration-host".into(),
        name: "Isolated OpenSSH".into(),
        address: std::env::var("SHELL_EX_TEST_HOST").expect("Run through scripts/ssh_fixture.py"),
        port: std::env::var("SHELL_EX_TEST_PORT")
            .unwrap()
            .parse()
            .unwrap(),
        username: std::env::var("SHELL_EX_TEST_USER").unwrap(),
        group: "test".into(),
        auth_method: "key".into(),
        credential_store: "local".into(),
        private_key_path: Some(std::env::var("SHELL_EX_TEST_KEY").unwrap()),
        proxy: None,
        jump_host_id: None,
        startup_directory: None,
        keep_alive_seconds: 10,
        connect_timeout_seconds: 10,
        favorite: false,
        color: "#63AFFF".into(),
        notes: String::new(),
    }
}
fn sink(ssh: Arc<SshManager>) -> (EventSink, Arc<Mutex<String>>) {
    let text = Arc::new(Mutex::new(String::new()));
    let output = text.clone();
    (
        Arc::new(move |event| {
            if let TerminalEvent::Data {
                session_id,
                data,
                sequence,
            } = event
            {
                output
                    .lock()
                    .unwrap()
                    .push_str(&String::from_utf8_lossy(&STANDARD.decode(data).unwrap()));
                let ssh = ssh.clone();
                tokio::spawn(async move {
                    let _ = ssh.ack(&session_id, sequence).await;
                });
            }
        }),
        text,
    )
}
async fn echo_server() -> (u16, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let task = tokio::spawn(async move {
        while let Ok((socket, _)) = listener.accept().await {
            tokio::spawn(async move {
                let (mut r, mut w) = socket.into_split();
                let _ = tokio::io::copy(&mut r, &mut w).await;
            });
        }
    });
    (port, task)
}
async fn check_echo(mut socket: TcpStream) {
    socket.write_all(b"shell-ex-echo").await.unwrap();
    let mut bytes = [0; 13];
    timeout(Duration::from_secs(5), socket.read_exact(&mut bytes))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(&bytes, b"shell-ex-echo");
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires isolated OpenSSH fixture"]
async fn openssh_identity_pty_resize_exec_jump_and_agent() {
    let ssh = Arc::new(SshManager::new());
    let host = host();
    let key = ssh.probe(&host).await.unwrap();
    assert!(key.fingerprint.starts_with("SHA256:"));
    let (error_sink, _) = sink(ssh.clone());
    let error = ssh
        .connect(
            &host,
            SecretInput::default(),
            "SHA256:wrong-key".into(),
            error_sink,
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "HOST_KEY_CHANGED");
    let (events, output) = sink(ssh.clone());
    let pty = std::env::var_os("SHELL_EX_TEST_PTY").is_some();
    let id = if pty {
        ssh.connect(
            &host,
            SecretInput::default(),
            key.fingerprint.clone(),
            events,
        )
        .await
        .unwrap()
    } else {
        ssh.connect_service(
            &host,
            SecretInput::default(),
            key.fingerprint.clone(),
            events,
        )
        .await
        .unwrap()
    };
    let out = ssh
        .exec(
            &id,
            "printf integration-exec; printf diagnostic >&2; exit 7",
        )
        .await
        .unwrap();
    assert_eq!(out.stdout, "integration-exec");
    assert_eq!(out.stderr, "diagnostic");
    assert_eq!(out.status, 7);
    if pty {
        ssh.resize(&id, 119, 41).await.unwrap();
        ssh.write(&id, b"stty size\n").await.unwrap();
        timeout(Duration::from_secs(5), async {
            loop {
                if output.lock().unwrap().contains("41 119") {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
    }
    let mut target = host.clone();
    target.id = "jump-target".into();
    target.jump_host_id = Some(host.id.clone());
    assert_eq!(
        ssh.probe_via(&target, &id).await.unwrap().fingerprint,
        key.fingerprint
    );
    let (jump_events, _) = sink(ssh.clone());
    let jump = ssh
        .connect_service_via(
            &target,
            SecretInput::default(),
            key.fingerprint.clone(),
            jump_events,
            &id,
        )
        .await
        .unwrap();
    assert_eq!(
        ssh.exec(&jump, "printf jump-ok").await.unwrap().stdout,
        "jump-ok"
    );
    ssh.disconnect(&jump).await.unwrap();
    if std::env::var_os("SHELL_EX_TEST_AGENT").is_some() {
        let mut agent_host = host.clone();
        agent_host.auth_method = "agent".into();
        let (agent_events, _) = sink(ssh.clone());
        let agent = ssh
            .connect_service(
                &agent_host,
                SecretInput::default(),
                key.fingerprint,
                agent_events,
            )
            .await
            .unwrap();
        assert_eq!(
            ssh.exec(&agent, "printf agent-ok").await.unwrap().stdout,
            "agent-ok"
        );
        ssh.disconnect(&agent).await.unwrap();
    }
    ssh.disconnect(&id).await.unwrap();
    assert!(ssh.exec(&id, "printf closed").await.is_err());
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires isolated OpenSSH fixture"]
async fn openssh_local_remote_dynamic_tunnels_and_proxy_paths() {
    let ssh = Arc::new(SshManager::new());
    let host = host();
    let key = ssh.probe(&host).await.unwrap();
    let (events, _) = sink(ssh.clone());
    let session = ssh
        .connect_service(
            &host,
            SecretInput::default(),
            key.fingerprint.clone(),
            events,
        )
        .await
        .unwrap();
    let tunnels = TunnelManager::new(ssh.clone());
    let (echo_port, echo) = echo_server().await;
    let local = tunnels
        .start(
            &session,
            "local",
            "127.0.0.1",
            0,
            Some("127.0.0.1".into()),
            Some(echo_port),
        )
        .await
        .unwrap();
    check_echo(
        TcpStream::connect(("127.0.0.1", local.bind_port))
            .await
            .unwrap(),
    )
    .await;
    tunnels.stop(&local.id).await.unwrap();
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert!(TcpStream::connect(("127.0.0.1", local.bind_port))
        .await
        .is_err());
    let dynamic = tunnels
        .start(&session, "dynamic", "127.0.0.1", 0, None, None)
        .await
        .unwrap();
    let mut socket = TcpStream::connect(("127.0.0.1", dynamic.bind_port))
        .await
        .unwrap();
    socket.write_all(&[5, 1, 0]).await.unwrap();
    let mut reply = [0; 2];
    socket.read_exact(&mut reply).await.unwrap();
    assert_eq!(reply, [5, 0]);
    let mut request = vec![5, 1, 0, 1, 127, 0, 0, 1];
    request.extend(echo_port.to_be_bytes());
    socket.write_all(&request).await.unwrap();
    let mut reply = [0; 10];
    socket.read_exact(&mut reply).await.unwrap();
    assert_eq!(reply[1], 0);
    check_echo(socket).await;
    let mut proxied = host.clone();
    proxied.id = "socks-proxied".into();
    proxied.proxy = Some(ProxyConfig {
        kind: "socks5".into(),
        host: "127.0.0.1".into(),
        port: dynamic.bind_port,
    });
    assert_eq!(
        ssh.probe(&proxied).await.unwrap().fingerprint,
        key.fingerprint
    );
    let (proxy_events, _) = sink(ssh.clone());
    let proxied_id = ssh
        .connect_service(
            &proxied,
            SecretInput::default(),
            key.fingerprint.clone(),
            proxy_events,
        )
        .await
        .unwrap();
    assert_eq!(
        ssh.exec(&proxied_id, "printf socks-ok")
            .await
            .unwrap()
            .stdout,
        "socks-ok"
    );
    ssh.disconnect(&proxied_id).await.unwrap();
    let reserved = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let remote_port = reserved.local_addr().unwrap().port();
    drop(reserved);
    let remote = tunnels
        .start(
            &session,
            "remote",
            "127.0.0.1",
            remote_port,
            Some("127.0.0.1".into()),
            Some(echo_port),
        )
        .await
        .unwrap();
    check_echo(
        TcpStream::connect(("127.0.0.1", remote.bind_port))
            .await
            .unwrap(),
    )
    .await;
    tunnels.stop(&remote.id).await.unwrap();
    // An in-process CONNECT proxy deliberately coalesces HTTP and SSH data.
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let http_port = listener.local_addr().unwrap().port();
    let target_port = host.port;
    let http = tokio::spawn(async move {
        while let Ok((mut client, _)) = listener.accept().await {
            tokio::spawn(async move {
                let mut header = Vec::new();
                while !header.ends_with(b"\r\n\r\n") {
                    header.push(client.read_u8().await.unwrap());
                    if header.len() > 16384 {
                        return;
                    }
                }
                let mut upstream = TcpStream::connect(("127.0.0.1", target_port))
                    .await
                    .unwrap();
                client
                    .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                    .await
                    .unwrap();
                let _ = tokio::io::copy_bidirectional(&mut client, &mut upstream).await;
            });
        }
    });
    proxied.proxy = Some(ProxyConfig {
        kind: "http".into(),
        host: "127.0.0.1".into(),
        port: http_port,
    });
    assert_eq!(
        ssh.probe(&proxied).await.unwrap().fingerprint,
        key.fingerprint
    );
    let (proxy_events, _) = sink(ssh.clone());
    let http_id = ssh
        .connect_service(
            &proxied,
            SecretInput::default(),
            key.fingerprint,
            proxy_events,
        )
        .await
        .unwrap();
    assert_eq!(
        ssh.exec(&http_id, "printf http-ok").await.unwrap().stdout,
        "http-ok"
    );
    ssh.disconnect(&http_id).await.unwrap();
    tunnels.close_all().await;
    ssh.close_all().await;
    echo.abort();
    http.abort();
}
