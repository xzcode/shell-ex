//! Opt-in Docker lifecycle test against the loopback OpenSSH fixture.
//! The test creates one uniquely labelled container, touches only its exact ID,
//! and removes that ID even when the assertions fail. It never prunes resources.
use futures::FutureExt;
use shell_ex_core::{
    docker::DockerService,
    models::{EventSink, ExecOutput, Host, SecretInput},
    ssh::SshManager,
};
use std::{panic::AssertUnwindSafe, sync::Arc, time::Duration};
use tokio::time::{sleep, timeout};

const IMAGE: &str = "busybox:1.37.0";
const OWNER_LABEL: &str = "io.shellex.integration-run";
const STDOUT_MARKER: &str = "SHELL_EX_DOCKER_STDOUT";
const STDERR_MARKER: &str = "SHELL_EX_DOCKER_STDERR";

async fn command(ssh: &SshManager, session: &str, text: &str) -> Result<ExecOutput, String> {
    let output = ssh.exec(session, text).await.map_err(|e| e.to_string())?;
    if output.status != 0 {
        return Err(format!(
            "Fixture command failed ({}): {}",
            output.status,
            output.stderr.trim()
        ));
    }
    Ok(output)
}

async fn connect_fixture() -> (Arc<SshManager>, String) {
    let address = std::env::var("SHELL_EX_TEST_HOST").expect("Run through scripts/ssh_fixture.py");
    assert!(
        matches!(address.as_str(), "127.0.0.1" | "::1"),
        "Docker test only accepts the isolated loopback SSH fixture"
    );
    let host = Host {
        id: "docker-integration".into(),
        name: "Isolated Docker fixture".into(),
        address,
        port: std::env::var("SHELL_EX_TEST_PORT")
            .unwrap()
            .parse()
            .unwrap(),
        username: std::env::var("SHELL_EX_TEST_USER").unwrap(),
        group: "tests".into(),
        auth_method: "key".into(),
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
    let session = ssh
        .connect_service(&host, SecretInput::default(), probe.fingerprint, sink)
        .await
        .unwrap();
    (ssh, session)
}

async fn state(service: &DockerService, session: &str, id: &str, expected_name: &str) -> String {
    let containers = service
        .list(session)
        .await
        .expect("DockerService::list must parse real docker ps JSON");
    let container = containers
        .iter()
        .find(|container| container.id == id)
        .expect("The owned test container must appear in the list");
    assert_eq!(container.name, expected_name);
    assert_eq!(container.image, IMAGE);
    assert!(
        container.ports.is_empty(),
        "The fixture must never publish ports"
    );
    container.state.clone()
}

async fn cleanup_owned(ssh: &SshManager, session: &str, id: &str, run: &str) -> Result<(), String> {
    // Verify ownership again before mutation. Even a test failure cannot expand
    // cleanup to a name pattern, other containers, volumes or cached images.
    let inspected = command(
        ssh,
        session,
        &format!("docker inspect --format '{{{{json .Config.Labels}}}}' -- {id}"),
    )
    .await?;
    let labels: serde_json::Value =
        serde_json::from_str(inspected.stdout.trim()).map_err(|e| e.to_string())?;
    if labels.get(OWNER_LABEL).and_then(serde_json::Value::as_str) != Some(run) {
        return Err(format!(
            "Refused cleanup: ownership label does not match exact container {id}"
        ));
    }
    command(ssh, session, &format!("docker rm --force -- {id}")).await?;
    let remaining = command(
        ssh,
        session,
        &format!("docker ps --all --quiet --no-trunc --filter id={id}"),
    )
    .await?;
    if remaining.stdout.lines().any(|line| line.trim() == id) {
        return Err(format!("Exact test container {id} remained after cleanup"));
    }
    Ok(())
}

#[tokio::test]
#[ignore = "requires SHELL_EX_TEST_DOCKER=1, a local Docker daemon and isolated SSH fixture"]
async fn docker_images_logs_and_owned_container_lifecycle_over_ssh() {
    if std::env::var("SHELL_EX_TEST_DOCKER").as_deref() != Ok("1") {
        eprintln!("SKIP Docker lifecycle: explicitly set SHELL_EX_TEST_DOCKER=1 after preparing the fixture image");
        return;
    }
    let (ssh, session) = connect_fixture().await;
    // Refuse remote Docker contexts, even though the SSH fixture itself is local.
    let endpoint = command(&ssh, &session,
        "case \"${DOCKER_HOST:-unix://default}\" in unix://*) ;; *) printf '%s\\n' 'Remote DOCKER_HOST is not allowed for this fixture' >&2; exit 65;; esac; docker context inspect --format '{{.Endpoints.docker.Host}}'")
        .await.expect("A local Docker Unix socket is required");
    assert!(
        endpoint.stdout.trim().starts_with("unix://"),
        "Docker fixture refuses a remote daemon context"
    );
    command(&ssh, &session, "docker info --format '{{.ServerVersion}}'")
        .await
        .expect("Docker daemon must be available to the SSH test user");
    command(
        &ssh,
        &session,
        &format!("docker image inspect --format '{{{{.Id}}}}' {IMAGE}"),
    )
    .await
    .expect("Pre-pull busybox:1.37.0 in the CI job; this test never pulls images implicitly");

    let run = uuid::Uuid::new_v4().simple().to_string();
    let name = format!("shell-ex-ci-{run}");
    let created = command(&ssh, &session, &format!(
        "docker create --pull=never --name {name} --label {OWNER_LABEL}={run} --network none --read-only --cap-drop ALL --security-opt no-new-privileges --pids-limit 8 --memory 16m --cpus 0.25 --stop-timeout 2 {IMAGE} sh -c 'echo {STDOUT_MARKER}; echo {STDERR_MARKER} >&2; exec sleep 300'"
    )).await.expect("Could not create the uniquely owned harmless test container");
    let id = created.stdout.trim().to_owned();
    assert!(
        id.len() == 64 && id.bytes().all(|byte| byte.is_ascii_hexdigit()),
        "docker create must return one full container ID"
    );

    let service = DockerService::new(ssh.clone());
    let exercised = AssertUnwindSafe(async {
        let images = service.images(&session).await.expect("DockerService::images must parse real docker image JSON");
        let image = images.iter().find(|image| image.repository == "busybox" && image.tag == "1.37.0").expect("Pinned BusyBox image must appear");
        assert!(image.id.starts_with("sha256:"));
        assert!(!image.size.is_empty() && !image.created.is_empty());
        assert_eq!(state(&service, &session, &id, &name).await, "created");

        service.action(&session, &id, "start").await.unwrap();
        assert_eq!(state(&service, &session, &id, &name).await, "running");
        timeout(Duration::from_secs(5), async {
            loop {
                let logs = service.logs(&session, &id).await.unwrap();
                if logs.contains(STDOUT_MARKER) && logs.contains(STDERR_MARKER) { break; }
                sleep(Duration::from_millis(50)).await;
            }
        }).await.expect("DockerService::logs must retain both stdout and stderr");

        service.action(&session, &id, "stop").await.unwrap();
        assert_eq!(state(&service, &session, &id, &name).await, "exited");
        service.action(&session, &id, "start").await.unwrap();
        assert_eq!(state(&service, &session, &id, &name).await, "running");
        let before_restart = command(&ssh, &session, &format!("docker inspect --format '{{{{.State.StartedAt}}}}' -- {id}")).await.unwrap().stdout;
        service.action(&session, &id, "restart").await.unwrap();
        assert_eq!(state(&service, &session, &id, &name).await, "running");
        let after_restart = command(&ssh, &session, &format!("docker inspect --format '{{{{.State.StartedAt}}}}' -- {id}")).await.unwrap().stdout;
        assert_ne!(before_restart, after_restart, "Restart must actually create a new running process");
        println!("Validated through SSH: images, containers, stdout/stderr logs, start, stop, restart ({id})");
    }).catch_unwind().await;

    let cleanup = cleanup_owned(&ssh, &session, &id, &run).await;
    let disconnect = ssh.disconnect(&session).await;
    if let Err(error) = &cleanup {
        eprintln!("Exact Docker fixture cleanup failed: {error}");
    }
    if let Err(panic) = exercised {
        std::panic::resume_unwind(panic);
    }
    cleanup.expect("Owned test container must be removed after validation");
    disconnect.unwrap();
    println!("Confirmed exact owned Docker container removed; other containers/images untouched");
}
