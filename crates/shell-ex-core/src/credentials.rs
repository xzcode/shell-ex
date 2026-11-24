use crate::{
    error::{AppError, Result},
    local_vault::LocalVault,
    models::{Host, SecretInput},
    storage::Storage,
};
use std::sync::Arc;
use zeroize::Zeroizing;

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
pub struct SystemVault;
impl SystemVault {
    fn entry(id: &str) -> Result<keyring::Entry> {
        if uuid::Uuid::parse_str(id).is_err() {
            return Err(AppError::new("INVALID_HOST", "无效的凭据标识"));
        }
        keyring::Entry::new("com.xzcode.shell-ex", id).map_err(map_error)
    }
}
fn map_error(_: keyring::Error) -> AppError {
    AppError::new(
        "KEYCHAIN_UNAVAILABLE",
        "系统凭据库不可用或已锁定；可解锁凭据库，或使用应用内加密库。",
    )
}
impl CredentialVault for SystemVault {
    fn get(&self, id: &str) -> Result<Option<SecretInput>> {
        match Self::entry(id)?.get_password() {
            Ok(value) => Ok(Some(serde_json::from_str(&Zeroizing::new(value))?)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(map_error(e)),
        }
    }
    fn set(&self, id: &str, secret: &SecretInput) -> Result<()> {
        let content = Zeroizing::new(serde_json::to_string(secret)?);
        Self::entry(id)?.set_password(&content).map_err(map_error)
    }
    fn delete(&self, id: &str) -> Result<()> {
        match Self::entry(id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(map_error(e)),
        }
    }
}

/// Routes per-host credentials to the local encrypted database, legacy
/// Keychain, or no persistence. The host record contains only the mode.
pub struct RoutedVault {
    store: Arc<Storage>,
    local: Arc<LocalVault>,
    system: SystemVault,
}
impl RoutedVault {
    pub fn new(store: Arc<Storage>, local: Arc<LocalVault>) -> Self {
        Self {
            store,
            local,
            system: SystemVault,
        }
    }
    fn host(&self, id: &str) -> Result<Host> {
        self.store.host(id)
    }
    pub fn local(&self) -> &LocalVault {
        &self.local
    }
    pub fn get_by_mode(&self, id: &str, mode: &str) -> Result<Option<SecretInput>> {
        match mode {
            "local" => self.local.get(id),
            "system" => self.system.get(id),
            "session" => Ok(None),
            _ => Err(AppError::new(
                "INVALID_CREDENTIAL_STORE",
                "不支持的凭据存储位置",
            )),
        }
    }
    pub fn set_by_mode(&self, id: &str, mode: &str, secret: &SecretInput) -> Result<()> {
        match mode {
            "local" => self.local.set(id, secret),
            "system" => self.system.set(id, secret),
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
            "local" => self.local.delete(id),
            "system" => self.system.delete(id),
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
