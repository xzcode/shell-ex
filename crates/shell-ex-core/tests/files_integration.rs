//! Run only inside scripts/ssh_fixture.py. Uses an isolated loopback sshd and
//! temporary files; it never touches a configured personal/production host.
use shell_ex_core::{
    files::FileService,
    models::{EventSink, Host, SecretInput},
    monitor::MonitorService,
    ssh::SshManager,
    transfers::{Transfer, TransferManager},
};
use std::{sync::Arc, time::Duration};
use tokio::time::{sleep, timeout};

async fn connection() -> (Arc<SshManager>, String) {
    let host = Host {
        id: "integration".into(),
        name: "Isolated loopback".into(),
        address: std::env::var("SHELL_EX_TEST_HOST").unwrap(),
        port: std::env::var("SHELL_EX_TEST_PORT")
            .unwrap()
            .parse()
            .unwrap(),
        username: std::env::var("SHELL_EX_TEST_USER").unwrap(),
        group: "tests".into(),
        auth_method: "key".into(),
        credential_store: "local".into(),
        private_key_path: Some(std::env::var("SHELL_EX_TEST_KEY").unwrap()),
        proxy: None,
        jump_host_id: None,
        startup_directory: None,
        keep_alive_seconds: 10,
        connect_timeout_seconds: 10,
        favorite: false,
        color: "#123456".into(),
        notes: String::new(),
    };
    let ssh = Arc::new(SshManager::new());
    let probe = ssh.probe(&host).await.unwrap();
    let sink: EventSink = Arc::new(|_| {});
    let id = ssh
        .connect_service(&host, SecretInput::default(), probe.fingerprint, sink)
        .await
        .unwrap();
    (ssh, id)
}
async fn wait_for(manager: &TransferManager, id: &str, states: &[&str]) -> Transfer {
    timeout(Duration::from_secs(90), async {
        loop {
            let item = manager
                .list()
                .await
                .into_iter()
                .find(|t| t.id == id)
                .unwrap();
            if states.contains(&item.status.as_str()) {
                return item;
            }
            sleep(Duration::from_millis(15)).await;
        }
    })
    .await
    .expect("Transfer did not reach expected state")
}

#[tokio::test]
#[ignore = "requires isolated ssh fixture"]
async fn sftp_atomic_edit_transfer_integrity_resume_and_monitor() {
    let root = std::env::var("SHELL_EX_TEST_ROOT").unwrap();
    let directory = tempfile::tempdir_in(root).unwrap();
    let path = |name: &str| directory.path().join(name).to_string_lossy().into_owned();
    let (ssh, session) = connection().await;
    let files = FileService::new(ssh.clone());
    let editor = path("a configuration 'quoted'.txt");
    let first = files
        .save(&session, &editor, "first\n", "missing")
        .await
        .unwrap();
    assert_eq!(std::fs::read_to_string(&editor).unwrap(), "first\n");
    std::fs::write(&editor, "other writer\n").unwrap();
    let stale = files
        .save(&session, &editor, "must not replace\n", &first.version)
        .await
        .unwrap_err();
    assert_eq!(stale.code, "FILE_CONFLICT");
    assert_eq!(std::fs::read_to_string(&editor).unwrap(), "other writer\n");
    let fresh = files.read(&session, &editor).await.unwrap();
    let saved = files
        .save(&session, &editor, "saved atomically\n", &fresh.version)
        .await
        .unwrap();
    assert_eq!(saved.text, "saved atomically\n");
    assert_eq!(
        std::fs::read_to_string(&editor).unwrap(),
        "saved atomically\n"
    );
    assert!(files
        .list(&session, directory.path().to_str().unwrap())
        .await
        .unwrap()
        .iter()
        .any(|entry| entry.path == editor));

    #[cfg(unix)]
    {
        let link = path("symbolic-link");
        std::os::unix::fs::symlink(&editor, &link).unwrap();
        assert_eq!(
            files.chmod(&session, &link, 0o777).await.unwrap_err().code,
            "SYMLINK_REFUSED"
        );
        assert_eq!(
            files
                .save(&session, &link, "bad", &saved.version)
                .await
                .unwrap_err()
                .code,
            "NOT_REGULAR_FILE"
        );
    }

    let manager = TransferManager::new(ssh.clone(), 2);
    let source = path("source.bin");
    let uploaded = path("uploaded.bin");
    let downloaded = path("downloaded.bin");
    let bytes: Vec<u8> = (0..1024 * 1024).map(|i| (i % 251) as u8).collect();
    std::fs::write(&source, &bytes).unwrap();
    let upload = manager
        .start(
            session.clone(),
            "upload".into(),
            source.clone(),
            uploaded.clone(),
            false,
        )
        .await
        .unwrap();
    let result = wait_for(&manager, &upload.id, &["completed", "failed"]).await;
    assert_eq!(result.status, "completed", "{:?}", result.error);
    assert_eq!(result.transferred, bytes.len() as u64);
    assert_eq!(std::fs::read(&uploaded).unwrap(), bytes);
    let download = manager
        .start(
            session.clone(),
            "download".into(),
            downloaded.clone(),
            uploaded.clone(),
            false,
        )
        .await
        .unwrap();
    let result = wait_for(&manager, &download.id, &["completed", "failed"]).await;
    assert_eq!(result.status, "completed", "{:?}", result.error);
    assert_eq!(std::fs::read(&downloaded).unwrap(), bytes);
    let rejected = manager
        .start(
            session.clone(),
            "upload".into(),
            source.clone(),
            editor.clone(),
            false,
        )
        .await
        .unwrap();
    let result = wait_for(&manager, &rejected.id, &["failed"]).await;
    assert!(result.error.unwrap().contains("Destination exists"));
    assert_eq!(
        std::fs::read_to_string(&editor).unwrap(),
        "saved atomically\n"
    );
    manager.control(&rejected.id, "cancel").await.unwrap();
    wait_for(&manager, &rejected.id, &["cancelled"]).await;

    // Pause after actual bytes were acknowledged, then corrupt the retained prefix.
    let large_source = path("large.bin");
    let large_target = path("large-target.bin");
    std::fs::write(&large_source, vec![37u8; 32 * 1024 * 1024]).unwrap();
    let transfer = manager
        .start(
            session.clone(),
            "upload".into(),
            large_source,
            large_target.clone(),
            false,
        )
        .await
        .unwrap();
    timeout(Duration::from_secs(60), async {
        loop {
            let record = manager
                .list()
                .await
                .into_iter()
                .find(|t| t.id == transfer.id)
                .unwrap();
            if record.status == "running" && record.transferred > 0 {
                break;
            }
            assert!(
                !matches!(record.status.as_str(), "failed" | "completed"),
                "unexpected early end: {record:?}"
            );
            sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    manager.control(&transfer.id, "pause").await.unwrap();
    wait_for(&manager, &transfer.id, &["paused"]).await;
    assert!(!std::path::Path::new(&large_target).exists());
    let partial = directory
        .path()
        .join(format!(".shell-ex-{}.part", transfer.id));
    assert!(std::fs::metadata(&partial).unwrap().len() > 0);
    {
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .open(&partial)
            .unwrap();
        file.write_all(b"corrupt").unwrap();
    }
    manager.control(&transfer.id, "resume").await.unwrap();
    let result = wait_for(&manager, &transfer.id, &["failed"]).await;
    assert!(result.error.unwrap().contains("prefix"));
    assert!(!std::path::Path::new(&large_target).exists());
    manager.control(&transfer.id, "cancel").await.unwrap();
    wait_for(&manager, &transfer.id, &["cancelled"]).await;
    assert!(!partial.exists());

    let monitor = MonitorService::new(ssh.clone());
    let first = monitor.snapshot(&session).await.unwrap();
    assert!(first.memory_total > 0);
    assert!(first.uptime > 0.0);
    assert_eq!(first.cpu_percent, None);
    sleep(Duration::from_millis(80)).await;
    let second = monitor.snapshot(&session).await.unwrap();
    assert!(second.cpu_percent.is_some());
    assert_eq!(
        monitor
            .process_signal(&session, 1, "KILL")
            .await
            .unwrap_err()
            .code,
        "PROTECTED_PROCESS"
    );
    ssh.disconnect(&session).await.unwrap();
}

#[tokio::test]
#[ignore = "requires isolated ssh fixture"]
async fn directory_plan_is_read_only_rechecks_sources_and_skips_links() {
    let root = std::env::var("SHELL_EX_TEST_ROOT").unwrap();
    let directory = tempfile::tempdir_in(root).unwrap();
    let source = directory.path().join("source-folder");
    let remote = directory.path().join("remote-folder");
    let target = directory.path().join("download-folder");
    std::fs::create_dir_all(source.join("nested/empty")).unwrap();
    std::fs::write(source.join("a.txt"), "first").unwrap();
    std::fs::write(source.join("nested/b 'quoted'.txt"), "second").unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(source.join("a.txt"), source.join("source-link")).unwrap();
    let (ssh, session) = connection().await;
    let manager = TransferManager::new(ssh.clone(), 2);
    let plan = manager
        .plan_directory(
            session.clone(),
            "upload".into(),
            source.to_str().unwrap().into(),
            remote.to_str().unwrap().into(),
        )
        .await
        .unwrap();
    assert_eq!(plan.total_files, 2);
    assert_eq!(plan.total_bytes, 11);
    assert!(!remote.exists());
    #[cfg(unix)]
    assert_eq!(plan.skipped_links.len(), 1);
    std::fs::write(source.join("a.txt"), "source changed after preview").unwrap();
    assert_eq!(
        manager
            .start_directory(&plan.id, "skip")
            .await
            .unwrap_err()
            .code,
        "DIRECTORY_PLAN_STALE"
    );
    assert!(!remote.exists());
    let plan = manager
        .plan_directory(
            session.clone(),
            "upload".into(),
            source.to_str().unwrap().into(),
            remote.to_str().unwrap().into(),
        )
        .await
        .unwrap();
    let started = manager.start_directory(&plan.id, "skip").await.unwrap();
    assert!(started.errors.is_empty());
    assert_eq!(started.queued, 2);
    for id in &started.transfer_ids {
        let record = wait_for(&manager, id, &["completed", "failed"]).await;
        assert_eq!(record.status, "completed", "{record:?}");
    }
    assert!(remote.join("nested/empty").is_dir());
    assert!(!remote.join("source-link").exists());
    #[cfg(unix)]
    std::os::unix::fs::symlink(source.join("a.txt"), remote.join("remote-link")).unwrap();
    let plan = manager
        .plan_directory(
            session.clone(),
            "download".into(),
            target.to_str().unwrap().into(),
            remote.to_str().unwrap().into(),
        )
        .await
        .unwrap();
    assert_eq!(plan.total_files, 2);
    assert!(!target.exists());
    #[cfg(unix)]
    assert_eq!(plan.skipped_links.len(), 1);
    let started = manager.start_directory(&plan.id, "skip").await.unwrap();
    assert!(started.errors.is_empty());
    assert_eq!(started.queued, 2);
    for id in &started.transfer_ids {
        let record = wait_for(&manager, id, &["completed", "failed"]).await;
        assert_eq!(record.status, "completed", "{record:?}");
    }
    assert_eq!(
        std::fs::read(target.join("a.txt")).unwrap(),
        std::fs::read(source.join("a.txt")).unwrap()
    );
    assert_eq!(
        std::fs::read_to_string(target.join("nested/b 'quoted'.txt")).unwrap(),
        "second"
    );
    assert!(!target.join("remote-link").exists());
    std::fs::write(target.join("a.txt"), "keep my local changes").unwrap();
    let plan = manager
        .plan_directory(
            session.clone(),
            "download".into(),
            target.to_str().unwrap().into(),
            remote.to_str().unwrap().into(),
        )
        .await
        .unwrap();
    assert_eq!(plan.existing_files, 2);
    let started = manager.start_directory(&plan.id, "skip").await.unwrap();
    assert_eq!(started.queued, 0);
    assert_eq!(
        std::fs::read_to_string(target.join("a.txt")).unwrap(),
        "keep my local changes"
    );
    #[cfg(unix)]
    {
        let unsafe_target = directory.path().join("unsafe-link");
        std::os::unix::fs::symlink(&target, &unsafe_target).unwrap();
        let rejected = manager
            .plan_directory(
                session.clone(),
                "download".into(),
                unsafe_target.to_str().unwrap().into(),
                remote.to_str().unwrap().into(),
            )
            .await
            .unwrap_err();
        assert_eq!(rejected.code, "UNSAFE_DESTINATION");
    }
    ssh.disconnect(&session).await.unwrap();
}

#[tokio::test]
#[ignore = "requires isolated ssh fixture and GNU tar"]
async fn file_menu_archive_recursive_delete_and_no_overwrite() {
    let root = std::env::var("SHELL_EX_TEST_ROOT").unwrap();
    let directory = tempfile::tempdir_in(root).unwrap();
    let path = |name: &str| directory.path().join(name).to_string_lossy().into_owned();
    let (ssh, session) = connection().await;
    let files = FileService::new(ssh.clone());
    let source = path("a 'quoted'.txt");
    let nested = path("--nested");
    files.create_file(&session, &source).await.unwrap();
    assert!(files.create_file(&session, &source).await.is_err());
    std::fs::write(&source, b"original remote content").unwrap();
    files.mkdir(&session, &nested).await.unwrap();
    let child = format!("{nested}/child.txt");
    files.create_file(&session, &child).await.unwrap();
    std::fs::write(&child, b"child content").unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(&source, format!("{nested}/outside-link")).unwrap();

    let manager = TransferManager::new(ssh.clone(), 1);
    let occupied = path("local-existing.txt");
    std::fs::write(&occupied, b"keep local").unwrap();
    assert!(manager
        .start(
            session.clone(),
            "download".into(),
            occupied.clone(),
            source.clone(),
            false
        )
        .await
        .is_err());
    assert!(manager
        .start(
            session.clone(),
            "download".into(),
            occupied.clone(),
            source.clone(),
            true
        )
        .await
        .is_err());
    assert_eq!(std::fs::read(&occupied).unwrap(), b"keep local");

    let dest = path("archive.tar.gz");
    let transfer = manager
        .start_archive_download(
            session.clone(),
            vec![source.clone(), nested.clone()],
            dest.clone(),
        )
        .await
        .unwrap();
    let item = wait_for(&manager, &transfer.id, &["completed", "failed"]).await;
    assert_eq!(item.status, "completed", "{item:?}");
    assert!(item.error.is_none(), "{item:?}");
    assert!(!std::path::Path::new(&transfer.remote_path).exists());
    assert!(!std::path::Path::new(&transfer.remote_path)
        .parent()
        .unwrap()
        .exists());
    let listing = std::process::Command::new("tar")
        .args(["-tzf", &dest])
        .output()
        .unwrap();
    assert!(listing.status.success());
    let listing = String::from_utf8_lossy(&listing.stdout);
    assert!(listing.contains("a 'quoted'.txt"), "{listing}");
    assert!(listing.contains("--nested/child.txt"), "{listing}");

    files.remove_tree(&session, &nested).await.unwrap();
    assert!(!std::path::Path::new(&nested).exists());
    assert_eq!(std::fs::read(&source).unwrap(), b"original remote content");
    assert_eq!(std::fs::read(&occupied).unwrap(), b"keep local");
    ssh.disconnect(&session).await.unwrap();
}

#[tokio::test]
#[ignore = "requires isolated ssh fixture"]
async fn monitor_storage_io_and_process_interval_sampling() {
    let (ssh, session) = connection().await;
    let monitor = MonitorService::new(ssh.clone());
    let first = monitor.snapshot(&session).await.unwrap();
    assert!(first.memory_total > 0);
    assert!(first.process_count >= first.processes.len());
    assert!(
        !first.processes.is_empty(),
        "collector did not return visible processes"
    );
    assert!(first.processes.iter().all(|p| p.cpu.is_none()));
    assert!(first.processes.iter().any(|p| p.rss_bytes > 0));
    for mount in &first.disk_mounts {
        assert!(!mount.fs_type.is_empty());
        if matches!(mount.fs_type.as_str(), "overlay" | "tmpfs" | "devtmpfs") {
            assert_eq!(mount.category, "virtual");
        }
    }
    assert!(first.disk_io.iter().all(|d| d.utilization.is_none()));
    sleep(Duration::from_millis(300)).await;
    let second = monitor.snapshot(&session).await.unwrap();
    assert!(second.cpu_percent.is_some());
    assert!(
        second.processes.iter().any(|p| p.cpu.is_some()),
        "no comparable proc counters"
    );
    for disk in &second.disk_io {
        assert!(!disk.name.starts_with("loop") && !disk.name.starts_with("zram"));
        if first
            .disk_io
            .iter()
            .any(|d| d.device_id == disk.device_id && d.name == disk.name)
        {
            assert!(disk.read_bytes_per_sec.is_some());
            assert!(disk.utilization.is_some_and(|n| (0.0..=100.0).contains(&n)));
        }
    }
    monitor.forget_session(&session).await;
    ssh.disconnect(&session).await.unwrap();
}
