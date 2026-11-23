use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Host {
    pub id: String,
    pub name: String,
    pub address: String,
    pub port: u16,
    pub username: String,
    pub group: String,
    pub auth_method: String,
    pub private_key_path: Option<String>,
    pub proxy: Option<ProxyConfig>,
    pub jump_host_id: Option<String>,
    pub startup_directory: Option<String>,
    pub keep_alive_seconds: u32,
    pub connect_timeout_seconds: u32,
    pub favorite: bool,
    pub color: String,
    pub notes: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyConfig {
    pub kind: String,
    pub host: String,
    pub port: u16,
}
#[derive(Default, Clone, Serialize, Deserialize, zeroize::Zeroize, zeroize::ZeroizeOnDrop)]
#[serde(rename_all = "camelCase")]
pub struct SecretInput {
    pub password: Option<String>,
    pub passphrase: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostKeyInfo {
    pub algorithm: String,
    pub fingerprint: String,
}
#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum TerminalEvent {
    Data {
        session_id: String,
        data: String,
        sequence: u64,
    },
    State {
        session_id: String,
        state: String,
        message: Option<String>,
    },
    Exit {
        session_id: String,
        code: Option<u32>,
    },
    Auth {
        session_id: String,
        request_id: String,
        name: String,
        instructions: String,
        prompts: Vec<AuthPrompt>,
    },
}
#[derive(Debug, Clone, Serialize)]
pub struct AuthPrompt {
    pub prompt: String,
    pub echo: bool,
}
pub type EventSink = Arc<dyn Fn(TerminalEvent) + Send + Sync>;
#[derive(Debug, Clone, Serialize)]
pub struct ExecOutput {
    pub stdout: String,
    pub stderr: String,
    pub status: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppSettings {
    pub theme: String,
    pub font_size: u16,
    pub font_family: String,
    pub scrollback: u32,
    pub monitor_interval: u32,
    pub transfer_concurrency: u16,
    pub confirm_multiline_paste: bool,
    pub auto_reconnect: bool,
}
impl Default for AppSettings {
    fn default() -> Self {
        Self {
            theme: "graphite".into(),
            font_size: 13,
            font_family: "Menlo, Monaco, Consolas, monospace".into(),
            scrollback: 10000,
            monitor_interval: 3,
            transfer_concurrency: 2,
            confirm_multiline_paste: true,
            auto_reconnect: false,
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Workspace {
    pub host_ids: Vec<String>,
    pub active_host_id: Option<String>,
    pub sidebar_width: f64,
    pub files_height: f64,
    pub monitor_visible: bool,
    pub files_visible: bool,
    pub split: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Snippet {
    pub id: String,
    pub name: String,
    pub command: String,
    pub group: String,
}

impl Default for Workspace {
    fn default() -> Self {
        Self {
            host_ids: Vec::new(),
            active_host_id: None,
            sidebar_width: 232.0,
            files_height: 326.0,
            monitor_visible: true,
            files_visible: true,
            split: "none".into(),
        }
    }
}
