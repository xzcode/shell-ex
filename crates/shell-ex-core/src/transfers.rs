//! Bounded transfer queue. Both directions stage to a private sibling, validate
//! SHA-256, and publish only after completion. Pause/resume verifies the source
//! and the entire transferred prefix before continuing.
use crate::{
    error::{AppError, Result},
    files::{
        atomic_replace, join_remote, optional_metadata, sftp_error, temporary_remote_path,
        valid_mutation_path,
    },
    ssh::{shell_quote, SshManager},
};
use russh_sftp::{
    client::SftpSession,
    protocol::{FileAttributes, OpenFlags},
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    path::Path,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::{Instant, UNIX_EPOCH},
};
use tokio::{
    fs,
    io::{AsyncRead, AsyncReadExt, AsyncSeekExt, AsyncWriteExt, SeekFrom},
    sync::{watch, Mutex, Notify},
};
use uuid::Uuid;

const CHUNK: usize = 64 * 1024;
const MAX_TASKS: usize = 1000;

#[path = "directory_transfers.rs"]
mod directory_transfers;
pub use directory_transfers::{DirectoryPlan, DirectoryStartResult};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Transfer {
    pub id: String,
    pub session_id: String,
    pub direction: String,
    pub local_path: String,
    pub remote_path: String,
    pub status: String,
    pub transferred: u64,
    pub total: u64,
    pub speed: f64,
    pub error: Option<String>,
}
#[derive(Clone, Copy, Debug, PartialEq)]
enum Control {
    Run,
    Pause,
    Cancel,
}

#[derive(Clone)]
struct Baseline {
    source_signature: String,
    source_hash: Vec<u8>,
    total: u64,
    destination_signature: Option<String>,
    destination_hash: Option<Vec<u8>>,
    destination_attributes: Option<FileAttributes>,
    partial: String,
}
struct Task {
    record: Mutex<Transfer>,
    baseline: Mutex<Option<Baseline>>,
    control: watch::Sender<Control>,
    overwrite: bool,
    archive_dir: Option<String>,
}
struct Inner {
    ssh: Arc<SshManager>,
    tasks: Mutex<BTreeMap<String, Arc<Task>>>,
    plans: Mutex<BTreeMap<String, directory_transfers::PlanDetails>>,
    concurrency: AtomicUsize,
    active: AtomicUsize,
    available: Notify,
}
#[derive(Clone)]
pub struct TransferManager {
    inner: Arc<Inner>,
}

struct Slot(Arc<Inner>);
impl Drop for Slot {
    fn drop(&mut self) {
        self.0.active.fetch_sub(1, Ordering::SeqCst);
        self.0.available.notify_waiters();
    }
}

impl TransferManager {
    pub fn new(ssh: Arc<SshManager>, concurrency: usize) -> Self {
        Self {
            inner: Arc::new(Inner {
                ssh,
                tasks: Mutex::new(BTreeMap::new()),
                plans: Mutex::new(BTreeMap::new()),
                concurrency: AtomicUsize::new(concurrency.clamp(1, 8)),
                active: AtomicUsize::new(0),
                available: Notify::new(),
            }),
        }
    }
    pub fn set_concurrency(&self, concurrency: usize) {
        self.inner
            .concurrency
            .store(concurrency.clamp(1, 8), Ordering::SeqCst);
        self.inner.available.notify_waiters();
    }
    pub async fn start(
        &self,
        session_id: String,
        direction: String,
        local_path: String,
        remote_path: String,
        overwrite: bool,
    ) -> Result<Transfer> {
        self.start_owned(
            session_id,
            direction,
            local_path,
            remote_path,
            overwrite,
            None,
        )
        .await
    }

    /// Downloads always use atomic no-replace publication. Existing files,
    /// including symbolic links, are never implicitly overwritten.
    pub async fn download_destination_exists(local_path: &str) -> Result<bool> {
        let path = Path::new(local_path);
        if !path.is_absolute() || path.file_name().is_none() || local_path.contains('\0') {
            return Err(AppError::new(
                "INVALID_LOCAL_PATH",
                "Choose an absolute local file path",
            ));
        }
        Ok(local_metadata(local_path).await?.is_some())
    }

    async fn start_owned(
        &self,
        session_id: String,
        direction: String,
        local_path: String,
        remote_path: String,
        overwrite: bool,
        archive_dir: Option<String>,
    ) -> Result<Transfer> {
        if direction != "upload" && direction != "download" {
            return Err(AppError::new(
                "INVALID_DIRECTION",
                "Choose upload or download",
            ));
        }
        if direction == "download" && overwrite {
            return Err(AppError::new(
                "DOWNLOAD_OVERWRITE_DISABLED",
                "Downloads never overwrite existing local files",
            ));
        }
        valid_mutation_path(&remote_path)?;
        let (remote_parent, remote_name) =
            remote_path.rsplit_once('/').unwrap_or((".", &remote_path));
        let remote_parent = if remote_parent.is_empty() {
            "/"
        } else {
            remote_parent
        };
        let sftp = self.inner.ssh.sftp(&session_id).await?;
        let remote_parent = sftp.canonicalize(remote_parent).await.map_err(sftp_error)?;
        let remote_path = join_remote(&remote_parent, remote_name);
        let path = Path::new(&local_path);
        if !path.is_absolute() || path.file_name().is_none() || local_path.contains('\0') {
            return Err(AppError::new(
                "INVALID_LOCAL_PATH",
                "Choose an absolute local file path",
            ));
        }
        // Resolve the local directory once; staging stays beside the chosen file.
        let parent = fs::canonicalize(
            path.parent()
                .ok_or_else(|| AppError::new("INVALID_LOCAL_PATH", "Missing parent"))?,
        )
        .await?;
        let normalized = parent.join(
            path.file_name()
                .ok_or_else(|| AppError::new("INVALID_LOCAL_PATH", "Missing file name"))?,
        );
        let normalized_string = normalized
            .to_str()
            .ok_or_else(|| {
                AppError::new(
                    "UNSUPPORTED_PATH_ENCODING",
                    "The local directory path is not valid UTF-8",
                )
            })?
            .to_owned();
        if direction == "download" && local_metadata(&normalized_string).await?.is_some() {
            return Err(destination_exists());
        }
        let mut tasks = self.inner.tasks.lock().await;
        if tasks.len() >= MAX_TASKS {
            prune_completed_tasks(&mut tasks);
        }
        if tasks.len() >= MAX_TASKS {
            return Err(AppError::new(
                "TRANSFER_QUEUE_FULL",
                "The queue has 1,000 unfinished tasks; complete or cancel some transfers first",
            ));
        }
        // Prevent two tasks racing to publish to one destination.
        for task in tasks.values() {
            let item = task.record.lock().await;
            let same_destination = if direction == "upload" {
                item.direction == direction
                    && item.session_id == session_id
                    && item.remote_path == remote_path
            } else {
                item.direction == direction && item.local_path == normalized_string
            };
            if same_destination && !matches!(item.status.as_str(), "completed" | "cancelled") {
                return Err(AppError::new(
                    "DESTINATION_BUSY",
                    "Another transfer owns this destination; finish or cancel it first",
                ));
            }
        }
        let record = Transfer {
            id: Uuid::new_v4().to_string(),
            session_id,
            direction,
            local_path: normalized_string,
            remote_path,
            status: "queued".into(),
            transferred: 0,
            total: 0,
            speed: 0.0,
            error: None,
        };
        let (control, receiver) = watch::channel(Control::Run);
        let task = Arc::new(Task {
            record: Mutex::new(record.clone()),
            baseline: Mutex::new(None),
            control,
            overwrite,
            archive_dir,
        });
        tasks.insert(record.id.clone(), task.clone());
        drop(tasks);
        let manager = self.clone();
        tokio::spawn(async move {
            manager.worker(task, receiver).await;
        });
        Ok(record)
    }
    /// Create a private remote archive of selected siblings, then queue a
    /// normal verified download. Paths are quoted as literal shell arguments.
    /// Only the owned temporary archive is cleaned up, never source entries.
    pub async fn start_archive_download(
        &self,
        session_id: String,
        paths: Vec<String>,
        local_path: String,
    ) -> Result<Transfer> {
        if Self::download_destination_exists(&local_path).await? {
            return Err(destination_exists());
        }
        let (parent, names) = archive_selection(&paths)?;
        let sftp = self.inner.ssh.sftp(&session_id).await?;
        if sftp.canonicalize(&parent).await.map_err(sftp_error)? != parent {
            return Err(AppError::new(
                "INVALID_ARCHIVE_SELECTION",
                "Select files in a canonical directory",
            ));
        }
        for path in &paths {
            let meta = sftp.symlink_metadata(path).await.map_err(sftp_error)?;
            if !meta.file_type().is_file() && !meta.file_type().is_dir() {
                return Err(AppError::new(
                    "INVALID_ARCHIVE_SELECTION",
                    "Select regular files or directories, not links or special files",
                ));
            }
        }
        let directory = format!("/tmp/.shell-ex-pack-{}", Uuid::new_v4());
        let archive = join_remote(&directory, "archive.tar.gz");
        let command = format!(
            "umask 077; TAR_OPTIONS= tar --one-file-system -czf {} -C {} -- {}",
            shell_quote(&archive),
            shell_quote(&parent),
            names
                .iter()
                .map(|name| shell_quote(name))
                .collect::<Vec<_>>()
                .join(" "),
        );
        if command.len() > 60_000 {
            return Err(AppError::new(
                "INVALID_ARCHIVE_SELECTION",
                "Selection exceeds the archive command size limit",
            ));
        }
        let created = self
            .inner
            .ssh
            .exec(
                &session_id,
                &format!("mkdir -m 700 -- {}", shell_quote(&directory)),
            )
            .await?;
        if created.status != 0 {
            return Err(AppError::new("ARCHIVE_CREATE_FAILED", created.stderr));
        }
        let result = async {
            let packed = self
                .inner
                .ssh
                .exec_with_timeout(&session_id, &command, std::time::Duration::from_secs(300))
                .await?;
            if packed.status != 0 {
                return Err(AppError::new("ARCHIVE_CREATE_FAILED", packed.stderr));
            }
            self.start_owned(
                session_id.clone(),
                "download".into(),
                local_path,
                archive.clone(),
                false,
                Some(directory.clone()),
            )
            .await
        }
        .await;
        if let Err(error) = result {
            if let Err(cleanup) = self.remove_archive(&session_id, &directory).await {
                return Err(AppError::new(
                    "ARCHIVE_CLEANUP_FAILED",
                    format!(
                        "{}; temporary archive cleanup failed at {}: {}",
                        error.message, directory, cleanup.message
                    ),
                ));
            }
            return Err(error);
        }
        result
    }

    async fn remove_archive(&self, session_id: &str, directory: &str) -> Result<()> {
        let sftp = self.inner.ssh.sftp(session_id).await?;
        let archive = join_remote(directory, "archive.tar.gz");
        if optional_metadata(&sftp, &archive).await?.is_some() {
            sftp.remove_file(archive).await.map_err(sftp_error)?;
        }
        sftp.remove_dir(directory).await.map_err(sftp_error)
    }

    async fn cleanup_archive(&self, task: &Task) -> Option<String> {
        let directory = task.archive_dir.as_ref()?;
        let session_id = task.record.lock().await.session_id.clone();
        self.remove_archive(&session_id, directory)
            .await
            .err()
            .map(|error| {
                format!(
                    "Temporary archive cleanup failed at {directory}: {}",
                    error.message
                )
            })
    }
    pub async fn list(&self) -> Vec<Transfer> {
        let tasks: Vec<_> = self.inner.tasks.lock().await.values().cloned().collect();
        let mut records = Vec::with_capacity(tasks.len());
        for task in tasks {
            records.push(task.record.lock().await.clone());
        }
        records
    }
    pub async fn control(&self, id: &str, action: &str) -> Result<()> {
        let task = self
            .inner
            .tasks
            .lock()
            .await
            .get(id)
            .cloned()
            .ok_or_else(|| AppError::new("TRANSFER_NOT_FOUND", "Transfer no longer exists"))?;
        let mut record = task.record.lock().await;
        if matches!(
            record.status.as_str(),
            "completed" | "cancelled" | "committing"
        ) {
            return Err(AppError::new(
                "TRANSFER_FINISHED",
                "This transfer cannot change state now",
            ));
        }
        let (control, status) = match action {
            "pause" => (Control::Pause, "pausing"),
            "resume" => (Control::Run, "queued"),
            "cancel" => (Control::Cancel, "cancelling"),
            _ => {
                return Err(AppError::new(
                    "INVALID_ACTION",
                    "Choose pause, resume or cancel",
                ))
            }
        };
        task.control
            .send(control)
            .map_err(|_| AppError::new("TRANSFER_FINISHED", "Transfer is no longer active"))?;
        record.status = status.into();
        record.speed = 0.0;
        record.error = None;
        self.inner.available.notify_waiters();
        Ok(())
    }
    pub async fn cancel_session(&self, session_id: &str) {
        for record in self.list().await {
            if record.session_id == session_id
                && !matches!(record.status.as_str(), "completed" | "cancelled")
            {
                let _ = self.control(&record.id, "cancel").await;
            }
        }
        let _ = tokio::time::timeout(std::time::Duration::from_secs(35), async {
            loop {
                if self
                    .list()
                    .await
                    .iter()
                    .filter(|r| r.session_id == session_id)
                    .all(|r| matches!(r.status.as_str(), "completed" | "cancelled" | "failed"))
                {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(25)).await;
            }
        })
        .await;
    }
    pub async fn cancel_all(&self) {
        for record in self.list().await {
            let _ = self.control(&record.id, "cancel").await;
        }
    }

    async fn acquire(&self, control: &mut watch::Receiver<Control>) -> Option<Slot> {
        loop {
            let notified = self.inner.available.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if *control.borrow() != Control::Run {
                return None;
            }
            let active = self.inner.active.load(Ordering::SeqCst);
            if active < self.inner.concurrency.load(Ordering::SeqCst)
                && self
                    .inner
                    .active
                    .compare_exchange(active, active + 1, Ordering::SeqCst, Ordering::SeqCst)
                    .is_ok()
            {
                return Some(Slot(self.inner.clone()));
            }
            tokio::select! { _ = &mut notified => {}, _ = control.changed() => {} }
        }
    }
    async fn worker(&self, task: Arc<Task>, mut control: watch::Receiver<Control>) {
        loop {
            let requested = *control.borrow_and_update();
            if requested == Control::Cancel {
                let partial_error = self.cleanup(&task).await;
                let archive_error = self.cleanup_archive(&task).await;
                let cleanup_error = match (partial_error, archive_error) {
                    (Some(a), Some(b)) => Some(format!("{a}; {b}")),
                    (a, b) => a.or(b),
                };
                set_state(&task, "cancelled", cleanup_error).await;
                return;
            }
            if requested == Control::Pause {
                let failed = task.record.lock().await.status == "failed";
                if !failed {
                    set_state(&task, "paused", None).await;
                }
                if control.changed().await.is_err() {
                    return;
                }
                continue;
            }
            let Some(slot) = self.acquire(&mut control).await else {
                continue;
            };
            let result = self.attempt(&task, &control).await;
            drop(slot);
            match result {
                Ok(()) => {
                    let cleanup_error = self.cleanup_archive(&task).await;
                    set_state(&task, "completed", cleanup_error).await;
                    return;
                }
                Err(e) if e.code == "TRANSFER_PAUSED" || e.code == "TRANSFER_CANCELLED" => continue,
                Err(e) => {
                    // Preserve the partial for explicit, validated resume; failures do not
                    // loop or repeatedly consume bandwidth without user action.
                    task.control.send_replace(Control::Pause);
                    set_state(&task, "failed", Some(e.message)).await;
                }
            }
        }
    }
    async fn attempt(&self, task: &Task, control: &watch::Receiver<Control>) -> Result<()> {
        check_control(control)?;
        set_state(task, "validating", None).await;
        let item = task.record.lock().await.clone();
        let sftp = self.inner.ssh.sftp(&item.session_id).await?;
        let mut baseline_guard = task.baseline.lock().await;
        let baseline = match baseline_guard.as_ref() {
            Some(value) => value.clone(),
            None => {
                let value = self.prepare(&sftp, &item, task.overwrite, control).await?;
                *baseline_guard = Some(value.clone());
                value
            }
        };
        drop(baseline_guard);
        task.record.lock().await.total = baseline.total;
        if item.direction == "upload" {
            self.upload(&sftp, task, &item, &baseline, control).await
        } else {
            self.download(&sftp, task, &item, &baseline, control).await
        }
    }
    async fn prepare(
        &self,
        sftp: &SftpSession,
        item: &Transfer,
        overwrite: bool,
        control: &watch::Receiver<Control>,
    ) -> Result<Baseline> {
        if item.direction == "upload" {
            let local = local_metadata(&item.local_path)
                .await?
                .ok_or_else(|| AppError::new("SOURCE_MISSING", "Local source no longer exists"))?;
            if !local.is_file() || local_is_link(&local) {
                return Err(AppError::new(
                    "NOT_REGULAR_FILE",
                    "Upload supports regular files only",
                ));
            }
            let destination = optional_metadata(sftp, &item.remote_path).await?;
            validate_remote_destination(destination.as_ref(), overwrite)?;
            let destination_hash = match destination.as_ref() {
                Some(meta) => Some(
                    hash_remote(sftp, &item.remote_path, meta.size.unwrap_or(0), control).await?,
                ),
                None => None,
            };
            let source_hash = hash_local(&item.local_path, local.len(), control).await?;
            let signature = local_signature(&local);
            if local_signature(&fs::symlink_metadata(&item.local_path).await?) != signature {
                return Err(source_changed());
            }
            let partial = temporary_remote_path(&item.remote_path, &item.id)?;
            let mut file = sftp
                .open_with_flags_and_attributes(
                    partial.clone(),
                    OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE,
                    FileAttributes {
                        permissions: Some(0o600),
                        ..Default::default()
                    },
                )
                .await
                .map_err(sftp_error)?;
            file.shutdown().await?;
            Ok(Baseline {
                source_signature: signature,
                source_hash,
                total: local.len(),
                destination_signature: destination.as_ref().map(remote_signature),
                destination_hash,
                destination_attributes: destination,
                partial,
            })
        } else {
            let remote = optional_metadata(sftp, &item.remote_path)
                .await?
                .ok_or_else(|| AppError::new("SOURCE_MISSING", "Remote source no longer exists"))?;
            if !remote.file_type().is_file() {
                return Err(AppError::new(
                    "NOT_REGULAR_FILE",
                    "Download supports regular files; open symbolic link targets explicitly",
                ));
            }
            let total = remote.size.ok_or_else(|| {
                AppError::new("MISSING_FILE_SIZE", "Server did not report the file size")
            })?;
            let destination = local_metadata(&item.local_path).await?;
            if destination.is_some() {
                return Err(destination_exists());
            }
            let source_hash = hash_remote(sftp, &item.remote_path, total, control).await?;
            if remote_signature(
                &sftp
                    .metadata(item.remote_path.clone())
                    .await
                    .map_err(sftp_error)?,
            ) != remote_signature(&remote)
            {
                return Err(source_changed());
            }
            let partial =
                Path::new(&item.local_path).with_file_name(format!(".shell-ex-{}.part", item.id));
            let mut options = fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                options.mode(0o600);
            }
            options.open(&partial).await?;
            Ok(Baseline {
                source_signature: remote_signature(&remote),
                source_hash,
                total,
                destination_signature: None,
                destination_hash: None,
                destination_attributes: None,
                partial: partial.to_string_lossy().into_owned(),
            })
        }
    }
    async fn upload(
        &self,
        sftp: &SftpSession,
        task: &Task,
        item: &Transfer,
        baseline: &Baseline,
        control: &watch::Receiver<Control>,
    ) -> Result<()> {
        if local_signature(&fs::symlink_metadata(&item.local_path).await?)
            != baseline.source_signature
        {
            return Err(source_changed());
        }
        if hash_local(&item.local_path, baseline.total, control).await? != baseline.source_hash {
            return Err(source_changed());
        }
        let partial = sftp
            .symlink_metadata(baseline.partial.clone())
            .await
            .map_err(sftp_error)?;
        if !partial.file_type().is_file() {
            return Err(AppError::new(
                "UNSAFE_PARTIAL",
                "Partial upload was replaced",
            ));
        }
        let offset = partial.size.unwrap_or(0);
        if offset > baseline.total {
            return Err(prefix_changed());
        }
        let local_prefix = hash_local_prefix(&item.local_path, offset, control).await?;
        let remote_prefix = hash_remote_prefix(sftp, &baseline.partial, offset, control).await?;
        if local_prefix != remote_prefix {
            return Err(prefix_changed());
        }
        let mut source = fs::File::open(&item.local_path).await?;
        let mut destination = sftp
            .open_with_flags(baseline.partial.clone(), OpenFlags::WRITE)
            .await
            .map_err(sftp_error)?;
        source.seek(SeekFrom::Start(offset)).await?;
        destination.seek(SeekFrom::Start(offset)).await?;
        let copied = copy_bounded(
            &mut source,
            &mut destination,
            task,
            offset,
            baseline.total,
            control,
        )
        .await;
        let flush = destination.flush().await;
        let sync = if copied.is_ok() {
            destination.sync_all().await.map_err(sftp_error)
        } else {
            Ok(())
        };
        let close = destination.shutdown().await;
        copied?;
        flush?;
        sync?;
        close?;
        set_state(task, "verifying", None).await;
        if hash_remote(sftp, &baseline.partial, baseline.total, control).await?
            != baseline.source_hash
        {
            return Err(AppError::new(
                "CHECKSUM_MISMATCH",
                "Uploaded bytes did not match the source; original destination is unchanged",
            ));
        }
        let current = optional_metadata(sftp, &item.remote_path).await?;
        if current.as_ref().map(remote_signature) != baseline.destination_signature {
            return Err(destination_changed());
        }
        if let Some(meta) = current.as_ref() {
            if Some(hash_remote(sftp, &item.remote_path, meta.size.unwrap_or(0), control).await?)
                != baseline.destination_hash
            {
                return Err(destination_changed());
            }
        }
        if let Some(attrs) = &baseline.destination_attributes {
            sftp.set_metadata(
                baseline.partial.clone(),
                FileAttributes {
                    permissions: attrs.permissions,
                    uid: attrs.uid,
                    gid: attrs.gid,
                    ..Default::default()
                },
            )
            .await
            .map_err(sftp_error)?;
        }
        begin_commit(task, control).await?;
        if current.is_some() {
            atomic_replace(
                &self.inner.ssh,
                &item.session_id,
                &baseline.partial,
                &item.remote_path,
            )
            .await?;
        } else {
            sftp.rename(baseline.partial.clone(), item.remote_path.clone())
                .await
                .map_err(sftp_error)?;
        }
        Ok(())
    }
    async fn download(
        &self,
        sftp: &SftpSession,
        task: &Task,
        item: &Transfer,
        baseline: &Baseline,
        control: &watch::Receiver<Control>,
    ) -> Result<()> {
        let remote = sftp
            .symlink_metadata(item.remote_path.clone())
            .await
            .map_err(sftp_error)?;
        if !remote.file_type().is_file() || remote_signature(&remote) != baseline.source_signature {
            return Err(source_changed());
        }
        if hash_remote(sftp, &item.remote_path, baseline.total, control).await?
            != baseline.source_hash
        {
            return Err(source_changed());
        }
        let partial = fs::symlink_metadata(&baseline.partial).await?;
        if !partial.is_file() || local_is_link(&partial) || partial.len() > baseline.total {
            return Err(prefix_changed());
        }
        let offset = partial.len();
        if hash_remote_prefix(sftp, &item.remote_path, offset, control).await?
            != hash_local_prefix(&baseline.partial, offset, control).await?
        {
            return Err(prefix_changed());
        }
        let mut source = sftp
            .open(item.remote_path.clone())
            .await
            .map_err(sftp_error)?;
        let mut destination = fs::OpenOptions::new()
            .write(true)
            .open(&baseline.partial)
            .await?;
        source.seek(SeekFrom::Start(offset)).await?;
        destination.seek(SeekFrom::Start(offset)).await?;
        let copied = copy_bounded(
            &mut source,
            &mut destination,
            task,
            offset,
            baseline.total,
            control,
        )
        .await;
        let flush = destination.flush().await;
        let sync = destination.sync_all().await;
        let close = source.shutdown().await;
        drop(destination);
        copied?;
        flush?;
        sync?;
        close?;
        set_state(task, "verifying", None).await;
        if hash_local(&baseline.partial, baseline.total, control).await? != baseline.source_hash {
            return Err(AppError::new(
                "CHECKSUM_MISMATCH",
                "Downloaded bytes did not match the source; original destination is unchanged",
            ));
        }
        if local_metadata(&item.local_path).await?.is_some() {
            return Err(destination_changed());
        }
        begin_commit(task, control).await?;
        publish_download_no_replace(&baseline.partial, &item.local_path).await?;
        #[cfg(unix)]
        {
            if let Some(parent) = Path::new(&item.local_path).parent() {
                if let Ok(dir) = fs::File::open(parent).await {
                    let _ = dir.sync_all().await;
                }
            }
        }
        Ok(())
    }
    async fn cleanup(&self, task: &Task) -> Option<String> {
        let item = task.record.lock().await.clone();
        let baseline = task.baseline.lock().await.clone();
        if let Some(baseline) = baseline {
            if item.direction == "upload" {
                let result = async {
                    let sftp = self.inner.ssh.sftp(&item.session_id).await?;
                    sftp.remove_file(baseline.partial.clone())
                        .await
                        .map_err(sftp_error)
                }
                .await;
                if let Err(error) = result {
                    return Some(format!(
                        "Cancelled; staging cleanup failed at {}: {}",
                        baseline.partial, error.message
                    ));
                }
            } else if let Err(error) = fs::remove_file(&baseline.partial).await {
                if error.kind() != std::io::ErrorKind::NotFound {
                    return Some(format!(
                        "Cancelled; staging cleanup failed at {}: {error}",
                        baseline.partial
                    ));
                }
            }
        }
        None
    }
}

fn archive_selection(paths: &[String]) -> Result<(String, Vec<String>)> {
    if paths.is_empty() || paths.len() > 256 {
        return Err(AppError::new(
            "INVALID_ARCHIVE_SELECTION",
            "Select 1 to 256 files or directories",
        ));
    }
    let mut parent: Option<String> = None;
    let mut names = Vec::new();
    for path in paths {
        valid_mutation_path(path)?;
        if ["/tmp", "/proc", "/sys", "/dev", "/run"].contains(&path.as_str())
            || ["/proc/", "/sys/", "/dev/", "/run/"]
                .iter()
                .any(|p| path.starts_with(p))
        {
            return Err(AppError::new(
                "INVALID_ARCHIVE_SELECTION",
                "System mount roots and the archive staging root cannot be packed",
            ));
        }
        if !path.starts_with('/')
            || path.contains(['\r', '\n'])
            || path.split('/').any(|p| p == "." || p == "..")
        {
            return Err(AppError::new(
                "INVALID_ARCHIVE_SELECTION",
                "Select absolute, unambiguous paths",
            ));
        }
        let (dir, name) = path.rsplit_once('/').unwrap();
        let dir = if dir.is_empty() { "/" } else { dir };
        if name.is_empty()
            || parent.as_deref().is_some_and(|p| p != dir)
            || names.iter().any(|n| n == name)
        {
            return Err(AppError::new(
                "INVALID_ARCHIVE_SELECTION",
                "Select distinct entries from the same directory",
            ));
        }
        parent = Some(dir.to_owned());
        names.push(name.to_owned());
    }
    Ok((parent.unwrap(), names))
}

async fn publish_download_no_replace(partial: &str, destination: &str) -> Result<()> {
    // Atomic create-no-replace on the same filesystem. A racing creator wins.
    fs::hard_link(partial, destination).await.map_err(|error| {
        if error.kind() == std::io::ErrorKind::AlreadyExists {
            destination_exists()
        } else {
            AppError::new("ATOMIC_LOCAL_PUBLISH_FAILED", format!(
                "Could not publish without overwriting another file. Choose a filesystem supporting hard links. Verified partial remains at {partial}. {error}"
            ))
        }
    })?;
    let _ = fs::remove_file(partial).await;
    Ok(())
}

async fn begin_commit(task: &Task, control: &watch::Receiver<Control>) -> Result<()> {
    let mut record = task.record.lock().await;
    check_control(control)?;
    record.status = "committing".into();
    record.speed = 0.0;
    Ok(())
}
async fn set_state(task: &Task, status: &str, error: Option<String>) {
    let mut item = task.record.lock().await;
    item.status = status.into();
    item.error = error;
    item.speed = 0.0;
}
fn check_control(control: &watch::Receiver<Control>) -> Result<()> {
    match *control.borrow() {
        Control::Run => Ok(()),
        Control::Pause => Err(AppError::new("TRANSFER_PAUSED", "Paused")),
        Control::Cancel => Err(AppError::new("TRANSFER_CANCELLED", "Cancelled")),
    }
}
async fn copy_bounded<R: AsyncRead + Unpin, W: tokio::io::AsyncWrite + Unpin>(
    source: &mut R,
    destination: &mut W,
    task: &Task,
    offset: u64,
    total: u64,
    control: &watch::Receiver<Control>,
) -> Result<()> {
    let mut buffer = vec![0u8; CHUNK];
    let mut copied = offset;
    let started = Instant::now();
    let mut updated = Instant::now();
    {
        let mut r = task.record.lock().await;
        r.status = "running".into();
        r.transferred = offset;
    }
    while copied < total {
        check_control(control)?;
        let size = buffer.len().min((total - copied) as usize);
        let read = source.read(&mut buffer[..size]).await?;
        if read == 0 {
            return Err(source_changed());
        }
        destination.write_all(&buffer[..read]).await?;
        copied += read as u64;
        if updated.elapsed().as_millis() >= 100 || copied == total {
            let mut r = task.record.lock().await;
            r.transferred = copied;
            r.speed = (copied - offset) as f64 / started.elapsed().as_secs_f64().max(0.001);
            updated = Instant::now();
        }
    }
    check_control(control)?;
    if source.read(&mut buffer[..1]).await? != 0 {
        return Err(source_changed());
    }
    Ok(())
}
async fn hash_prefix<R: AsyncRead + Unpin>(
    reader: &mut R,
    length: u64,
    control: &watch::Receiver<Control>,
) -> Result<Vec<u8>> {
    let mut hash = Sha256::new();
    let mut remaining = length;
    let mut buffer = vec![0; CHUNK];
    while remaining > 0 {
        check_control(control)?;
        let size = buffer.len().min(remaining as usize);
        let n = reader.read(&mut buffer[..size]).await?;
        if n == 0 {
            return Err(source_changed());
        }
        hash.update(&buffer[..n]);
        remaining -= n as u64;
    }
    Ok(hash.finalize().to_vec())
}
async fn hash_local_prefix(
    path: &str,
    length: u64,
    control: &watch::Receiver<Control>,
) -> Result<Vec<u8>> {
    let mut file = fs::File::open(path).await?;
    hash_prefix(&mut file, length, control).await
}
async fn hash_local(
    path: &str,
    length: u64,
    control: &watch::Receiver<Control>,
) -> Result<Vec<u8>> {
    let mut file = fs::File::open(path).await?;
    let hash = hash_prefix(&mut file, length, control).await?;
    if file.read(&mut [0u8; 1]).await? != 0 {
        return Err(source_changed());
    }
    Ok(hash)
}
async fn hash_remote_prefix(
    sftp: &SftpSession,
    path: &str,
    length: u64,
    control: &watch::Receiver<Control>,
) -> Result<Vec<u8>> {
    let mut file = sftp.open(path).await.map_err(sftp_error)?;
    let result = hash_prefix(&mut file, length, control).await;
    let closed = file.shutdown().await;
    let value = result?;
    closed?;
    Ok(value)
}
async fn hash_remote(
    sftp: &SftpSession,
    path: &str,
    length: u64,
    control: &watch::Receiver<Control>,
) -> Result<Vec<u8>> {
    let mut file = sftp.open(path).await.map_err(sftp_error)?;
    let result = async {
        let hash = hash_prefix(&mut file, length, control).await?;
        if file.read(&mut [0u8; 1]).await? != 0 {
            return Err(source_changed());
        }
        Ok(hash)
    }
    .await;
    let closed = file.shutdown().await;
    let value = result?;
    closed?;
    Ok(value)
}
fn remote_signature(attrs: &FileAttributes) -> String {
    format!(
        "{:?}:{:?}:{:?}:{:?}:{:?}",
        attrs.size, attrs.mtime, attrs.uid, attrs.gid, attrs.permissions
    )
}
fn local_signature(meta: &std::fs::Metadata) -> String {
    let modified = meta
        .modified()
        .ok()
        .and_then(|v| v.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_nanos());
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        format!(
            "{}:{:?}:{}:{}:{}",
            meta.len(),
            modified,
            meta.ino(),
            meta.dev(),
            meta.mode()
        )
    }
    #[cfg(not(unix))]
    {
        format!(
            "{}:{:?}:{}",
            meta.len(),
            modified,
            meta.permissions().readonly()
        )
    }
}
async fn local_metadata(path: &str) -> Result<Option<std::fs::Metadata>> {
    match fs::symlink_metadata(path).await {
        Ok(m) => Ok(Some(m)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}
fn local_is_link(meta: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        // Includes directory junctions and other reparse points, which must not
        // redirect a directory-copy plan outside the user-selected tree.
        meta.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        meta.is_symlink()
    }
}
fn prune_completed_tasks(tasks: &mut BTreeMap<String, Arc<Task>>) {
    tasks.retain(|_, task| match task.record.try_lock() {
        Ok(record) => !matches!(record.status.as_str(), "completed" | "cancelled"),
        Err(_) => true,
    });
}
fn validate_remote_destination(attrs: Option<&FileAttributes>, overwrite: bool) -> Result<()> {
    if let Some(meta) = attrs {
        if !meta.file_type().is_file() {
            return Err(AppError::new(
                "UNSAFE_DESTINATION",
                "Destination must be a regular file",
            ));
        }
        if !overwrite {
            return Err(destination_exists());
        }
    }
    Ok(())
}
fn source_changed() -> AppError {
    AppError::new(
        "SOURCE_CHANGED",
        "Source size, metadata or SHA-256 changed. Cancel this task and start a new transfer",
    )
}
fn prefix_changed() -> AppError {
    AppError::new(
        "PARTIAL_CHANGED",
        "Partial file differs from the source prefix. Resume was refused; cancel and restart",
    )
}
fn destination_exists() -> AppError {
    AppError::new(
        "DESTINATION_EXISTS",
        "Destination exists. Start again with a different path or explicit upload overwrite permission",
    )
}
fn destination_changed() -> AppError {
    AppError::new(
        "DESTINATION_CHANGED",
        "Destination changed while transferring; original was not overwritten",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn prefix_hash_detects_wrong_same_length_bytes() {
        let (_, receiver) = watch::channel(Control::Run);
        let a = hash_prefix(&mut &b"abcd"[..], 4, &receiver).await.unwrap();
        let b = hash_prefix(&mut &b"abce"[..], 4, &receiver).await.unwrap();
        assert_ne!(a, b);
        assert!(hash_prefix(&mut &b"abc"[..], 4, &receiver).await.is_err());
    }
    #[tokio::test]
    async fn local_download_conflict_never_replaces_a_racing_file() {
        let temp = tempfile::tempdir().unwrap();
        let part = temp.path().join("verified.part");
        let dest = temp.path().join("document.xlsx");
        fs::write(&part, b"downloaded").await.unwrap();
        let dest_path = dest.to_str().unwrap();
        assert!(!TransferManager::download_destination_exists(dest_path)
            .await
            .unwrap());
        fs::write(&dest, b"original").await.unwrap();
        assert!(TransferManager::download_destination_exists(dest_path)
            .await
            .unwrap());
        assert!(
            publish_download_no_replace(part.to_str().unwrap(), dest_path)
                .await
                .is_err()
        );
        assert_eq!(fs::read(&dest).await.unwrap(), b"original");
        assert_eq!(fs::read(&part).await.unwrap(), b"downloaded");
        fs::remove_file(&dest).await.unwrap();
        publish_download_no_replace(part.to_str().unwrap(), dest_path)
            .await
            .unwrap();
        assert_eq!(fs::read(&dest).await.unwrap(), b"downloaded");
        assert!(!part.exists());
    }

    #[test]
    fn archive_selection_accepts_literal_siblings_and_rejects_unsafe_paths() {
        let paths = vec![
            "/home/test/a 'quoted'.txt".into(),
            "/home/test/--option".into(),
        ];
        let (parent, names) = archive_selection(&paths).unwrap();
        assert_eq!(parent, "/home/test");
        assert_eq!(names, vec!["a 'quoted'.txt", "--option"]);
        assert!(archive_selection(&["/tmp".into()]).is_err());
        assert!(archive_selection(&["/".into()]).is_err());
        assert!(archive_selection(&["/home/test/../data".into()]).is_err());
        assert!(archive_selection(&["/home/test/a".into(), "/home/other/b".into()]).is_err());
    }

    #[test]
    fn overwrite_requires_regular_destination_and_permission() {
        let attrs = FileAttributes {
            permissions: Some(0o100644),
            ..Default::default()
        };
        assert!(validate_remote_destination(Some(&attrs), false).is_err());
        assert!(validate_remote_destination(Some(&attrs), true).is_ok());
        let link = FileAttributes {
            permissions: Some(0o120777),
            ..Default::default()
        };
        assert!(validate_remote_destination(Some(&link), true).is_err());
    }
}
