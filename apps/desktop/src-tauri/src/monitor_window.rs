use super::AppState;
use serde::{Deserialize, Serialize};
use shell_ex_core::{
    error::{AppError, Result},
    monitor::MonitorSnapshot,
};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};

pub const LABEL: &str = "monitor";

#[derive(Clone, Serialize, Deserialize)]
pub struct MonitorSession {
    id: String,
    name: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorContext {
    session: Option<MonitorSession>,
    theme: String,
    monitor_interval: u32,
    language: String,
}

impl MonitorContext {
    fn validate(&self) -> Result<()> {
        if !["dark", "light", "graphite", "mist", "aurora", "black"].contains(&self.theme.as_str())
            || !["zh-CN", "en"].contains(&self.language.as_str())
            || !(2..=60).contains(&self.monitor_interval)
            || self
                .session
                .as_ref()
                .is_some_and(|s| s.id.is_empty() || s.id.len() > 128 || s.name.len() > 4096)
        {
            return Err(AppError::new(
                "INVALID_MONITOR_CONTEXT",
                "Invalid monitor window context",
            ));
        }
        Ok(())
    }
}

#[derive(Default)]
pub struct DetachedState {
    context: Mutex<Option<MonitorContext>>,
    gate: tokio::sync::Mutex<()>,
}

impl DetachedState {
    fn update_active(&self, context: MonitorContext) -> Result<()> {
        context.validate()?;
        let mut current = self.context.lock().map_err(AppError::internal)?;
        // In-flight updates must not reopen a monitor which has been docked.
        if current.is_some() {
            *current = Some(context);
        }
        Ok(())
    }

    pub fn clear(&self) {
        if let Ok(mut value) = self.context.lock() {
            *value = None;
        }
    }
}

// Application-defined commands are otherwise available to every local webview.
// The detached monitor has read-only access to its selected SSH session, no
// terminal, credential, filesystem, transfer or process-mutation commands.
pub fn command_allowed(label: &str, command: &str) -> bool {
    label == "main"
        || (label == LABEL
            && matches!(
                command,
                "monitor_window_context" | "monitor_window_snapshot" | "monitor_window_dock"
            ))
}

#[tauri::command]
pub async fn monitor_window_open(
    app: AppHandle,
    state: State<'_, AppState>,
    context: MonitorContext,
) -> Result<()> {
    let _guard = state.detached_monitor.gate.lock().await;
    context.validate()?;
    *state
        .detached_monitor
        .context
        .lock()
        .map_err(AppError::internal)? = Some(context);
    if let Some(window) = app.get_webview_window(LABEL) {
        if let Err(error) = window.show() {
            state.detached_monitor.clear();
            return Err(AppError::internal(error));
        }
        // Focus is best-effort: the window is open even if the OS denies focus.
        let _ = window.set_focus();
        return Ok(());
    }
    // Tauri's async command avoids creating WebView2 windows in a synchronous
    // IPC event handler, which can deadlock on Windows.
    let result = WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::App("index.html".into()))
        .title("Shell EX · Monitor")
        .inner_size(560.0, 760.0)
        .min_inner_size(340.0, 420.0)
        .resizable(true)
        .build();
    match result {
        Ok(_) => Ok(()),
        Err(error) => {
            state.detached_monitor.clear();
            Err(AppError::internal(error))
        }
    }
}

#[tauri::command]
pub async fn monitor_window_update(
    app: AppHandle,
    state: State<'_, AppState>,
    context: MonitorContext,
) -> Result<()> {
    let _guard = state.detached_monitor.gate.lock().await;
    if app.get_webview_window(LABEL).is_some() {
        state.detached_monitor.update_active(context)?;
    }
    Ok(())
}

#[tauri::command]
pub fn monitor_window_is_open(app: AppHandle, state: State<'_, AppState>) -> Result<bool> {
    Ok(app.get_webview_window(LABEL).is_some()
        && state
            .detached_monitor
            .context
            .lock()
            .map_err(AppError::internal)?
            .is_some())
}

#[tauri::command]
pub fn monitor_window_context(state: State<'_, AppState>) -> Result<Option<MonitorContext>> {
    Ok(state
        .detached_monitor
        .context
        .lock()
        .map_err(AppError::internal)?
        .clone())
}

#[tauri::command]
pub async fn monitor_window_snapshot(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<MonitorSnapshot> {
    let current = state
        .detached_monitor
        .context
        .lock()
        .map_err(AppError::internal)?
        .clone();
    if !current
        .and_then(|c| c.session)
        .is_some_and(|s| s.id == session_id)
    {
        return Err(AppError::new(
            "MONITOR_SESSION_CHANGED",
            "The monitored session has changed or closed",
        ));
    }
    state.monitor.snapshot(&session_id).await
}

#[tauri::command]
pub async fn monitor_window_dock(app: AppHandle, state: State<'_, AppState>) -> Result<()> {
    let _guard = state.detached_monitor.gate.lock().await;
    hide_and_dock(&app, &state.detached_monitor)
}

/// Keep the webview alive while resolving its IPC response. Destroying the
/// calling webview (or an in-flight telemetry callback) can crash AppKit/WKWebView.
pub fn hide_and_dock(app: &AppHandle, state: &DetachedState) -> Result<()> {
    if let Some(window) = app.get_webview_window(LABEL) {
        window.hide().map_err(AppError::internal)?;
    }
    state.clear();
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.set_focus();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn delayed_context_update_does_not_reactivate_docked_window() {
        let state = DetachedState::default();
        let context = MonitorContext {
            session: Some(MonitorSession {
                id: "fixture".into(),
                name: "Host".into(),
            }),
            theme: "black".into(),
            monitor_interval: 3,
            language: "en".into(),
        };
        *state.context.lock().unwrap() = Some(context.clone());
        state.update_active(context.clone()).unwrap();
        assert!(state.context.lock().unwrap().is_some());
        state.clear();
        state.update_active(context.clone()).unwrap();
        assert!(state.context.lock().unwrap().is_none());
        *state.context.lock().unwrap() = Some(context.clone());
        assert!(state.context.lock().unwrap().is_some());
        state.clear();
        assert!(state.context.lock().unwrap().is_none());
    }

    #[test]
    fn detached_monitor_only_allows_read_only_commands_and_docking() {
        for cmd in [
            "monitor_window_context",
            "monitor_window_snapshot",
            "monitor_window_dock",
        ] {
            assert!(command_allowed(LABEL, cmd));
        }
        for cmd in [
            "hosts_list",
            "host_secret_status",
            "host_save",
            "terminal_write",
            "sftp_remove_tree",
            "process_signal",
            "monitor_snapshot",
            "session_close",
            "monitor_window_open",
            "monitor_window_update",
        ] {
            assert!(!command_allowed(LABEL, cmd), "{cmd}");
            assert!(command_allowed("main", cmd));
        }
        assert!(!command_allowed("other", "monitor_window_snapshot"));
    }
}
