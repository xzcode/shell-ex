//! Directory copy is explicitly planned before creating any destinations. The
//! server-side plan owns the paths; the UI can only choose skip or overwrite.
use super::*;
use crate::files::{join_remote, valid_path};
use std::collections::VecDeque;

const MAX_ENTRIES: usize = 2048;
const MAX_DEPTH: usize = 32;
const PLAN_LIFETIME: std::time::Duration = std::time::Duration::from_secs(300);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryPlan {
    pub id: String,
    pub session_id: String,
    pub direction: String,
    pub local_root: String,
    pub remote_root: String,
    pub total_files: usize,
    pub total_bytes: u64,
    pub directories: usize,
    pub existing_files: usize,
    pub skipped_links: Vec<String>,
    pub expires_seconds: u64,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryStartResult {
    pub queued: usize,
    pub skipped: usize,
    pub transfer_ids: Vec<String>,
    pub errors: Vec<String>,
}
#[derive(Clone)]
struct Entry {
    local: String,
    remote: String,
    source_signature: String,
    is_dir: bool,
}
pub(super) struct PlanDetails {
    pub(super) summary: DirectoryPlan,
    entries: Vec<Entry>,
    created: Instant,
}

impl TransferManager {
    pub async fn plan_directory(
        &self,
        session_id: String,
        direction: String,
        local_root: String,
        remote_root: String,
    ) -> Result<DirectoryPlan> {
        self.inner.ssh.file_transfer_context(&session_id).await?;
        if direction != "upload" && direction != "download" {
            return Err(AppError::new(
                "INVALID_DIRECTION",
                "Choose upload or download",
            ));
        }
        if !Path::new(&local_root).is_absolute() {
            return Err(AppError::new(
                "INVALID_LOCAL_PATH",
                "Choose an absolute local directory path",
            ));
        }
        valid_path(&remote_root)?;
        let sftp = self.inner.ssh.sftp(&session_id).await?;
        let (local_root, remote_root) = if direction == "upload" {
            let meta = fs::symlink_metadata(&local_root).await?;
            if !meta.is_dir() || local_is_link(&meta) {
                return Err(AppError::new(
                    "NOT_DIRECTORY",
                    "Choose a local directory, not a symbolic link",
                ));
            }
            let local = local_path_string(&fs::canonicalize(&local_root).await?)?;
            let remote = normalize_destination_remote(&sftp, &remote_root).await?;
            require_remote_directory_or_missing(&sftp, &remote).await?;
            (local, remote)
        } else {
            let meta = sftp
                .symlink_metadata(remote_root.clone())
                .await
                .map_err(sftp_error)?;
            if !meta.file_type().is_dir() {
                return Err(AppError::new(
                    "NOT_DIRECTORY",
                    "Choose a remote directory, not a symbolic link",
                ));
            }
            let remote = sftp.canonicalize(remote_root).await.map_err(sftp_error)?;
            let local = normalize_destination_local(&local_root).await?;
            require_local_directory_or_missing(&local).await?;
            (local, remote)
        };
        let root_signature = if direction == "upload" {
            local_signature(&fs::symlink_metadata(&local_root).await?)
        } else {
            remote_signature(
                &sftp
                    .symlink_metadata(remote_root.clone())
                    .await
                    .map_err(sftp_error)?,
            )
        };
        let mut entries = vec![Entry {
            local: local_root.clone(),
            remote: remote_root.clone(),
            source_signature: root_signature,
            is_dir: true,
        }];
        let mut queue = VecDeque::from([(local_root.clone(), remote_root.clone(), 0usize)]);
        let mut skipped_links = Vec::new();
        let mut total_files = 0usize;
        let mut total_bytes = 0u64;
        let mut existing_files = 0usize;
        while let Some((local_parent, remote_parent, depth)) = queue.pop_front() {
            if depth >= MAX_DEPTH {
                return Err(AppError::new(
                    "DIRECTORY_DEPTH_LIMIT",
                    "Directory transfers support at most 32 nested levels",
                ));
            }
            if direction == "upload" {
                let mut children = fs::read_dir(&local_parent).await?;
                while let Some(child) = children.next_entry().await? {
                    let name = child.file_name().into_string().map_err(|_| {
                        AppError::new(
                            "UNSUPPORTED_PATH_ENCODING",
                            "A local file name is not valid UTF-8",
                        )
                    })?;
                    safe_name(&name)?;
                    let local = local_path_string(&child.path())?;
                    let remote = join_remote(&remote_parent, &name);
                    let attrs = fs::symlink_metadata(&local).await?;
                    if local_is_link(&attrs) {
                        skipped_links.push(local);
                        check_plan_size(entries.len(), total_files, skipped_links.len())?;
                        continue;
                    }
                    if !attrs.is_file() && !attrs.is_dir() {
                        return Err(AppError::new(
                            "SPECIAL_FILE_UNSUPPORTED",
                            format!("Cannot transfer device, socket or FIFO: {local}"),
                        ));
                    }
                    let is_dir = attrs.is_dir();
                    let destination = optional_metadata(&sftp, &remote).await?;
                    validate_destination_type(
                        destination.as_ref().map(|m| m.file_type().is_dir()),
                        destination.as_ref().map(|m| m.file_type().is_file()),
                        is_dir,
                        &remote,
                    )?;
                    if is_dir {
                        queue.push_back((local.clone(), remote.clone(), depth + 1));
                    } else {
                        total_files += 1;
                        total_bytes = total_bytes.checked_add(attrs.len()).ok_or_else(|| {
                            AppError::new(
                                "TOTAL_SIZE_OVERFLOW",
                                "Combined file size exceeds the supported range",
                            )
                        })?;
                        if destination.is_some() {
                            existing_files += 1;
                        }
                    }
                    entries.push(Entry {
                        local,
                        remote,
                        source_signature: local_signature(&attrs),
                        is_dir,
                    });
                    check_plan_size(entries.len(), total_files, skipped_links.len())?;
                }
            } else {
                let children = sftp
                    .read_dir(remote_parent.clone())
                    .await
                    .map_err(sftp_error)?;
                for child in children {
                    let name = child.file_name();
                    if name == "." || name == ".." {
                        continue;
                    }
                    safe_name(&name)?;
                    let remote = join_remote(&remote_parent, &name);
                    let local = local_path_string(&Path::new(&local_parent).join(&name))?;
                    let attrs = child.metadata();
                    if attrs.file_type().is_symlink() {
                        skipped_links.push(remote);
                        check_plan_size(entries.len(), total_files, skipped_links.len())?;
                        continue;
                    }
                    if !attrs.file_type().is_file() && !attrs.file_type().is_dir() {
                        return Err(AppError::new(
                            "SPECIAL_FILE_UNSUPPORTED",
                            format!("Cannot transfer device, socket or FIFO: {remote}"),
                        ));
                    }
                    let is_dir = attrs.file_type().is_dir();
                    let size = if is_dir {
                        0
                    } else {
                        attrs.size.ok_or_else(|| {
                            AppError::new(
                                "MISSING_FILE_SIZE",
                                format!("Server did not report size for {remote}"),
                            )
                        })?
                    };
                    let destination = local_metadata(&local).await?;
                    validate_destination_type(
                        destination
                            .as_ref()
                            .map(|m| m.is_dir() && !local_is_link(&m)),
                        destination
                            .as_ref()
                            .map(|m| m.is_file() && !local_is_link(&m)),
                        is_dir,
                        &local,
                    )?;
                    if is_dir {
                        queue.push_back((local.clone(), remote.clone(), depth + 1));
                    } else {
                        total_files += 1;
                        total_bytes = total_bytes.checked_add(size).ok_or_else(|| {
                            AppError::new(
                                "TOTAL_SIZE_OVERFLOW",
                                "Combined file size exceeds the supported range",
                            )
                        })?;
                        if destination.is_some() {
                            existing_files += 1;
                        }
                    }
                    entries.push(Entry {
                        local,
                        remote,
                        source_signature: remote_signature(&attrs),
                        is_dir,
                    });
                    check_plan_size(entries.len(), total_files, skipped_links.len())?;
                }
            }
        }
        let summary = DirectoryPlan {
            id: Uuid::new_v4().to_string(),
            session_id,
            direction,
            local_root,
            remote_root,
            total_files,
            total_bytes,
            directories: entries.iter().filter(|e| e.is_dir).count(),
            existing_files,
            skipped_links,
            expires_seconds: PLAN_LIFETIME.as_secs(),
        };
        let _registration = self.inner.registration.lock().await;
        self.inner.ssh.file_transfer_context(&summary.session_id).await?;
        let mut plans = self.inner.plans.lock().await;
        plans.retain(|_, p| p.created.elapsed() < PLAN_LIFETIME);
        while plans.len() >= 8 {
            let oldest = plans
                .iter()
                .min_by_key(|(_, p)| p.created)
                .map(|(id, _)| id.clone());
            if let Some(id) = oldest {
                plans.remove(&id);
            } else {
                break;
            }
        }
        plans.insert(
            summary.id.clone(),
            PlanDetails {
                summary: summary.clone(),
                entries,
                created: Instant::now(),
            },
        );
        Ok(summary)
    }

    pub async fn start_directory(
        &self,
        plan_id: &str,
        conflict: &str,
    ) -> Result<DirectoryStartResult> {
        if conflict != "skip" && conflict != "overwrite" {
            return Err(AppError::new(
                "INVALID_CONFLICT_POLICY",
                "Choose skip or overwrite for existing files",
            ));
        }
        let plan = self
            .inner
            .plans
            .lock()
            .await
            .remove(plan_id)
            .ok_or_else(|| {
                AppError::new(
                    "PLAN_NOT_FOUND",
                    "Directory plan expired or was already started; scan the directory again",
                )
            })?;
        let conflict = if plan.summary.direction == "download" {
            "skip"
        } else {
            conflict
        };
        if plan.created.elapsed() > PLAN_LIFETIME {
            return Err(AppError::new(
                "PLAN_EXPIRED",
                "Directory plan expired; scan the directory again",
            ));
        }
        let mut tasks = self.inner.tasks.lock().await;
        if tasks.len() + plan.summary.total_files > MAX_TASKS {
            prune_completed_tasks(&mut tasks);
        }
        if tasks.len() + plan.summary.total_files > MAX_TASKS {
            return Err(AppError::new(
                "TRANSFER_QUEUE_FULL",
                "This directory would exceed the 1,000-task queue limit",
            ));
        }
        drop(tasks);
        self.inner
            .ssh
            .file_transfer_context(&plan.summary.session_id)
            .await?;
        let sftp = self.inner.ssh.sftp(&plan.summary.session_id).await?;
        // Revalidate the whole source before any destination directories are created.
        for entry in &plan.entries {
            let signature = if plan.summary.direction == "upload" {
                let meta = fs::symlink_metadata(&entry.local).await?;
                if local_is_link(&meta)
                    || meta.is_dir() != entry.is_dir
                    || (!entry.is_dir && !meta.is_file())
                {
                    return Err(plan_changed(&entry.local));
                }
                local_signature(&meta)
            } else {
                let meta = sftp
                    .symlink_metadata(entry.remote.clone())
                    .await
                    .map_err(sftp_error)?;
                if meta.file_type().is_symlink()
                    || meta.file_type().is_dir() != entry.is_dir
                    || (!entry.is_dir && !meta.file_type().is_file())
                {
                    return Err(plan_changed(&entry.remote));
                }
                remote_signature(&meta)
            };
            if signature != entry.source_signature {
                return Err(plan_changed(if plan.summary.direction == "upload" {
                    &entry.local
                } else {
                    &entry.remote
                }));
            }
        }
        let mut result = DirectoryStartResult {
            queued: 0,
            skipped: plan.summary.skipped_links.len(),
            transfer_ids: Vec::new(),
            errors: Vec::new(),
        };
        for entry in plan.entries.iter().filter(|e| e.is_dir) {
            let prepared = if plan.summary.direction == "upload" {
                async {
                    let present = optional_metadata(&sftp, &entry.remote).await?;
                    if let Some(meta) = present {
                        if !meta.file_type().is_dir() {
                            return Err(AppError::new(
                                "UNSAFE_DESTINATION",
                                format!("Destination is not a directory: {}", entry.remote),
                            ));
                        }
                    } else {
                        sftp.create_dir(entry.remote.clone())
                            .await
                            .map_err(sftp_error)?;
                    }
                    Ok(())
                }
                .await
            } else {
                async {
                    let present = local_metadata(&entry.local).await?;
                    if let Some(meta) = present {
                        if !meta.is_dir() || local_is_link(&meta) {
                            return Err(AppError::new(
                                "UNSAFE_DESTINATION",
                                format!("Destination is not a directory: {}", entry.local),
                            ));
                        }
                    } else {
                        fs::create_dir(&entry.local).await?;
                    }
                    Ok(())
                }
                .await
            };
            if let Err(error) = prepared {
                result.errors.push(error.to_string());
                return Ok(result);
            }
        }
        for entry in plan.entries.into_iter().filter(|e| !e.is_dir) {
            let existing = if plan.summary.direction == "upload" {
                optional_metadata(&sftp, &entry.remote)
                    .await
                    .map(|m| m.is_some())
            } else {
                local_metadata(&entry.local).await.map(|m| m.is_some())
            };
            match existing {
                Ok(true) if conflict == "skip" => {
                    result.skipped += 1;
                    continue;
                }
                Err(error) => {
                    result.errors.push(error.to_string());
                    continue;
                }
                _ => {}
            }
            let task = self
                .start(
                    plan.summary.session_id.clone(),
                    plan.summary.direction.clone(),
                    entry.local,
                    entry.remote,
                    conflict == "overwrite",
                )
                .await;
            match task {
                Ok(task) => {
                    result.queued += 1;
                    result.transfer_ids.push(task.id);
                }
                Err(error) => result.errors.push(error.to_string()),
            }
        }
        Ok(result)
    }
}

fn check_plan_size(entries: usize, files: usize, links: usize) -> Result<()> {
    if entries + links > MAX_ENTRIES || files > MAX_TASKS {
        return Err(AppError::new(
            "DIRECTORY_TOO_LARGE",
            "A directory copy supports at most 1,000 files and 2,048 total entries",
        ));
    }
    Ok(())
}
fn safe_name(name: &str) -> Result<()> {
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.contains('/')
        || name.contains('\\')
        || name.contains('\0')
    {
        return Err(AppError::new(
            "UNSAFE_FILE_NAME",
            format!("Unsafe child file name: {name:?}"),
        ));
    }
    #[cfg(windows)]
    {
        let base = name.split('.').next().unwrap_or("").to_ascii_uppercase();
        if name.contains([':', '*', '?', '"', '<', '>', '|'])
            || name.ends_with(['.', ' '])
            || matches!(base.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || ((base.starts_with("COM") || base.starts_with("LPT"))
                && base.len() == 4
                && matches!(base.as_bytes()[3], b'1'..=b'9'))
        {
            return Err(AppError::new(
                "UNSUPPORTED_FILE_NAME",
                format!("File name cannot be represented safely on Windows: {name}"),
            ));
        }
    }
    Ok(())
}
fn local_path_string(path: &Path) -> Result<String> {
    path.to_str().map(ToOwned::to_owned).ok_or_else(|| {
        AppError::new(
            "UNSUPPORTED_PATH_ENCODING",
            "A local path is not valid UTF-8",
        )
    })
}
async fn normalize_destination_local(path: &str) -> Result<String> {
    let p = Path::new(path);
    let name = p
        .file_name()
        .ok_or_else(|| AppError::new("INVALID_LOCAL_PATH", "Select a destination folder name"))?;
    let parent = p.parent().ok_or_else(|| {
        AppError::new(
            "INVALID_LOCAL_PATH",
            "Destination needs an existing parent directory",
        )
    })?;
    let parent = fs::canonicalize(parent).await?;
    local_path_string(&parent.join(name))
}
async fn normalize_destination_remote(sftp: &SftpSession, path: &str) -> Result<String> {
    let clean = path.trim_end_matches('/');
    valid_mutation_path(clean)?;
    let (parent, name) = clean.rsplit_once('/').unwrap_or((".", clean));
    safe_name(name)?;
    let parent = sftp
        .canonicalize(if parent.is_empty() { "/" } else { parent })
        .await
        .map_err(sftp_error)?;
    Ok(join_remote(&parent, name))
}
async fn require_remote_directory_or_missing(sftp: &SftpSession, path: &str) -> Result<()> {
    if optional_metadata(sftp, path)
        .await?
        .is_some_and(|m| !m.file_type().is_dir())
    {
        return Err(AppError::new(
            "UNSAFE_DESTINATION",
            "Remote destination exists and is not a directory",
        ));
    }
    Ok(())
}
async fn require_local_directory_or_missing(path: &str) -> Result<()> {
    if local_metadata(path)
        .await?
        .is_some_and(|m| !m.is_dir() || local_is_link(&m))
    {
        return Err(AppError::new(
            "UNSAFE_DESTINATION",
            "Local destination exists and is not a directory",
        ));
    }
    Ok(())
}
fn validate_destination_type(
    is_dir: Option<bool>,
    is_file: Option<bool>,
    source_dir: bool,
    path: &str,
) -> Result<()> {
    if (source_dir && is_dir == Some(false)) || (!source_dir && is_file == Some(false)) {
        return Err(AppError::new(
            "DESTINATION_TYPE_CONFLICT",
            format!("Destination type conflicts with source or is a symbolic link: {path}"),
        ));
    }
    Ok(())
}
fn plan_changed(path: &str) -> AppError {
    AppError::new(
        "DIRECTORY_PLAN_STALE",
        format!("Source changed after the preview. Scan again: {path}"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn download_children_cannot_escape_selected_directory() {
        for name in ["..", ".", "a/b", "a\\b", "nul\0x"] {
            assert!(safe_name(name).is_err());
        }
        assert!(safe_name("my config 'quoted'.txt").is_ok());
    }
}
