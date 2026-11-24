//! Fixed, application-wide encryption for offline personal use.
//!
//! No password prompt or per-installation key file is required. Because the
//! key material ships in the executable, this is protection from casually
//! reading SQLite plaintext, NOT protection from someone who has the app.
use crate::{
    credentials::CredentialVault,
    error::{AppError, Result},
    models::SecretInput,
};
use aes_gcm::{
    aead::{Aead, Payload},
    Aes256Gcm, KeyInit, Nonce,
};
use rand::{rngs::OsRng, RngCore};
use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::Path,
    sync::{Mutex, MutexGuard},
    time::Duration,
};
use zeroize::Zeroizing;

const DB_FILE: &str = "builtin-vault.sqlite3";
const AAD: &[u8] = b"shell-ex/offline-builtin-credential/v1/";
const BUILTIN_KEY_MATERIAL: &[u8] =
    b"Shell EX offline built-in AES-256-GCM credential encryption v1 | com.xzcode.shell-ex";

pub struct BuiltinVault {
    db: Mutex<Connection>,
}

impl BuiltinVault {
    pub fn open(dir: &Path) -> Result<Self> {
        fs::create_dir_all(dir)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
        }
        let path = dir.join(DB_FILE);
        if let Ok(meta) = fs::symlink_metadata(&path) {
            if !meta.is_file() || meta.file_type().is_symlink() {
                return Err(AppError::new(
                    "BUILTIN_VAULT_PATH",
                    "加密凭据库必须是本机普通文件",
                ));
            }
        }
        let db = Connection::open(&path)?;
        db.busy_timeout(Duration::from_secs(5))?;
        db.execute_batch(
            "PRAGMA journal_mode=DELETE;
             PRAGMA secure_delete=ON;
             CREATE TABLE IF NOT EXISTS builtin_secrets(
               id TEXT PRIMARY KEY,
               nonce BLOB NOT NULL,
               ciphertext BLOB NOT NULL
             );",
        )?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
        }
        Ok(Self { db: Mutex::new(db) })
    }

    fn db(&self) -> Result<MutexGuard<'_, Connection>> {
        self.db
            .lock()
            .map_err(|_| AppError::new("BUILTIN_VAULT_LOCK", "本地凭据库暂不可用"))
    }

    fn cipher() -> Result<Aes256Gcm> {
        // Stable for all installations and launches; there is no separate key file.
        let key = Sha256::digest(BUILTIN_KEY_MATERIAL);
        Aes256Gcm::new_from_slice(&key).map_err(AppError::internal)
    }

    fn associated_data(id: &str) -> Result<Vec<u8>> {
        uuid::Uuid::parse_str(id)
            .map_err(|_| AppError::new("INVALID_HOST", "无效的凭据关联标识"))?;
        let mut aad = AAD.to_vec();
        aad.extend_from_slice(id.as_bytes());
        Ok(aad)
    }

    pub fn count(&self) -> Result<u64> {
        let count: i64 = self.db()?.query_row(
            "SELECT COUNT(*) FROM builtin_secrets",
            [],
            |row| row.get(0),
        )?;
        Ok(count.max(0) as u64)
    }
}

impl CredentialVault for BuiltinVault {
    fn get(&self, id: &str) -> Result<Option<SecretInput>> {
        let aad = Self::associated_data(id)?;
        let encrypted: Option<(Vec<u8>, Vec<u8>)> = self.db()?
            .query_row(
                "SELECT nonce,ciphertext FROM builtin_secrets WHERE id=?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let Some((nonce, ciphertext)) = encrypted else {
            return Ok(None);
        };
        if nonce.len() != 12 {
            return Err(AppError::new("BUILTIN_VAULT_CORRUPT", "保存的密码格式损坏"));
        }
        let plain = Zeroizing::new(
            Self::cipher()?
                .decrypt(
                    Nonce::from_slice(&nonce),
                    Payload {
                        msg: &ciphertext,
                        aad: &aad,
                    },
                )
                .map_err(|_| AppError::new(
                    "BUILTIN_VAULT_AUTH_FAILED",
                    "保存的密码已损坏，无法解密",
                ))?,
        );
        Ok(Some(serde_json::from_slice(&plain)?))
    }

    fn set(&self, id: &str, secret: &SecretInput) -> Result<()> {
        let aad = Self::associated_data(id)?;
        let mut nonce = [0u8; 12];
        OsRng.fill_bytes(&mut nonce);
        let plain = Zeroizing::new(serde_json::to_vec(secret)?);
        let ciphertext = Self::cipher()?
            .encrypt(
                Nonce::from_slice(&nonce),
                Payload { msg: &plain, aad: &aad },
            )
            .map_err(|_| AppError::new("BUILTIN_VAULT_ENCRYPT_FAILED", "密码加密失败"))?;
        self.db()?.execute(
            "INSERT INTO builtin_secrets(id,nonce,ciphertext) VALUES(?1,?2,?3)
             ON CONFLICT(id) DO UPDATE SET
             nonce=excluded.nonce,ciphertext=excluded.ciphertext",
            params![id, &nonce, &ciphertext],
        )?;
        Ok(())
    }

    fn delete(&self, id: &str) -> Result<()> {
        Self::associated_data(id)?;
        self.db()?.execute("DELETE FROM builtin_secrets WHERE id=?1", [id])?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn built_in_encryption_requires_no_key_file_or_master_password() {
        let temp = tempfile::tempdir().unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let secret = SecretInput {
            password: Some("example-ssh-password-1234".into()),
            passphrase: None,
        };
        {
            let vault = BuiltinVault::open(temp.path()).unwrap();
            vault.set(&id, &secret).unwrap();
            assert_eq!(vault.count().unwrap(), 1);
            let raw: Vec<u8> = vault.db().unwrap()
                .query_row("SELECT ciphertext FROM builtin_secrets WHERE id=?1",
                    [&id], |row| row.get(0)).unwrap();
            assert!(!String::from_utf8_lossy(&raw).contains("example-ssh-password"));
            assert_eq!(vault.get(&id).unwrap().unwrap().password, secret.password);
        }
        assert!(!temp.path().join("auto-vault.key").exists());
        assert!(!temp.path().join("builtin-vault.key").exists());
        let reopened = BuiltinVault::open(temp.path()).unwrap();
        assert_eq!(reopened.get(&id).unwrap().unwrap().password, secret.password);
    }

    #[test]
    fn rejects_tampering_and_other_host_ciphertext() {
        let temp = tempfile::tempdir().unwrap();
        let first = uuid::Uuid::new_v4().to_string();
        let second = uuid::Uuid::new_v4().to_string();
        let vault = BuiltinVault::open(temp.path()).unwrap();
        vault.set(&first, &SecretInput {
            password: Some("secret".into()),
            passphrase: None,
        }).unwrap();
        vault.db().unwrap().execute(
            "INSERT INTO builtin_secrets(id,nonce,ciphertext)
             SELECT ?1,nonce,ciphertext FROM builtin_secrets WHERE id=?2",
            params![second, first],
        ).unwrap();
        assert!(vault.get(&second).is_err());
        vault.db().unwrap().execute(
            "UPDATE builtin_secrets SET ciphertext=X'001122' WHERE id=?1",
            [&first],
        ).unwrap();
        assert!(vault.get(&first).is_err());
    }

    #[test]
    fn same_database_can_be_decrypted_on_another_installation() {
        // Intentional: user chooses a common offline algorithm with no master password.
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let vault = BuiltinVault::open(first.path()).unwrap();
        vault.set(&id, &SecretInput {
            password: Some("portable-secret".into()),
            passphrase: None,
        }).unwrap();
        drop(vault);
        fs::copy(first.path().join(DB_FILE), second.path().join(DB_FILE)).unwrap();
        let other = BuiltinVault::open(second.path()).unwrap();
        assert_eq!(
            other.get(&id).unwrap().unwrap().password.as_deref(),
            Some("portable-secret")
        );
    }
}
