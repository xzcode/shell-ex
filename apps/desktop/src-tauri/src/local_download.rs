use super::AppState;
use shell_ex_core::error::{AppError, Result};
use std::{path::Path, process::Command};
use tauri::State;

/// The caller supplies a task ID, not a local executable/path or shell fragment.
#[tauri::command]
pub async fn transfer_open_local(
    state: State<'_, AppState>,
    id: String,
    action: String,
) -> Result<()> {
    if !matches!(action.as_str(), "open" | "reveal") {
        return Err(AppError::new("INVALID_ACTION", "Choose open or reveal"));
    }
    let path = state.transfers.completed_download_path(&id).await?;
    tokio::task::spawn_blocking(move || launch(&path, action == "reveal"))
        .await
        .map_err(AppError::internal)?
}

#[cfg(target_os = "macos")]
fn launch(path: &Path, reveal: bool) -> Result<()> {
    let mut cmd = Command::new("/usr/bin/open");
    if reveal {
        cmd.arg("-R");
    }
    let status = cmd.arg(path).status().map_err(AppError::io)?;
    if !status.success() {
        return Err(AppError::new(
            "LOCAL_OPEN_FAILED",
            "无法打开已下载文件或文件夹",
        ));
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn launch(path: &Path, reveal: bool) -> Result<()> {
    use std::os::windows::{ffi::OsStrExt, process::CommandExt};
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    // Win32 canonical paths use the extended-length prefix, which shell APIs
    // generally do not accept. Convert ordinary drive and UNC paths for display.
    let text = path
        .to_str()
        .ok_or_else(|| AppError::new("INVALID_LOCAL_PATH", "Invalid local download path"))?;
    let shell_path = if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = text.strip_prefix(r"\\?\") {
        rest.to_owned()
    } else {
        text.to_owned()
    };
    if reveal {
        // Native Explorer syntax expects a quoted path following /select,.
        // Windows file names cannot contain double quotes. Do not use cmd.exe.
        if shell_path.contains('"') {
            return Err(AppError::new(
                "INVALID_LOCAL_PATH",
                "Invalid local download path",
            ));
        }
        let windows = std::env::var_os("SystemRoot").ok_or_else(|| {
            AppError::new("LOCAL_OPEN_FAILED", "Windows directory is unavailable")
        })?;
        Command::new(std::path::PathBuf::from(windows).join("explorer.exe"))
            .raw_arg(format!(r#"/select,"{}""#, shell_path))
            .spawn()
            .map_err(AppError::io)?;
        return Ok(());
    }
    let verb: Vec<u16> = std::ffi::OsStr::new("open")
        .encode_wide()
        .chain(Some(0))
        .collect();
    let file: Vec<u16> = std::ffi::OsStr::new(&shell_path)
        .encode_wide()
        .chain(Some(0))
        .collect();
    // Explicit user action; use the OS file association with no shell command.
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            verb.as_ptr(),
            file.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            1,
        )
    };
    if result as isize <= 32 {
        return Err(AppError::new(
            "LOCAL_OPEN_FAILED",
            "无法打开已下载文件或文件夹",
        ));
    }
    Ok(())
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn launch(path: &Path, reveal: bool) -> Result<()> {
    // Linux file managers vary; open the containing directory rather than
    // claiming every file manager supports selecting a particular file.
    let target = if reveal {
        path.parent()
            .ok_or_else(|| AppError::new("INVALID_LOCAL_PATH", "Invalid local download path"))?
    } else {
        path
    };
    Command::new("xdg-open")
        .arg(target)
        .spawn()
        .map_err(AppError::io)?;
    Ok(())
}
