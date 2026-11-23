use crate::{
    error::{AppError, Result},
    models::SecretInput,
};
use zeroize::Zeroizing;

pub trait CredentialVault: Send + Sync {
    fn get(&self, id: &str) -> Result<Option<SecretInput>>;
    fn set(&self, id: &str, secret: &SecretInput) -> Result<()>;
    fn delete(&self, id: &str) -> Result<()>;
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
        "系统凭据库不可用或已锁定；可解锁凭据库，或取消记住密码并临时连接。",
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
