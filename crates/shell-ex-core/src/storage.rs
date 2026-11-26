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
    /// Keep explicit groups even when they contain no saved hosts.
    pub fn host_groups(&self) -> Result<Vec<String>> {
        let db = self.lock()?;
        let mut groups = read_host_groups(&db)?;
        let mut stmt = db.prepare("SELECT data FROM hosts ORDER BY rowid")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        for row in rows {
            let value: serde_json::Value = serde_json::from_str(&row?)?;
            let name = host_group_name(&value);
            if !groups.iter().any(|g| g == name) {
                groups.push(name.to_owned());
            }
        }
        Ok(groups)
    }

    /// Rename/delete a group transactionally without accessing credentials
    /// or modifying any host field other than its group.
    pub fn change_host_group(
        &self,
        action: &str,
        name: &str,
        new_name: Option<&str>,
    ) -> Result<()> {
        let mut db = self.lock()?;
        let tx = db.transaction()?;
        let mut groups = read_host_groups(&tx)?;
        let hosts: Vec<(String, serde_json::Value)> = {
            let mut stmt = tx.prepare("SELECT id,data FROM hosts ORDER BY rowid")?;
            let rows =
                stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
            rows.map(|row| {
                let (id, data) = row?;
                Ok((id, serde_json::from_str(&data)?))
            })
            .collect::<Result<_>>()?
        };
        let mut known = groups.clone();
        for (_, value) in &hosts {
            let group = host_group_name(value);
            if !known.iter().any(|g| g == group) {
                known.push(group.to_owned());
            }
        }
        let validate_new = |candidate: &str| -> Result<()> {
            if candidate.trim() != candidate
                || candidate.is_empty()
                || candidate.len() > 200
                || candidate.chars().any(char::is_control)
                || candidate == "__favorites"
                || candidate == DEFAULT_HOST_GROUP
            {
                return Err(AppError::new(
                    "INVALID_GROUP_NAME",
                    "分组名称无效，请使用非空名称且不超过 200 字节。",
                ));
            }
            if known.iter().any(|g| g == candidate) {
                return Err(AppError::new("GROUP_EXISTS", "该分组已经存在。"));
            }
            Ok(())
        };
        match action {
            "create" => {
                validate_new(name)?;
                if groups.len() >= 1000 {
                    return Err(AppError::new("GROUP_LIMIT", "自定义分组数量已达上限。"));
                }
                groups.push(name.to_owned());
            }
            "rename" | "delete" => {
                if name == DEFAULT_HOST_GROUP || !known.iter().any(|g| g == name) {
                    return Err(AppError::new(
                        "GROUP_NOT_EDITABLE",
                        "默认分组不能修改，或该分组已不存在。",
                    ));
                }
                let target = if action == "rename" {
                    let candidate = new_name
                        .ok_or_else(|| AppError::new("INVALID_GROUP_NAME", "请输入新分组名称。"))?;
                    validate_new(candidate)?;
                    candidate
                } else {
                    DEFAULT_HOST_GROUP
                };
                groups.retain(|g| g != name);
                if action == "rename" {
                    if groups.len() >= 1000 {
                        return Err(AppError::new("GROUP_LIMIT", "自定义分组数量已达上限。"));
                    }
                    groups.push(target.to_owned());
                }
                for (id, mut value) in hosts {
                    if host_group_name(&value) == name {
                        let object = value
                            .as_object_mut()
                            .ok_or_else(|| AppError::new("INVALID_HOST", "主机配置不存在"))?;
                        object.insert(
                            "group".to_owned(),
                            serde_json::Value::String(target.to_owned()),
                        );
                        tx.execute(
                            "UPDATE hosts SET data=?1 WHERE id=?2",
                            params![serde_json::to_string(&value)?, id],
                        )?;
                    }
                }
            }
            "move" => {
                let target = new_name
                    .ok_or_else(|| AppError::new("INVALID_GROUP_NAME", "请选择目标分组。"))?;
                if target != DEFAULT_HOST_GROUP && !known.iter().any(|g| g == target) {
                    return Err(AppError::new("GROUP_NOT_FOUND", "目标分组不存在。"));
                }
                let (id, mut value) = hosts
                    .into_iter()
                    .find(|(id, _)| id == name)
                    .ok_or_else(|| AppError::new("HOST_NOT_FOUND", "主机配置不存在"))?;
                let previous = host_group_name(&value).to_owned();
                if previous != DEFAULT_HOST_GROUP && !groups.contains(&previous) {
                    groups.push(previous);
                }
                let object = value
                    .as_object_mut()
                    .ok_or_else(|| AppError::new("INVALID_HOST", "主机配置不存在"))?;
                object.insert(
                    "group".to_owned(),
                    serde_json::Value::String(target.to_owned()),
                );
                tx.execute(
                    "UPDATE hosts SET data=?1 WHERE id=?2",
                    params![serde_json::to_string(&value)?, id],
                )?;
            }
            _ => return Err(AppError::new("INVALID_GROUP_ACTION", "不支持的分组操作。")),
        }
        tx.execute("INSERT INTO preferences(key,data) VALUES('host-groups',?1) ON CONFLICT(key) DO UPDATE SET data=excluded.data",
            [serde_json::to_string(&groups)?])?;
        tx.commit()?;
        Ok(())
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
        let mut db = self.lock()?;
        let tx = db.transaction()?;
        remember_host_groups(&tx, std::iter::once(host.group.as_str()))?;
        tx.execute("INSERT INTO hosts(id,data) VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET data=excluded.data", params![host.id, serde_json::to_string(&host)?])?;
        tx.commit()?;
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
        let mut db = self.lock()?;
        let tx = db.transaction()?;
        remember_host_groups(&tx, std::iter::empty::<&str>())?;
        tx.execute("DELETE FROM hosts WHERE id=?1", [id])?;
        tx.commit()?;
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
        remember_host_groups(&tx, hosts.iter().map(|h| h.group.as_str()))?;
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

const DEFAULT_HOST_GROUP: &str = "默认分组";

fn host_group_name(value: &serde_json::Value) -> &str {
    value
        .get("group")
        .and_then(serde_json::Value::as_str)
        .filter(|name| !name.is_empty())
        .unwrap_or(DEFAULT_HOST_GROUP)
}

fn read_host_groups(db: &Connection) -> Result<Vec<String>> {
    let data: Option<String> = db
        .query_row(
            "SELECT data FROM preferences WHERE key='host-groups'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    Ok(data
        .map(|json| serde_json::from_str(&json))
        .transpose()?
        .unwrap_or_default())
}

fn remember_host_groups<'a>(
    db: &Connection,
    additional: impl Iterator<Item = &'a str>,
) -> Result<()> {
    let mut groups = read_host_groups(db)?;
    let mut stmt = db.prepare("SELECT data FROM hosts ORDER BY rowid")?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
    let mut names = Vec::new();
    for row in rows {
        let value: serde_json::Value = serde_json::from_str(&row?)?;
        names.push(host_group_name(&value).to_owned());
    }
    names.extend(additional.map(str::to_owned));
    for name in names {
        if !name.is_empty() && name != DEFAULT_HOST_GROUP && !groups.contains(&name) {
            groups.push(name);
        }
    }
    db.execute("INSERT INTO preferences(key,data) VALUES('host-groups',?1) ON CONFLICT(key) DO UPDATE SET data=excluded.data", [serde_json::to_string(&groups)?])?;
    Ok(())
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
    if !["builtin", "auto", "local", "session"].contains(&h.credential_store.as_str()) {
        return Err(AppError::new(
            "INVALID_CREDENTIAL_STORE",
            "请选择应用内加密库或仅本次使用",
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
        || h.group == "__favorites"
        || h.group.chars().any(char::is_control)
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
    if !is_supported_theme(&s.theme)
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
        || !(240.0..=1000.0).contains(&w.monitor_width)
        || !(120.0..=700.0).contains(&w.file_tree_width)
        || w.file_column_widths.len() != 6
        || w.file_column_widths
            .iter()
            .any(|v| !(56.0..=1400.0).contains(v))
        || w.transfer_column_widths.len() != 5
        || w.transfer_column_widths
            .iter()
            .zip([150.0, 100.0, 72.0, 80.0, 88.0])
            .any(|(v, min)| !(min..=1400.0).contains(v))
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
    #[test]
    fn all_current_and_legacy_themes_are_valid_and_roundtrip() {
        for theme in [
            "black",
            "gray",
            "graphite",
            "aurora",
            "soft-white",
            "mist",
            "light",
            "dark",
        ] {
            let mut settings = crate::models::AppSettings::default();
            settings.theme = theme.into();
            assert!(super::validate_settings(&settings).is_ok(), "{theme}");
            let value: crate::models::AppSettings =
                serde_json::from_str(&serde_json::to_string(&settings).unwrap()).unwrap();
            assert_eq!(value.theme, theme);
        }
        let mut invalid = crate::models::AppSettings::default();
        invalid.theme = "unknown".into();
        assert!(super::validate_settings(&invalid).is_err());
    }

    #[test]
    fn workspace_resize_preferences_are_backward_compatible_and_bounded() {
        let previous: crate::models::Workspace = serde_json::from_value(serde_json::json!({
            "hostIds": [], "activeHostId": null, "sidebarWidth": 236, "filesHeight": 326,
            "monitorVisible": true, "filesVisible": true, "split": "none"
        }))
        .unwrap();
        assert_eq!(
            previous.file_column_widths,
            vec![280.0, 100.0, 92.0, 160.0, 132.0, 116.0]
        );
        assert_eq!(
            previous.transfer_column_widths,
            vec![340.0, 220.0, 96.0, 104.0, 100.0]
        );
        assert_eq!(previous.file_tree_width, 210.0);
        assert_eq!(previous.monitor_width, 365.0);
        assert!(super::validate_workspace(&previous).is_ok());
        let mut changed = previous;
        changed.file_tree_width = 350.0;
        changed.monitor_width = 520.0;
        changed.file_column_widths[0] = 410.0;
        changed.transfer_column_widths[0] = 460.0;
        assert!(super::validate_workspace(&changed).is_ok());
        let roundtrip: crate::models::Workspace =
            serde_json::from_str(&serde_json::to_string(&changed).unwrap()).unwrap();
        assert_eq!(roundtrip.file_column_widths[0], 410.0);
        assert_eq!(roundtrip.transfer_column_widths[0], 460.0);
        assert_eq!(roundtrip.monitor_width, 520.0);
        assert_eq!(roundtrip.file_tree_width, 350.0);
        let mut invalid = changed.clone();
        invalid.transfer_column_widths[4] = 30.0;
        assert!(super::validate_workspace(&invalid).is_err());
        changed.file_column_widths.pop();
        assert!(super::validate_workspace(&changed).is_err());
    }

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
            credential_store: "builtin".into(),
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
    fn host_groups_persist_and_only_change_group_metadata() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("groups.sqlite3");
        let store = Storage::open(&path).unwrap();
        store
            .change_host_group("create", "Production", None)
            .unwrap();
        assert_eq!(store.host_groups().unwrap(), vec!["Production"]);
        assert!(store
            .change_host_group("create", "Production", None)
            .is_err());
        assert!(store
            .change_host_group("create", DEFAULT_HOST_GROUP, None)
            .is_err());
        assert!(store.change_host_group("create", " ", None).is_err());
        let mut original = host();
        original.group = "Production".into();
        original.favorite = true;
        original.notes = "keep this".into();
        store.save_host(original.clone()).unwrap();
        store.change_host_group("create", "Other", None).unwrap();
        store
            .change_host_group("move", &original.id, Some("Other"))
            .unwrap();
        assert_eq!(store.host(&original.id).unwrap().group, "Other");
        assert!(store
            .host_groups()
            .unwrap()
            .contains(&"Production".to_owned()));
        store
            .change_host_group("move", &original.id, Some("Production"))
            .unwrap();
        store.change_host_group("delete", "Other", None).unwrap();
        store
            .change_host_group("rename", "Production", Some("Servers"))
            .unwrap();
        let mut expected = serde_json::to_value(&original).unwrap();
        expected["group"] = serde_json::json!("Servers");
        assert_eq!(
            serde_json::to_value(store.host(&original.id).unwrap()).unwrap(),
            expected
        );
        assert_eq!(store.host_groups().unwrap(), vec!["Servers"]);
        drop(store);
        let store = Storage::open(&path).unwrap();
        assert_eq!(store.host_groups().unwrap(), vec!["Servers"]);
        store.change_host_group("delete", "Servers", None).unwrap();
        expected["group"] = serde_json::json!(DEFAULT_HOST_GROUP);
        assert_eq!(
            serde_json::to_value(store.host(&original.id).unwrap()).unwrap(),
            expected
        );
        assert_eq!(store.host_groups().unwrap(), vec![DEFAULT_HOST_GROUP]);
        assert!(store
            .change_host_group("delete", DEFAULT_HOST_GROUP, None)
            .is_err());
        store.change_host_group("create", "Empty", None).unwrap();
        store.change_host_group("delete", "Empty", None).unwrap();
        assert_eq!(store.host_groups().unwrap(), vec![DEFAULT_HOST_GROUP]);
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
