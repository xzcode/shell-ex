//! Typed Docker operations over an authenticated SSH exec channel.
use crate::{
    error::{AppError, Result},
    ssh::SshManager,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerInfo {
    pub id: String,
    pub name: String,
    pub image: String,
    pub state: String,
    pub status: String,
    pub ports: String,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerImage {
    pub id: String,
    pub repository: String,
    pub tag: String,
    pub size: String,
    pub created: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct DockerRow {
    #[serde(rename = "ID")]
    id: String,
    names: String,
    image: String,
    state: String,
    status: String,
    ports: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct ImageRow {
    #[serde(rename = "ID")]
    id: String,
    repository: String,
    tag: String,
    size: String,
    created_since: String,
}
pub struct DockerService {
    ssh: Arc<SshManager>,
}
impl DockerService {
    pub fn new(ssh: Arc<SshManager>) -> Self {
        Self { ssh }
    }
    pub async fn list(&self, session_id: &str) -> Result<Vec<ContainerInfo>> {
        let output = self
            .ssh
            .exec(
                session_id,
                "docker ps --all --no-trunc --format '{{json .}}'",
            )
            .await?;
        if output.status != 0 {
            return Err(AppError::new(
                "DOCKER_UNAVAILABLE",
                format!(
                    "Docker is unavailable or this account lacks permission: {}",
                    output.stderr.trim()
                ),
            ));
        }
        output
            .stdout
            .lines()
            .filter(|line| !line.trim().is_empty())
            .take(5000)
            .map(|line| {
                let row: DockerRow = serde_json::from_str(line)
                    .map_err(|e| AppError::new("DOCKER_PARSE_ERROR", e.to_string()))?;
                Ok(ContainerInfo {
                    id: row.id,
                    name: row.names,
                    image: row.image,
                    state: row.state,
                    status: row.status,
                    ports: row.ports,
                })
            })
            .collect()
    }
    pub async fn images(&self, session_id: &str) -> Result<Vec<DockerImage>> {
        let output = self
            .ssh
            .exec(
                session_id,
                "docker image ls --no-trunc --format '{{json .}}'",
            )
            .await?;
        if output.status != 0 {
            return Err(AppError::new(
                "DOCKER_UNAVAILABLE",
                format!("Docker images are unavailable: {}", output.stderr.trim()),
            ));
        }
        output
            .stdout
            .lines()
            .filter(|line| !line.trim().is_empty())
            .take(5000)
            .map(|line| {
                let row: ImageRow = serde_json::from_str(line)
                    .map_err(|e| AppError::new("DOCKER_PARSE_ERROR", e.to_string()))?;
                Ok(DockerImage {
                    id: row.id,
                    repository: row.repository,
                    tag: row.tag,
                    size: row.size,
                    created: row.created_since,
                })
            })
            .collect()
    }
    pub async fn action(&self, session_id: &str, id: &str, action: &str) -> Result<()> {
        validate_id(id)?;
        if !matches!(action, "start" | "stop" | "restart") {
            return Err(AppError::new(
                "INVALID_DOCKER_ACTION",
                "Choose start, stop or restart",
            ));
        }
        let output = self
            .ssh
            .exec(session_id, &format!("docker {action} -- {id}"))
            .await?;
        if output.status != 0 {
            return Err(AppError::new("DOCKER_ACTION_FAILED", output.stderr.trim()));
        }
        Ok(())
    }
    pub async fn logs(&self, session_id: &str, id: &str) -> Result<String> {
        validate_id(id)?;
        // Both stdout and stderr are valid Docker container log streams.
        let output = self
            .ssh
            .exec(
                session_id,
                &format!("docker logs --tail 300 --timestamps -- {id}"),
            )
            .await?;
        if output.status != 0 {
            return Err(AppError::new("DOCKER_LOGS_FAILED", output.stderr.trim()));
        }
        let mut text = output.stdout;
        if !output.stderr.is_empty() {
            if !text.is_empty() && !text.ends_with('\n') {
                text.push('\n');
            }
            text.push_str(&output.stderr);
        }
        Ok(text)
    }
}
fn validate_id(id: &str) -> Result<()> {
    if !(12..=64).contains(&id.len()) || !id.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err(AppError::new(
            "INVALID_CONTAINER_ID",
            "Select a container ID returned by the container list",
        ));
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn docker_actions_cannot_inject_shell_or_options() {
        for bad in ["--help", "abcd; rm -rf /", "$(id)", "-abcdef012345", "123"] {
            assert!(validate_id(bad).is_err());
        }
        assert!(validate_id("abcdef012345").is_ok());
    }
}
