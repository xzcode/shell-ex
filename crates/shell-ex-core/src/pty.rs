//! Local shells use a real OS pseudo-terminal, never a one-command subprocess.
use crate::{
    error::{AppError, Result},
    models::{EventSink, TerminalEvent},
    ssh::{validate_size, OutputFlow},
};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use std::{
    collections::HashMap,
    io::{Read, Write},
    sync::{Arc, Mutex},
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

struct LocalSession {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    flow: Arc<OutputFlow>,
}
#[derive(Clone, Default)]
pub struct PtyManager {
    sessions: Arc<Mutex<HashMap<String, Arc<LocalSession>>>>,
}
impl PtyManager {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn open(
        &self,
        cwd: Option<String>,
        cols: u16,
        rows: u16,
        sink: EventSink,
    ) -> Result<String> {
        validate_size(cols as u32, rows as u32)?;
        let runtime = tokio::runtime::Handle::try_current().map_err(AppError::internal)?;
        let pair = native_pty_system()
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(AppError::internal)?;
        #[cfg(unix)]
        let shell = std::env::var("SHELL")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "/bin/sh".into());
        #[cfg(windows)]
        let shell = std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into());
        let mut command = CommandBuilder::new(shell);
        #[cfg(unix)]
        command.arg("-l");
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        if let Some(directory) = cwd.filter(|c| !c.is_empty()) {
            if !std::path::Path::new(&directory).is_dir() {
                return Err(AppError::new(
                    "LOCAL_DIRECTORY",
                    "Local working directory does not exist",
                ));
            }
            command.cwd(directory);
        } else if let Some(home) = dirs::home_dir() {
            command.cwd(home);
        }
        let mut reader = pair.master.try_clone_reader().map_err(AppError::internal)?;
        let writer = pair.master.take_writer().map_err(AppError::internal)?;
        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(AppError::internal)?;
        drop(pair.slave);
        let killer = child.clone_killer();
        let flow = Arc::new(OutputFlow::new(CancellationToken::new()));
        let id = format!("local-{}", Uuid::new_v4());
        let session = Arc::new(LocalSession {
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            killer: Mutex::new(killer),
            flow: flow.clone(),
        });
        self.sessions
            .lock()
            .map_err(AppError::internal)?
            .insert(id.clone(), session);
        sink(TerminalEvent::State {
            session_id: id.clone(),
            state: "connected".into(),
            message: Some("Local shell".into()),
        });
        let sessions = self.sessions.clone();
        let task_id = id.clone();
        let spawned = std::thread::Builder::new()
            .name("shell-ex-pty".into())
            .spawn(move || {
                let mut buffer = vec![0u8; 16384];
                loop {
                    match reader.read(&mut buffer) {
                        Ok(0) => break,
                        Ok(n) => {
                            if !runtime.block_on(flow.send(&task_id, &buffer[..n], &sink)) {
                                break;
                            }
                        }
                        Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                        Err(_) => break, // PTY EOF commonly appears as EIO on Linux.
                    }
                }
                flow.cancel.cancel();
                let exit = child.wait().ok().map(|s| s.exit_code());
                sink(TerminalEvent::Exit {
                    session_id: task_id.clone(),
                    code: exit,
                });
                sink(TerminalEvent::State {
                    session_id: task_id.clone(),
                    state: "disconnected".into(),
                    message: Some("Local shell exited".into()),
                });
                if let Ok(mut sessions) = sessions.lock() {
                    sessions.remove(&task_id);
                }
            });
        if let Err(error) = spawned {
            let _ = self.close(&id);
            return Err(AppError::io(error));
        }
        Ok(id)
    }
    fn session(&self, id: &str) -> Result<Arc<LocalSession>> {
        self.sessions
            .lock()
            .map_err(AppError::internal)?
            .get(id)
            .cloned()
            .ok_or_else(|| AppError::new("SESSION_CLOSED", "Local terminal is closed"))
    }
    pub fn write(&self, id: &str, data: &[u8]) -> Result<()> {
        if data.len() > 1024 * 1024 {
            return Err(AppError::new(
                "INPUT_TOO_LARGE",
                "Terminal input exceeds 1 MiB per request",
            ));
        }
        let session = self.session(id)?;
        let mut writer = session.writer.lock().map_err(AppError::internal)?;
        writer.write_all(data)?;
        writer.flush()?;
        Ok(())
    }
    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<()> {
        validate_size(cols as u32, rows as u32)?;
        self.session(id)?
            .master
            .lock()
            .map_err(AppError::internal)?
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(AppError::internal)
    }
    pub fn ack(&self, id: &str, sequence: u64) -> Result<()> {
        if let Ok(session) = self.session(id) {
            session.flow.ack(sequence);
        }
        Ok(())
    }
    pub fn close(&self, id: &str) -> Result<()> {
        let session = self.sessions.lock().map_err(AppError::internal)?.remove(id);
        if let Some(session) = session {
            session.flow.cancel.cancel();
            let _ = session.killer.lock().map_err(AppError::internal)?.kill();
        }
        Ok(())
    }
    pub fn close_all(&self) {
        let ids = self
            .sessions
            .lock()
            .map(|s| s.keys().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        for id in ids {
            let _ = self.close(&id);
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::STANDARD, Engine};
    #[tokio::test(flavor = "multi_thread")]
    async fn local_shell_has_a_real_resizable_pty() {
        let manager = PtyManager::new();
        let ack = manager.clone();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let sink: EventSink = Arc::new(move |event| {
            if let TerminalEvent::Data {
                session_id,
                data,
                sequence,
            } = event
            {
                let _ = ack.ack(&session_id, sequence);
                let _ = tx.send(STANDARD.decode(data).unwrap());
            }
        });
        let id = manager
            .open(
                Some(std::env::temp_dir().display().to_string()),
                80,
                24,
                sink,
            )
            .unwrap();
        manager.resize(&id, 111, 37).unwrap();
        manager.write(&id, b"stty size; printf '\\123\\110\\105\\114\\114\\137\\105\\130\\137\\120\\124\\131\\137\\117\\113\\n'\n").unwrap();
        let mut output = String::new();
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while let Some(data) = rx.recv().await {
                output.push_str(&String::from_utf8_lossy(&data));
                if output.contains("37 111") && output.contains("SHELL_EX_PTY_OK") {
                    break;
                }
            }
        })
        .await
        .unwrap();
        assert!(output.contains("37 111"));
        assert!(output.contains("SHELL_EX_PTY_OK"));
        manager.close(&id).unwrap();
    }
}
