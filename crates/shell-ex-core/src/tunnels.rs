//! SSH local, remote and SOCKS5 dynamic forwarding with owned cancellation.
use crate::{
    error::{AppError, Result},
    ssh::{validate_address, RemoteRoute, SshManager},
};
use serde::Serialize;
use std::{
    collections::HashMap,
    net::{IpAddr, Ipv4Addr, Ipv6Addr},
    sync::Arc,
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::{Mutex, Semaphore},
    time::timeout,
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelInfo {
    pub id: String,
    pub session_id: String,
    pub kind: String,
    pub bind_host: String,
    pub bind_port: u16,
    pub target_host: Option<String>,
    pub target_port: Option<u16>,
}
struct Tunnel {
    info: TunnelInfo,
    cancel: CancellationToken,
}
#[derive(Clone)]
pub struct TunnelManager {
    ssh: Arc<SshManager>,
    tunnels: Arc<Mutex<HashMap<String, Tunnel>>>,
}
impl TunnelManager {
    pub fn new(ssh: Arc<SshManager>) -> Self {
        Self {
            ssh,
            tunnels: Arc::default(),
        }
    }
    #[allow(clippy::too_many_arguments)]
    pub async fn start(
        &self,
        session_id: &str,
        kind: &str,
        bind_host: &str,
        bind_port: u16,
        target_host: Option<String>,
        target_port: Option<u16>,
    ) -> Result<TunnelInfo> {
        if !matches!(kind, "local" | "remote" | "dynamic") {
            return Err(AppError::new("TUNNEL_KIND", "Unknown forwarding type"));
        }
        validate_bind(bind_host)?;
        if kind != "dynamic" {
            validate_address(
                target_host
                    .as_deref()
                    .ok_or_else(|| AppError::new("TUNNEL_TARGET", "A target host is required"))?,
            )?;
            if target_port.is_none_or(|p| p == 0) {
                return Err(AppError::new(
                    "TUNNEL_TARGET",
                    "A nonzero target port is required",
                ));
            }
        }
        let session = self.ssh.session(session_id).await?;
        let mut all = self.tunnels.lock().await;
        all.retain(|_, t| !t.cancel.is_cancelled());
        if all.len() >= 32 {
            return Err(AppError::new(
                "TUNNEL_LIMIT",
                "At most 32 simultaneous tunnels are supported",
            ));
        }
        let id = Uuid::new_v4().to_string();
        let cancel = session.cancel.child_token();
        let connections = Arc::new(Semaphore::new(64));
        let actual_port;
        if kind == "remote" {
            // Fixed remote ports can be registered before the forwarding request,
            // so a connection arriving immediately after acknowledgement is safe.
            if bind_port == 0 {
                return Err(AppError::new(
                    "REMOTE_PORT",
                    "Select a nonzero remote listening port",
                ));
            }
            let route_key = (bind_host.to_string(), bind_port as u32);
            let mut routes = session.routes.write().await;
            if routes.contains_key(&route_key) {
                return Err(AppError::new(
                    "PORT_IN_USE",
                    "This remote listening address is already forwarded",
                ));
            }
            routes.insert(
                route_key.clone(),
                RemoteRoute {
                    host: target_host.clone().unwrap_or_default(),
                    port: target_port.unwrap_or_default(),
                    cancel: cancel.clone(),
                    connections: connections.clone(),
                },
            );
            drop(routes);
            let request = timeout(
                Duration::from_secs(15),
                session.transport.tcpip_forward(bind_host, bind_port as u32),
            )
            .await;
            match request {
                Ok(Ok(_)) => actual_port = bind_port,
                error => {
                    session.routes.write().await.remove(&route_key);
                    cancel.cancel();
                    return match error {
                        Ok(Err(e)) => Err(AppError::from(e)),
                        _ => Err(AppError::new(
                            "TUNNEL_TIMEOUT",
                            "Server did not acknowledge remote forwarding",
                        )),
                    };
                }
            }
        } else {
            let listener = TcpListener::bind((bind_host, bind_port)).await?;
            actual_port = listener.local_addr()?.port();
            let task_cancel = cancel.clone();
            let ssh = self.ssh.clone();
            let session_id = session_id.to_string();
            let target = target_host.clone();
            let dynamic = kind == "dynamic";
            tokio::spawn(async move {
                loop {
                    let accepted =
                        tokio::select! { _=task_cancel.cancelled()=>break, r=listener.accept()=>r };
                    let Ok((socket, _)) = accepted else { break };
                    let Ok(permit) = connections.clone().try_acquire_owned() else {
                        drop(socket);
                        continue;
                    };
                    let ssh = ssh.clone();
                    let session_id = session_id.clone();
                    let cancel = task_cancel.clone();
                    let target = target.clone();
                    tokio::spawn(async move {
                        let _permit = permit;
                        let _ = forward_socket(
                            ssh,
                            &session_id,
                            socket,
                            dynamic,
                            target,
                            target_port,
                            cancel,
                        )
                        .await;
                    });
                }
            });
        }
        let info = TunnelInfo {
            id: id.clone(),
            session_id: session_id.into(),
            kind: kind.into(),
            bind_host: bind_host.into(),
            bind_port: actual_port,
            target_host: if kind == "dynamic" { None } else { target_host },
            target_port: if kind == "dynamic" { None } else { target_port },
        };
        all.insert(
            id,
            Tunnel {
                info: info.clone(),
                cancel,
            },
        );
        Ok(info)
    }
    pub async fn list(&self) -> Vec<TunnelInfo> {
        let mut all = self.tunnels.lock().await;
        all.retain(|_, t| !t.cancel.is_cancelled());
        let mut list = all.values().map(|t| t.info.clone()).collect::<Vec<_>>();
        list.sort_by(|a, b| a.id.cmp(&b.id));
        list
    }
    pub async fn stop(&self, id: &str) -> Result<()> {
        let Some(tunnel) = self.tunnels.lock().await.remove(id) else {
            return Ok(());
        };
        tunnel.cancel.cancel();
        if tunnel.info.kind == "remote" {
            if let Ok(session) = self.ssh.session(&tunnel.info.session_id).await {
                session
                    .routes
                    .write()
                    .await
                    .remove(&(tunnel.info.bind_host.clone(), tunnel.info.bind_port as u32));
                timeout(
                    Duration::from_secs(10),
                    session
                        .transport
                        .cancel_tcpip_forward(&tunnel.info.bind_host, tunnel.info.bind_port as u32),
                )
                .await
                .map_err(|_| {
                    AppError::new("TUNNEL_TIMEOUT", "Remote forwarding cancellation timed out")
                })??;
            }
        }
        Ok(())
    }
    pub async fn stop_session(&self, session_id: &str) {
        let ids = self
            .tunnels
            .lock()
            .await
            .values()
            .filter(|t| t.info.session_id == session_id)
            .map(|t| t.info.id.clone())
            .collect::<Vec<_>>();
        for id in ids {
            let _ = self.stop(&id).await;
        }
    }
    pub async fn close_all(&self) {
        let ids = self
            .tunnels
            .lock()
            .await
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        for id in ids {
            let _ = self.stop(&id).await;
        }
    }
}
fn validate_bind(host: &str) -> Result<()> {
    if host == "localhost" || host.parse::<IpAddr>().is_ok_and(|a| a.is_loopback()) {
        return Ok(());
    }
    Err(AppError::new(
        "TUNNEL_BIND",
        "Forwarding listeners must bind to localhost, 127.0.0.1 or ::1",
    ))
}
async fn forward_socket(
    ssh: Arc<SshManager>,
    session_id: &str,
    mut socket: TcpStream,
    dynamic: bool,
    target_host: Option<String>,
    target_port: Option<u16>,
    cancel: CancellationToken,
) -> Result<()> {
    socket.set_nodelay(true)?;
    let (host, port) = if dynamic {
        tokio::select! {
            _=cancel.cancelled()=>return Ok(()),
            r=timeout(Duration::from_secs(15),socks_request(&mut socket))=>r.map_err(|_|AppError::new("SOCKS_TIMEOUT","SOCKS request timed out"))??,
        }
    } else {
        (
            target_host.unwrap_or_default(),
            target_port.unwrap_or_default(),
        )
    };
    let opened = tokio::select! { _=cancel.cancelled()=>return Ok(()), r=ssh.direct(session_id,&host,port)=>r };
    let channel = match opened {
        Ok(c) => c,
        Err(e) => {
            if dynamic {
                let _ = socket.write_all(&[5, 5, 0, 1, 0, 0, 0, 0, 0, 0]).await;
            }
            return Err(e);
        }
    };
    if dynamic {
        socket.write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0]).await?;
    }
    let mut stream = channel.into_stream();
    tokio::select! { _=cancel.cancelled()=>{}, r=tokio::io::copy_bidirectional(&mut socket,&mut stream)=>{r?;} }
    let _ = stream.shutdown().await;
    let _ = socket.shutdown().await;
    Ok(())
}
async fn socks_request(socket: &mut TcpStream) -> Result<(String, u16)> {
    let version = socket.read_u8().await?;
    let count = socket.read_u8().await?;
    if version != 5 || count == 0 {
        return Err(AppError::new("SOCKS_PROTOCOL", "Invalid SOCKS5 greeting"));
    }
    let mut methods = vec![0; count as usize];
    socket.read_exact(&mut methods).await?;
    if !methods.contains(&0) {
        socket.write_all(&[5, 255]).await?;
        return Err(AppError::new(
            "SOCKS_AUTH",
            "SOCKS authentication method is unsupported",
        ));
    }
    socket.write_all(&[5, 0]).await?;
    let mut header = [0; 4];
    socket.read_exact(&mut header).await?;
    if header[0] != 5 || header[1] != 1 || header[2] != 0 {
        socket.write_all(&[5, 7, 0, 1, 0, 0, 0, 0, 0, 0]).await?;
        return Err(AppError::new(
            "SOCKS_COMMAND",
            "Only SOCKS5 CONNECT is supported",
        ));
    }
    let host = match header[3] {
        1 => {
            let mut bytes = [0; 4];
            socket.read_exact(&mut bytes).await?;
            Ipv4Addr::from(bytes).to_string()
        }
        4 => {
            let mut bytes = [0; 16];
            socket.read_exact(&mut bytes).await?;
            Ipv6Addr::from(bytes).to_string()
        }
        3 => {
            let size = socket.read_u8().await? as usize;
            let mut bytes = vec![0; size];
            socket.read_exact(&mut bytes).await?;
            String::from_utf8(bytes)
                .map_err(|_| AppError::new("SOCKS_ADDRESS", "SOCKS hostname is not UTF-8"))?
        }
        _ => {
            socket.write_all(&[5, 8, 0, 1, 0, 0, 0, 0, 0, 0]).await?;
            return Err(AppError::new("SOCKS_ADDRESS", "Unsupported address type"));
        }
    };
    let port = socket.read_u16().await?;
    validate_address(&host)?;
    if port == 0 {
        return Err(AppError::new("SOCKS_PORT", "Target port must be nonzero"));
    }
    Ok((host, port))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn loopback_listeners_do_not_expose_forwarding_to_the_network() {
        assert!(validate_bind("127.0.0.1").is_ok());
        assert!(validate_bind("::1").is_ok());
        assert!(validate_bind("0.0.0.0").is_err());
        assert!(validate_bind("example.com").is_err());
    }
}
