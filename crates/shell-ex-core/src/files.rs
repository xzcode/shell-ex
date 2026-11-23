//! SFTP file operations. Editor writes are optimistic, bounded and atomic.
//! We never delete the destination to emulate an overwrite.
use crate::{
    error::{AppError, Result},
    ssh::SshManager,
};
use russh_sftp::{
    client::SftpSession,
    protocol::{FileAttributes, OpenFlags, Packet, StatusCode},
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{collections::HashMap, sync::Arc};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::Mutex,
};
use uuid::Uuid;

pub const EDITOR_LIMIT: u64 = 5 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: u64,
    pub modified: Option<u32>,
    pub permissions: Option<u32>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorFile {
    pub path: String,
    pub text: String,
    pub version: String,
    pub size: u64,
}

pub struct FileService {
    ssh: Arc<SshManager>,
    writes: Mutex<HashMap<String, Arc<Mutex<()>>>>,
}
impl FileService {
    pub fn new(ssh: Arc<SshManager>) -> Self {
        Self {
            ssh,
            writes: Mutex::new(HashMap::new()),
        }
    }

    pub async fn canonicalize(&self, session_id: &str, path: &str) -> Result<String> {
        valid_path(path)?;
        self.ssh
            .sftp(session_id)
            .await?
            .canonicalize(path)
            .await
            .map_err(sftp_error)
    }

    pub async fn list(&self, session_id: &str, path: &str) -> Result<Vec<FileEntry>> {
        valid_path(path)?;
        let sftp = self.ssh.sftp(session_id).await?;
        let parent = sftp.canonicalize(path).await.map_err(sftp_error)?;
        let entries = sftp.read_dir(parent.clone()).await.map_err(sftp_error)?;
        let mut result = Vec::new();
        for entry in entries {
            let name = entry.file_name();
            if name == "." || name == ".." {
                continue;
            }
            if name.contains('/') || name.contains('\0') {
                return Err(AppError::new(
                    "INVALID_DIRECTORY_ENTRY",
                    "The server returned an invalid file name",
                ));
            }
            if result.len() >= 20_000 {
                return Err(AppError::new("DIRECTORY_TOO_LARGE", "This directory has more than 20,000 entries; use the terminal to narrow it down"));
            }
            let attrs = entry.metadata();
            // russh-sftp 2.x is_regular/is_dir helpers test overlapping bit flags;
            // file_type() uses an exact type mask and does not confuse links or sockets.
            result.push(FileEntry {
                path: join_remote(&parent, &name),
                name,
                is_dir: attrs.file_type().is_dir(),
                is_symlink: attrs.file_type().is_symlink(),
                size: attrs.size.unwrap_or(0),
                modified: attrs.mtime,
                permissions: attrs.permissions,
            });
        }
        result.sort_by(|a, b| {
            b.is_dir
                .cmp(&a.is_dir)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        Ok(result)
    }
    pub async fn mkdir(&self, session_id: &str, path: &str) -> Result<()> {
        valid_mutation_path(path)?;
        self.ssh
            .sftp(session_id)
            .await?
            .create_dir(path)
            .await
            .map_err(sftp_error)
    }
    pub async fn rename(&self, session_id: &str, from: &str, to: &str) -> Result<()> {
        valid_mutation_path(from)?;
        valid_mutation_path(to)?;
        let sftp = self.ssh.sftp(session_id).await?;
        if sftp.try_exists(to).await.map_err(sftp_error)? {
            return Err(AppError::new(
                "DESTINATION_EXISTS",
                "The destination already exists; rename never overwrites an existing file",
            ));
        }
        sftp.rename(from, to).await.map_err(sftp_error)
    }
    pub async fn remove(&self, session_id: &str, path: &str, is_dir: bool) -> Result<()> {
        valid_mutation_path(path)?;
        let sftp = self.ssh.sftp(session_id).await?;
        let meta = sftp.symlink_metadata(path).await.map_err(sftp_error)?;
        if is_dir && !meta.file_type().is_symlink() {
            sftp.remove_dir(path).await.map_err(sftp_error)
        } else {
            sftp.remove_file(path).await.map_err(sftp_error)
        }
    }
    pub async fn chmod(&self, session_id: &str, path: &str, mode: u32) -> Result<()> {
        valid_mutation_path(path)?;
        if mode > 0o7777 {
            return Err(AppError::new(
                "INVALID_MODE",
                "Permissions must be between 0000 and 7777 (octal)",
            ));
        }
        let sftp = self.ssh.sftp(session_id).await?;
        if sftp
            .symlink_metadata(path)
            .await
            .map_err(sftp_error)?
            .file_type()
            .is_symlink()
        {
            return Err(AppError::new(
                "SYMLINK_REFUSED",
                "Open the link's target explicitly before changing permissions",
            ));
        }
        sftp.set_metadata(
            path,
            FileAttributes {
                permissions: Some(mode),
                ..Default::default()
            },
        )
        .await
        .map_err(sftp_error)
    }
    pub async fn read(&self, session_id: &str, path: &str) -> Result<EditorFile> {
        valid_path(path)?;
        let sftp = self.ssh.sftp(session_id).await?;
        let absolute = sftp.canonicalize(path).await.map_err(sftp_error)?;
        // Reading through a link is allowed; the returned canonical path is explicit.
        read_editor(&sftp, &absolute).await
    }
    pub async fn save(
        &self,
        session_id: &str,
        path: &str,
        text: &str,
        expected_version: &str,
    ) -> Result<EditorFile> {
        valid_mutation_path(path)?;
        if text.len() as u64 > EDITOR_LIMIT {
            return Err(editor_too_large());
        }
        if text.contains('\0') {
            return Err(AppError::new(
                "BINARY_FILE",
                "Text editing does not support NUL bytes",
            ));
        }
        let lock_key = format!("{session_id}\0{path}");
        let lock = self
            .writes
            .lock()
            .await
            .entry(lock_key)
            .or_default()
            .clone();
        let _write = lock.lock().await;
        let sftp = self.ssh.sftp(session_id).await?;
        let old = optional_metadata(&sftp, path).await?;
        if old.as_ref().is_some_and(|m| !m.file_type().is_file()) {
            return Err(AppError::new("NOT_REGULAR_FILE", "Atomic editing supports regular files only; open a symbolic link's target explicitly"));
        }
        let current = match old.as_ref() {
            Some(_) => read_editor(&sftp, path).await?.version,
            None => "missing".to_owned(),
        };
        if current != expected_version {
            return Err(file_conflict());
        }
        let temporary = temporary_remote_path(path, &Uuid::new_v4().to_string())?;
        let result: Result<()> = async {
            let mut file = sftp
                .open_with_flags_and_attributes(
                    temporary.clone(),
                    OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUDE,
                    FileAttributes {
                        permissions: Some(0o600),
                        ..Default::default()
                    },
                )
                .await
                .map_err(sftp_error)?;
            file.write_all(text.as_bytes()).await?;
            file.flush().await?;
            file.sync_all().await.map_err(sftp_error)?;
            file.shutdown().await?;
            if let Some(meta) = &old {
                sftp.set_metadata(
                    temporary.clone(),
                    FileAttributes {
                        permissions: meta.permissions,
                        uid: meta.uid,
                        gid: meta.gid,
                        ..Default::default()
                    },
                )
                .await
                .map_err(|e| {
                    AppError::new(
                        "METADATA_PRESERVATION_FAILED",
                        format!("Original remains unchanged: {e}"),
                    )
                })?;
            }
            // Verify again after uploading, so stale buffers never silently overwrite edits
            // made while the upload was in flight. SFTP does not offer compare-and-swap.
            let latest_meta = optional_metadata(&sftp, path).await?;
            let latest = match latest_meta {
                Some(ref m) if m.file_type().is_file() => read_editor(&sftp, path).await?.version,
                Some(_) => return Err(file_conflict()),
                None => "missing".into(),
            };
            if latest != expected_version {
                return Err(file_conflict());
            }
            if old.is_some() {
                atomic_replace(&self.ssh, session_id, &temporary, path).await?;
            } else {
                sftp.rename(temporary.clone(), path)
                    .await
                    .map_err(sftp_error)?;
            }
            Ok(())
        }
        .await;
        if result.is_err() {
            let _ = sftp.remove_file(temporary).await;
        }
        result?;
        read_editor(&sftp, path).await
    }
}

pub(crate) async fn read_editor(sftp: &SftpSession, path: &str) -> Result<EditorFile> {
    let meta = sftp.metadata(path).await.map_err(sftp_error)?;
    if !meta.file_type().is_file() {
        return Err(AppError::new(
            "NOT_REGULAR_FILE",
            "Only regular files can be opened in the text editor",
        ));
    }
    if meta.size.unwrap_or(0) > EDITOR_LIMIT {
        return Err(editor_too_large());
    }
    let mut file = sftp.open(path).await.map_err(sftp_error)?;
    let mut bytes = Vec::new();
    let read = (&mut file)
        .take(EDITOR_LIMIT + 1)
        .read_to_end(&mut bytes)
        .await;
    let closed = file.shutdown().await;
    read?;
    closed?;
    if bytes.len() as u64 > EDITOR_LIMIT {
        return Err(editor_too_large());
    }
    if bytes.contains(&0) {
        return Err(AppError::new(
            "BINARY_FILE",
            "This file contains binary data; download it instead",
        ));
    }
    let version = content_version(&bytes, &meta);
    let size = bytes.len() as u64;
    let text = String::from_utf8(bytes).map_err(|_| {
        AppError::new(
            "UNSUPPORTED_ENCODING",
            "This editor preserves UTF-8 files only. Download other encodings for external editing",
        )
    })?;
    Ok(EditorFile {
        path: path.into(),
        text,
        version,
        size,
    })
}

pub(crate) fn content_version(bytes: &[u8], attrs: &FileAttributes) -> String {
    let mut hash = Sha256::new();
    hash.update(bytes);
    hash.update(format!(
        "\0{:?}:{:?}:{:?}:{:?}:{:?}",
        attrs.size, attrs.mtime, attrs.uid, attrs.gid, attrs.permissions
    ));
    hex::encode(hash.finalize())
}

/// OpenSSH extension supplies the overwrite semantics absent from SFTP v3 RENAME.
/// Failure is fail-closed: the original path is never removed as a fallback.
pub(crate) async fn atomic_replace(
    ssh: &SshManager,
    session: &str,
    from: &str,
    to: &str,
) -> Result<()> {
    let raw = ssh.sftp_raw(session).await?;
    let result = async {
        let version = raw.init().await.map_err(sftp_error)?;
        if version.extensions.get("posix-rename@openssh.com").map(String::as_str) != Some("1") {
            return Err(AppError::new("ATOMIC_REPLACE_UNSUPPORTED", "This server does not support atomic overwrite (posix-rename). Original is unchanged. Save under a new name instead"));
        }
        let mut payload = Vec::with_capacity(from.len() + to.len() + 8);
        for path in [from, to] { payload.extend_from_slice(&(path.len() as u32).to_be_bytes()); payload.extend_from_slice(path.as_bytes()); }
        match raw.extended("posix-rename@openssh.com", payload).await.map_err(sftp_error)? {
            Packet::Status(status) if status.status_code == StatusCode::Ok => Ok(()),
            Packet::Status(status) => Err(AppError::new("ATOMIC_REPLACE_FAILED", status.error_message)),
            _ => Err(AppError::new("SFTP_PROTOCOL_ERROR", "Unexpected response to atomic rename")),
        }
    }.await;
    let _ = raw.close_session();
    result
}

pub(crate) async fn optional_metadata(
    sftp: &SftpSession,
    path: &str,
) -> Result<Option<FileAttributes>> {
    match sftp.symlink_metadata(path).await {
        Ok(meta) => Ok(Some(meta)),
        Err(russh_sftp::client::error::Error::Status(status))
            if status.status_code == StatusCode::NoSuchFile =>
        {
            Ok(None)
        }
        Err(e) => Err(sftp_error(e)),
    }
}
pub(crate) fn sftp_error(e: impl std::fmt::Display) -> AppError {
    AppError::new("SFTP_ERROR", e.to_string())
}
pub(crate) fn valid_path(path: &str) -> Result<()> {
    if path.is_empty() || path.len() > 32768 || path.contains('\0') {
        return Err(AppError::new(
            "INVALID_PATH",
            "Path must be nonempty, contain no NUL bytes and be at most 32 KiB",
        ));
    }
    Ok(())
}
pub(crate) fn valid_mutation_path(path: &str) -> Result<()> {
    valid_path(path)?;
    if path
        .split('/')
        .all(|s| s.is_empty() || s == "." || s == "..")
        || path.ends_with("/..")
        || path.ends_with("/.")
    {
        return Err(AppError::new(
            "PROTECTED_PATH",
            "Choose a specific file or directory, not a root or parent path",
        ));
    }
    Ok(())
}
pub(crate) fn join_remote(parent: &str, name: &str) -> String {
    format!("{}/{}", parent.trim_end_matches('/'), name)
}
pub(crate) fn temporary_remote_path(path: &str, id: &str) -> Result<String> {
    valid_mutation_path(path)?;
    let (parent, name) = path.rsplit_once('/').unwrap_or((".", path));
    if name.is_empty() {
        return Err(AppError::new("INVALID_PATH", "A file name is required"));
    }
    Ok(join_remote(parent, &format!(".shell-ex-{id}.part")))
}
fn file_conflict() -> AppError {
    AppError::new(
        "FILE_CONFLICT",
        "The remote file changed after it was opened. Reload and merge changes before saving",
    )
}
fn editor_too_large() -> AppError {
    AppError::new(
        "FILE_TOO_LARGE",
        "The text editor supports files up to 5 MiB; download larger files instead",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn mutation_paths_protect_root_and_parent() {
        for path in ["", "/", ".", "..", "/tmp/..", "/tmp/.", "a\0b"] {
            assert!(valid_mutation_path(path).is_err(), "{path}");
        }
        assert!(valid_mutation_path("/tmp/file with ' quote").is_ok());
        assert_eq!(
            temporary_remote_path("/etc/config", "123").unwrap(),
            "/etc/.shell-ex-123.part"
        );
    }
    #[test]
    fn versions_detect_content_and_mode_changes() {
        let mut attrs = FileAttributes {
            size: Some(3),
            permissions: Some(0o644),
            ..Default::default()
        };
        let first = content_version(b"abc", &attrs);
        assert_ne!(first, content_version(b"abd", &attrs));
        attrs.permissions = Some(0o600);
        assert_ne!(first, content_version(b"abc", &attrs));
    }
}
