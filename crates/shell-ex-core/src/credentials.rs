use crate::{
    auto_vault::AutoVault,
    builtin_vault::BuiltinVault,
    error::{AppError, Result},
    local_vault::LocalVault,
    models::{Host, SecretInput},
    storage::Storage,
};
use std::sync::Arc;

pub trait CredentialVault: Send + Sync {
    fn get(&self, id: &str) -> Result<Option<SecretInput>>;
    fn set(&self, id: &str, secret: &SecretInput) -> Result<()>;
    fn delete(&self, id: &str) -> Result<()>;
    fn get_for_host(&self, host: &Host) -> Result<Option<SecretInput>> {
        self.get(&host.id)
    }
    fn set_for_host(&self, host: &Host, secret: &SecretInput) -> Result<()> {
        self.set(&host.id, secret)
    }
    fn delete_for_host(&self, host: &Host) -> Result<()> {
        self.delete(&host.id)
    }
}
/// Routes credentials exclusively to local application vaults or session-only mode.
pub struct RoutedVault {
    store: Arc<Storage>,
    local: Arc<LocalVault>,
    automatic: Option<Arc<AutoVault>>,
    builtin: Arc<BuiltinVault>,
}
impl RoutedVault {
    pub fn new(
        store: Arc<Storage>,
        local: Arc<LocalVault>,
        automatic: Option<Arc<AutoVault>>,
        builtin: Arc<BuiltinVault>,
    ) -> Self {
        Self {
            store,
            local,
            automatic,
            builtin,
        }
    }
    fn host(&self, id: &str) -> Result<Host> {
        self.store.host(id)
    }
    pub fn local(&self) -> &LocalVault {
        &self.local
    }
    pub fn automatic(&self) -> Option<&AutoVault> {
        self.automatic.as_deref()
    }
    pub fn get_by_mode(&self, id: &str, mode: &str) -> Result<Option<SecretInput>> {
        match mode {
            "builtin" => self.builtin.get(id),
            "auto" => self
                .automatic
                .as_ref()
                .ok_or_else(|| AppError::new("LEGACY_AUTO_VAULT_MISSING", "旧版自动密码库不存在"))?
                .get(id),
            "local" => self.local.get(id),
            "session" => Ok(None),
            _ => Err(AppError::new(
                "INVALID_CREDENTIAL_STORE",
                "不支持的凭据存储位置",
            )),
        }
    }
    pub fn set_by_mode(&self, id: &str, mode: &str, secret: &SecretInput) -> Result<()> {
        match mode {
            "builtin" => self.builtin.set(id, secret),
            "auto" => self
                .automatic
                .as_ref()
                .ok_or_else(|| AppError::new("LEGACY_AUTO_VAULT_MISSING", "旧版自动密码库不存在"))?
                .set(id, secret),
            "local" => self.local.set(id, secret),
            "session" => Err(AppError::new(
                "SESSION_ONLY",
                "仅本次使用模式不能持久保存密码",
            )),
            _ => Err(AppError::new(
                "INVALID_CREDENTIAL_STORE",
                "不支持的凭据存储位置",
            )),
        }
    }
    pub fn delete_by_mode(&self, id: &str, mode: &str) -> Result<()> {
        match mode {
            "builtin" => self.builtin.delete(id),
            "auto" => self
                .automatic
                .as_ref()
                .ok_or_else(|| AppError::new("LEGACY_AUTO_VAULT_MISSING", "旧版自动密码库不存在"))?
                .delete(id),
            "local" => self.local.delete(id),
            "session" => Ok(()),
            _ => Err(AppError::new(
                "INVALID_CREDENTIAL_STORE",
                "不支持的凭据存储位置",
            )),
        }
    }
}
impl CredentialVault for RoutedVault {
    fn get(&self, id: &str) -> Result<Option<SecretInput>> {
        let host = self.host(id)?;
        self.get_for_host(&host)
    }
    fn set(&self, id: &str, secret: &SecretInput) -> Result<()> {
        let host = self.host(id)?;
        self.set_for_host(&host, secret)
    }
    fn delete(&self, id: &str) -> Result<()> {
        let host = self.host(id)?;
        self.delete_for_host(&host)
    }
    fn get_for_host(&self, host: &Host) -> Result<Option<SecretInput>> {
        self.get_by_mode(&host.id, &host.credential_store)
    }
    fn set_for_host(&self, host: &Host, secret: &SecretInput) -> Result<()> {
        self.set_by_mode(&host.id, &host.credential_store, secret)
    }
    fn delete_for_host(&self, host: &Host) -> Result<()> {
        self.delete_by_mode(&host.id, &host.credential_store)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_system_host_can_be_saved_and_reopened_only_in_builtin_vault() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(Storage::open(&dir.path().join("hosts.sqlite3")).unwrap());
        let id = uuid::Uuid::new_v4().to_string();
        let host: Host = serde_json::from_value(serde_json::json!({
            "id": id, "name": "Legacy", "address": "192.0.2.1", "port": 22,
            "username": "test", "group": "", "authMethod": "password",
            "credentialStore": "system", "privateKeyPath": null, "proxy": null,
            "jumpHostId": null, "startupDirectory": null, "keepAliveSeconds": 30,
            "connectTimeoutSeconds": 15, "favorite": false, "color": "#aaa", "notes": ""
        }))
        .unwrap();
        assert_eq!(host.credential_store, "builtin");
        let host = store.save_host(host).unwrap();
        let vault = RoutedVault::new(
            store.clone(),
            Arc::new(LocalVault::open(&dir.path().join("local.sqlite3")).unwrap()),
            None,
            Arc::new(BuiltinVault::open(dir.path()).unwrap()),
        );
        assert!(vault.get(&host.id).unwrap().is_none());
        let secret = SecretInput {
            password: Some("fixture-password".into()),
            passphrase: None,
        };
        // Legacy raw system mode must not be usable as an OS backend.
        assert!(vault.get_by_mode(&host.id, "system").is_err());
        assert!(vault.set_by_mode(&host.id, "system", &secret).is_err());
        assert!(vault.delete_by_mode(&host.id, "system").is_err());
        vault.set_for_host(&host, &secret).unwrap();
        let reopened = RoutedVault::new(
            store,
            Arc::new(LocalVault::open(&dir.path().join("local.sqlite3")).unwrap()),
            None,
            Arc::new(BuiltinVault::open(dir.path()).unwrap()),
        );
        assert_eq!(
            reopened.get(&host.id).unwrap().unwrap().password.as_deref(),
            Some("fixture-password")
        );
    }
}
