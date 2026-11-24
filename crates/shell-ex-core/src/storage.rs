use crate::{
    error::{AppError, Result},
    models::*,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{
    path::Path,
    sync::{Mutex, MutexGuard},
};

pub struct Storage {
    connection: Mutex<Connection>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustStatus {
    pub algorithm: String,
    pub fingerprint: String,
    pub trusted: bool,
    pub changed: bool,
    pub previous_fingerprint: Option<String>,
}

impl Storage {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))?;
            }
        }
        let connection = Connection::open(path)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
        }
        Self::from_connection(connection)
    }
    fn from_connection(connection: Connection) -> Result<Self> {
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        connection.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
          CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY);
          CREATE TABLE IF NOT EXISTS hosts(id TEXT PRIMARY KEY, data TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS preferences(key TEXT PRIMARY KEY, data TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS snippets(id TEXT PRIMARY KEY, data TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS known_hosts(address TEXT NOT NULL, port INTEGER NOT NULL,
            algorithm TEXT NOT NULL, fingerprint TEXT NOT NULL, PRIMARY KEY(address,port,algorithm));
          INSERT OR IGNORE INTO schema_migrations(version) VALUES(1);")?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }
    fn lock(&self) -> Result<MutexGuard<'_, Connection>> {
        self.connection
            .lock()
            .map_err(|_| AppError::new("STORAGE_LOCK", "Storage lock unavailable"))
    }
    pub fn hosts(&self) -> Result<Vec<Host>> {
        let db = self.lock()?;
        let mut stmt = db.prepare("SELECT data FROM hosts ORDER BY rowid")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        rows.map(|row| Ok(serde_json::from_str(&row?)?)).collect()
    }
    pub fn host(&self, id: &str) -> Result<Host> {
        let data: Option<String> = self
            .lock()?
            .query_row("SELECT data FROM hosts WHERE id=?1", [id], |r| r.get(0))
            .optional()?;
        data.map(|s| serde_json::from_str(&s).map_err(AppError::from))
            .transpose()?
            .ok_or_else(|| AppError::new("HOST_NOT_FOUND", "主机配置不存在"))
    }
    pub fn save_host(&self, mut host: Host) -> Result<Host> {
        if host.id.is_empty() {
            host.id = uuid::Uuid::new_v4().to_string();
        }
        validate_host(&host)?;
        if let Some(jump) = &host.jump_host_id {
            let mut current = jump.clone();
            let mut visited = std::collections::HashSet::from([host.id.clone()]);
            loop {
                if !visited.insert(current.clone()) {
                    return Err(AppError::new("JUMP_CYCLE", "跳板机配置不能形成循环"));
                }
                let other = self.host(&current)?;
                if let Some(next) = other.jump_host_id {
                    current = next;
                } else {
                    break;
                }
                if visited.len() > 8 {
                    return Err(AppError::new("JUMP_DEPTH", "最多支持 8 层跳板机"));
                }
            }
        }
        self.lock()?.execute("INSERT INTO hosts(id,data) VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET data=excluded.data", params![host.id, serde_json::to_string(&host)?])?;
        Ok(host)
    }
    pub fn delete_host(&self, id: &str) -> Result<()> {
        if self
            .hosts()?
            .iter()
            .any(|h| h.jump_host_id.as_deref() == Some(id))
        {
            return Err(AppError::new(
                "HOST_IN_USE",
                "请先移除其他主机对此跳板机的引用",
            ));
        }
        self.lock()?
            .execute("DELETE FROM hosts WHERE id=?1", [id])?;
        Ok(())
    }
    pub fn trust_status(&self, host: &Host, key: HostKeyInfo) -> Result<TrustStatus> {
        let db = self.lock()?;
        let previous: Option<String> = db
            .query_row(
                "SELECT fingerprint FROM known_hosts WHERE address=?1 AND port=?2 AND algorithm=?3",
                params![host.address.to_ascii_lowercase(), host.port, key.algorithm],
                |r| r.get(0),
            )
            .optional()?;
        let any: bool = db.query_row(
            "SELECT EXISTS(SELECT 1 FROM known_hosts WHERE address=?1 AND port=?2)",
            params![host.address.to_ascii_lowercase(), host.port],
            |r| r.get(0),
        )?;
        Ok(TrustStatus {
            trusted: previous.as_ref() == Some(&key.fingerprint),
            changed: any && previous.as_ref() != Some(&key.fingerprint),
            previous_fingerprint: previous,
            algorithm: key.algorithm,
            fingerprint: key.fingerprint,
        })
    }
    pub fn trusted_fingerprints(&self, host: &Host) -> Result<Vec<String>> {
        let db = self.lock()?;
        let mut stmt =
            db.prepare("SELECT fingerprint FROM known_hosts WHERE address=?1 AND port=?2")?;
        let rows = stmt.query_map(params![host.address.to_ascii_lowercase(), host.port], |r| {
            r.get(0)
        })?;
        Ok(rows.collect::<std::result::Result<Vec<String>, _>>()?)
    }
    pub fn trust(
        &self,
        host: &Host,
        algorithm: &str,
        fingerprint: &str,
        replace: bool,
    ) -> Result<()> {
        if !fingerprint.starts_with("SHA256:") || fingerprint.len() > 128 || algorithm.len() > 128 {
            return Err(AppError::new("INVALID_FINGERPRINT", "无效的 SSH 公钥指纹"));
        }
        let status = self.trust_status(
            host,
            HostKeyInfo {
                algorithm: algorithm.into(),
                fingerprint: fingerprint.into(),
            },
        )?;
        if status.changed && !replace {
            return Err(AppError::new(
                "HOST_KEY_CHANGED",
                "主机公钥发生变化，需要明确确认替换",
            ));
        }
        let mut db = self.lock()?;
        let tx = db.transaction()?;
        if status.changed {
            tx.execute(
                "DELETE FROM known_hosts WHERE address=?1 AND port=?2",
                params![host.address.to_ascii_lowercase(), host.port],
            )?;
        }
        tx.execute("INSERT INTO known_hosts(address,port,algorithm,fingerprint) VALUES(?1,?2,?3,?4) ON CONFLICT(address,port,algorithm) DO UPDATE SET fingerprint=excluded.fingerprint",params![host.address.to_ascii_lowercase(),host.port,algorithm,fingerprint])?;
        tx.commit()?;
        Ok(())
    }
    pub fn preference<T: for<'de> Deserialize<'de> + Default>(&self, key: &str) -> Result<T> {
        let data: Option<String> = self
            .lock()?
            .query_row("SELECT data FROM preferences WHERE key=?1", [key], |r| {
                r.get(0)
            })
            .optional()?;
        data.map(|s| serde_json::from_str(&s).map_err(AppError::from))
            .transpose()
            .map(|x| x.unwrap_or_default())
    }
    pub fn set_preference<T: Serialize>(&self, key: &str, value: &T) -> Result<()> {
        self.lock()?.execute("INSERT INTO preferences(key,data) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET data=excluded.data",params![key,serde_json::to_string(value)?])?;
        Ok(())
    }
    pub fn settings(&self) -> Result<AppSettings> {
        self.preference("settings")
    }
    pub fn save_settings(&self, settings: &AppSettings) -> Result<()> {
        validate_settings(settings)?;
        self.set_preference("settings", settings)
    }
    pub fn snippets(&self) -> Result<Vec<Snippet>> {
        let db = self.lock()?;
        let mut stmt = db.prepare("SELECT data FROM snippets ORDER BY rowid")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        rows.map(|row| Ok(serde_json::from_str(&row?)?)).collect()
    }
    pub fn save_snippet(&self, mut snippet: Snippet) -> Result<Snippet> {
        if snippet.id.is_empty() {
            snippet.id = uuid::Uuid::new_v4().to_string();
        }
        validate_snippet(&snippet)?;
        self.lock()?.execute("INSERT INTO snippets(id,data) VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET data=excluded.data",params![snippet.id,serde_json::to_string(&snippet)?])?;
        Ok(snippet)
    }
    pub fn delete_snippet(&self, id: &str) -> Result<()> {
        self.lock()?
            .execute("DELETE FROM snippets WHERE id=?1", [id])?;
        Ok(())
    }
    /// Import only configuration. Host trust is intentionally never imported.
    pub fn validate_import(
        &self,
        hosts: &[Host],
        snippets: &[Snippet],
        settings: &AppSettings,
        workspace: &Workspace,
    ) -> Result<()> {
        validate_workspace(workspace)?;
        if hosts.len() > 10000 || snippets.len() > 10000 {
            return Err(AppError::new("IMPORT_TOO_LARGE", "导入记录数量过多"));
        }
        let ids: std::collections::HashSet<_> = hosts.iter().map(|h| &h.id).collect();
        if ids.len() != hosts.len() {
            return Err(AppError::new("DUPLICATE_HOST", "导入数据包含重复主机 ID"));
        }
        validate_settings(settings)?;
        for h in hosts {
            validate_host(h)?;
        }
        for s in snippets {
            validate_snippet(s)?;
        }
        let mut merged: std::collections::HashMap<String, Host> = self
            .hosts()?
            .into_iter()
            .map(|h| (h.id.clone(), h))
            .collect();
        for h in hosts {
            merged.insert(h.id.clone(), h.clone());
        }
        for h in merged.values() {
            let mut seen = std::collections::HashSet::from([h.id.clone()]);
            let mut jump = h.jump_host_id.clone();
            while let Some(id) = jump {
                if !seen.insert(id.clone()) || seen.len() > 9 {
                    return Err(AppError::new(
                        "JUMP_CYCLE",
                        "导入数据包含跳板机循环或链过长",
                    ));
                }
                jump = merged
                    .get(&id)
                    .ok_or_else(|| AppError::new("JUMP_MISSING", "导入数据的跳板机不存在"))?
                    .jump_host_id
                    .clone();
            }
        }
        Ok(())
    }
    pub fn import_configuration(
        &self,
        hosts: &[Host],
        snippets: &[Snippet],
        settings: &AppSettings,
        workspace: &Workspace,
    ) -> Result<()> {
        self.validate_import(hosts, snippets, settings, workspace)?;
        let mut db = self.lock()?;
        let tx = db.transaction()?;
        for h in hosts {
            tx.execute("INSERT INTO hosts(id,data) VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET data=excluded.data",params![h.id,serde_json::to_string(h)?])?;
        }
        for s in snippets {
            tx.execute("INSERT INTO snippets(id,data) VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET data=excluded.data",params![s.id,serde_json::to_string(s)?])?;
        }
        for (key, value) in [
            ("settings", serde_json::to_string(settings)?),
            ("workspace", serde_json::to_string(workspace)?),
        ] {
            tx.execute("INSERT INTO preferences(key,data) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET data=excluded.data",params![key,value])?;
        }
        tx.commit()?;
        Ok(())
    }
}

pub fn validate_host(h: &Host) -> Result<()> {
    if uuid::Uuid::parse_str(&h.id).is_err() {
        return Err(AppError::new("INVALID_HOST", "主机 ID 无效"));
    }
    if h.name.trim().is_empty()
        || h.name.len() > 200
        || h.address.trim().is_empty()
        || h.address.len() > 253
        || h.address
            .contains(|c: char| c.is_whitespace() || c == '\0' || c == '/' || c == '\\')
        || h.port == 0
        || h.username.trim().is_empty()
        || h.username.len() > 128
        || h.username.contains('\0')
    {
        return Err(AppError::new(
            "INVALID_HOST",
            "请检查名称、地址、端口与用户名",
        ));
    }
    if !["builtin", "auto", "system", "local", "session"].contains(&h.credential_store.as_str()) {
        return Err(AppError::new(
            "INVALID_CREDENTIAL_STORE",
            "请选择应用内加密库、系统凭据库或仅本次使用",
        ));
    }
    if !["password", "key", "agent", "interactive"].contains(&h.auth_method.as_str()) {
        return Err(AppError::new("INVALID_AUTH", "不支持的认证方式"));
    }
    if h.auth_method == "key"
        && h.private_key_path
            .as_ref()
            .is_none_or(|p| p.trim().is_empty() || p.contains('\0'))
    {
        return Err(AppError::new("INVALID_KEY", "请选择私钥文件"));
    }
    if h.connect_timeout_seconds < 1
        || h.connect_timeout_seconds > 120
        || h.keep_alive_seconds > 600
    {
        return Err(AppError::new(
            "INVALID_TIMEOUT",
            "超时时间应为 1–120 秒，心跳为 0–600 秒",
        ));
    }
    if h.group.len() > 200
        || h.notes.len() > 10000
        || h.color.len() > 40
        || h.startup_directory
            .as_ref()
            .is_some_and(|s| s.len() > 4096 || s.contains('\0'))
    {
        return Err(AppError::new("INVALID_HOST", "配置内容超出允许范围"));
    }
    if let Some(p) = &h.proxy {
        if !["socks5", "http"].contains(&p.kind.as_str())
            || p.host.is_empty()
            || p.host.len() > 253
            || p.host.contains(|c: char| c.is_whitespace() || c == '\0')
            || p.port == 0
        {
            return Err(AppError::new("INVALID_PROXY", "代理地址或端口无效"));
        }
    }
    if h.proxy.is_some() && h.jump_host_id.is_some() {
        return Err(AppError::new(
            "NETWORK_CONFLICT",
            "同一层连接请选择代理或跳板机之一；可为跳板机单独配置代理",
        ));
    }
    Ok(())
}
pub fn validate_settings(s: &AppSettings) -> Result<()> {
    if !["dark", "light", "graphite", "mist", "aurora"].contains(&s.theme.as_str())
        || !(9..=30).contains(&s.font_size)
        || s.font_family.len() > 300
        || !(100..=100000).contains(&s.scrollback)
        || !(2..=60).contains(&s.monitor_interval)
        || !(1..=8).contains(&s.transfer_concurrency)
    {
        return Err(AppError::new("INVALID_SETTINGS", "设置值超出允许范围"));
    }
    Ok(())
}
pub fn validate_workspace(w: &Workspace) -> Result<()> {
    if w.host_ids.len() > 100
        || w.host_ids
            .iter()
            .any(|id| uuid::Uuid::parse_str(id).is_err())
        || w.active_host_id
            .as_ref()
            .is_some_and(|id| uuid::Uuid::parse_str(id).is_err())
        || !["none", "horizontal", "vertical"].contains(&w.split.as_str())
        || !w.sidebar_width.is_finite()
        || !(160.0..=800.0).contains(&w.sidebar_width)
        || !w.files_height.is_finite()
        || !(120.0..=2000.0).contains(&w.files_height)
    {
        return Err(AppError::new(
            "INVALID_WORKSPACE",
            "工作区布局格式或范围无效",
        ));
    }
    Ok(())
}
fn validate_snippet(s: &Snippet) -> Result<()> {
    if uuid::Uuid::parse_str(&s.id).is_err()
        || s.name.trim().is_empty()
        || s.name.len() > 200
        || s.group.len() > 200
        || s.command.len() > 65536
        || s.command.contains('\0')
    {
        return Err(AppError::new("INVALID_SNIPPET", "命令片段格式无效"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn host() -> Host {
        Host {
            id: uuid::Uuid::new_v4().to_string(),
            name: "Test".into(),
            address: "example.com".into(),
            port: 22,
            username: "user".into(),
            group: "".into(),
            auth_method: "agent".into(),
            credential_store: "system".into(),
            private_key_path: None,
            proxy: None,
            jump_host_id: None,
            startup_directory: None,
            keep_alive_seconds: 30,
            connect_timeout_seconds: 15,
            favorite: false,
            color: "#63afff".into(),
            notes: "".into(),
        }
    }
    #[test]
    fn changed_fingerprint_requires_explicit_replacement_and_is_address_bound() {
        let store = Storage::from_connection(Connection::open_in_memory().unwrap()).unwrap();
        let mut host = host();
        store
            .trust(&host, "ssh-ed25519", "SHA256:first", false)
            .unwrap();
        assert!(store
            .trust(&host, "ssh-ed25519", "SHA256:changed", false)
            .is_err());
        host.id = uuid::Uuid::new_v4().to_string();
        assert!(
            store
                .trust_status(
                    &host,
                    HostKeyInfo {
                        algorithm: "ssh-ed25519".into(),
                        fingerprint: "SHA256:first".into()
                    }
                )
                .unwrap()
                .trusted
        );
        host.port = 2222;
        assert!(
            !store
                .trust_status(
                    &host,
                    HostKeyInfo {
                        algorithm: "ssh-ed25519".into(),
                        fingerprint: "SHA256:first".into()
                    }
                )
                .unwrap()
                .trusted
        );
    }
    #[test]
    fn cyclic_jump_hosts_are_rejected_without_partial_import() {
        let store = Storage::from_connection(Connection::open_in_memory().unwrap()).unwrap();
        let mut a = host();
        let mut b = host();
        a.jump_host_id = Some(b.id.clone());
        b.jump_host_id = Some(a.id.clone());
        assert!(store
            .import_configuration(&[a, b], &[], &AppSettings::default(), &Workspace::default())
            .is_err());
        assert!(store.hosts().unwrap().is_empty());
    }
}
