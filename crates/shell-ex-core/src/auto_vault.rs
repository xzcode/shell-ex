//! Zero-prompt, per-installation credential encryption.
//!
//! The random 256-bit key is stored in a private application-data file.
//! This protects credentials from accidental disclosure and plaintext backups,
//! but NOT from an attacker able to copy both the key and encrypted database.
//! Existing master-password vaults are stored separately and left untouched.
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
use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::Path,
    sync::{Mutex, MutexGuard},
    time::Duration,
};
use zeroize::Zeroizing;

const AAD: &[u8] = b"shell-ex/auto-credential/v1/";
const KEY_FILE: &str = "auto-vault.key";
const DB_FILE: &str = "auto-vault.sqlite3";

pub struct AutoVault {
    key: Zeroizing<[u8; 32]>,
    database: Mutex<Connection>,
}

impl AutoVault {
    pub fn open(data_dir: &Path) -> Result<Self> {
        fs::create_dir_all(data_dir)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(data_dir, fs::Permissions::from_mode(0o700))?;
        }
        let db_path = data_dir.join(DB_FILE);
        let key_path = data_dir.join(KEY_FILE);
        for path in [&db_path, &key_path] {
            if let Ok(meta) = fs::symlink_metadata(path) {
                if !meta.is_file() || meta.file_type().is_symlink() {
                    return Err(AppError::new("AUTO_VAULT_PATH", "凭据文件必须是普通文件"));
                }
            }
        }
        if db_path.exists() && !key_path.exists() {
            return Err(AppError::new(
                "AUTO_VAULT_KEY_MISSING",
                "加密库密钥文件缺失。请恢复原应用数据目录，不能自动覆盖密钥。",
            ));
        }
        let key = if key_path.exists() {
            let mut options = OpenOptions::new();
            options.read(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.custom_flags(libc::O_NOFOLLOW);
            }
            let mut file = options.open(&key_path)?;
            if file.metadata()?.len() != 32 {
                return Err(AppError::new(
                    "AUTO_VAULT_KEY_INVALID",
                    "本地加密密钥格式损坏",
                ));
            }
            let mut value = Zeroizing::new([0u8; 32]);
            file.read_exact(&mut *value)?;
            value
        } else {
            let value = Zeroizing::new(Self::random::<32>());
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
            }
            let mut file = options.open(&key_path)?;
            file.write_all(&*value)?;
            file.sync_all()?;
            value
        };
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&key_path, fs::Permissions::from_mode(0o600))?;
        }
        let connection = Connection::open(&db_path)?;
        connection.busy_timeout(Duration::from_secs(5))?;
        // DELETE journaling avoids persistent WAL files alongside the private DB.
        connection.execute_batch(
            "PRAGMA journal_mode=DELETE;
             PRAGMA secure_delete=ON;
             CREATE TABLE IF NOT EXISTS auto_secrets(
               id TEXT PRIMARY KEY,
               nonce BLOB NOT NULL,
               ciphertext BLOB NOT NULL
             );",
        )?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&db_path, fs::Permissions::from_mode(0o600))?;
        }
        Ok(Self {
            key,
            database: Mutex::new(connection),
        })
    }

    fn db(&self) -> Result<MutexGuard<'_, Connection>> {
        self.database
            .lock()
            .map_err(|_| AppError::new("AUTO_VAULT_LOCK", "本地加密库正被使用，请重试"))
    }

    fn random<const N: usize>() -> [u8; N] {
        let mut out = [0u8; N];
        OsRng.fill_bytes(&mut out);
        out
    }

    fn cipher(&self) -> Result<Aes256Gcm> {
        Aes256Gcm::new_from_slice(&*self.key).map_err(AppError::internal)
    }

    fn aad(host_id: &str) -> Result<Vec<u8>> {
        uuid::Uuid::parse_str(host_id)
            .map_err(|_| AppError::new("INVALID_HOST", "凭据关联的主机 ID 无效"))?;
        let mut aad = AAD.to_vec();
        aad.extend_from_slice(host_id.as_bytes());
        Ok(aad)
    }

    pub fn count(&self) -> Result<u64> {
        let count: i64 = self
            .db()?
            .query_row("SELECT COUNT(*) FROM auto_secrets", [], |row| row.get(0))?;
        Ok(count.max(0) as u64)
    }
}

impl CredentialVault for AutoVault {
    fn get(&self, id: &str) -> Result<Option<SecretInput>> {
        let aad = Self::aad(id)?;
        let row: Option<(Vec<u8>, Vec<u8>)> = self
            .db()?
            .query_row(
                "SELECT nonce,ciphertext FROM auto_secrets WHERE id=?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let Some((nonce, ciphertext)) = row else {
            return Ok(None);
        };
        if nonce.len() != 12 {
            return Err(AppError::new(
                "AUTO_VAULT_CORRUPT",
                "保存的密码记录格式损坏",
            ));
        }
        let plain = Zeroizing::new(
            self.cipher()?
                .decrypt(
                    Nonce::from_slice(&nonce),
                    Payload {
                        msg: &ciphertext,
                        aad: &aad,
                    },
                )
                .map_err(|_| {
                    AppError::new(
                        "AUTO_VAULT_AUTH_FAILED",
                        "加密记录已损坏或当前密钥不匹配，请检查应用数据备份",
                    )
                })?,
        );
        Ok(Some(serde_json::from_slice(&plain)?))
    }

    fn set(&self, id: &str, secret: &SecretInput) -> Result<()> {
        let aad = Self::aad(id)?;
        let nonce = Self::random::<12>();
        let plain = Zeroizing::new(serde_json::to_vec(secret)?);
        let ciphertext = self
            .cipher()?
            .encrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: &plain,
                    aad: &aad,
                },
            )
            .map_err(|_| AppError::new("AUTO_VAULT_ENCRYPT_FAILED", "本地加密失败"))?;
        self.db()?.execute(
            "INSERT INTO auto_secrets(id,nonce,ciphertext) VALUES(?1,?2,?3)
             ON CONFLICT(id) DO UPDATE SET nonce=excluded.nonce,ciphertext=excluded.ciphertext",
            params![id, &nonce, &ciphertext],
        )?;
        Ok(())
    }

    fn delete(&self, id: &str) -> Result<()> {
        Self::aad(id)?;
        self.db()?
            .execute("DELETE FROM auto_secrets WHERE id=?1", [id])?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stores_only_ciphertext_and_reopens_without_password() {
        let temp = tempfile::tempdir().unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let secret = SecretInput {
            password: Some("server-password-1234".into()),
            passphrase: None,
        };
        {
            let vault = AutoVault::open(temp.path()).unwrap();
            vault.set(&id, &secret).unwrap();
            assert_eq!(vault.count().unwrap(), 1);
            assert_eq!(vault.get(&id).unwrap().unwrap().password, secret.password);
            let ciphertext: Vec<u8> = vault
                .db()
                .unwrap()
                .query_row(
                    "SELECT ciphertext FROM auto_secrets WHERE id=?1",
                    [&id],
                    |r| r.get(0),
                )
                .unwrap();
            assert!(!String::from_utf8_lossy(&ciphertext).contains("server-password"));
        }
        let reopened = AutoVault::open(temp.path()).unwrap();
        assert_eq!(
            reopened.get(&id).unwrap().unwrap().password,
            secret.password
        );
        let second = uuid::Uuid::new_v4().to_string();
        reopened
            .db()
            .unwrap()
            .execute(
                "INSERT INTO auto_secrets(id,nonce,ciphertext)
             SELECT ?1,nonce,ciphertext FROM auto_secrets WHERE id=?2",
                params![second, id],
            )
            .unwrap();
        assert!(reopened.get(&second).is_err());
    }

    #[test]
    fn never_regenerates_a_lost_key_for_existing_ciphertext() {
        let temp = tempfile::tempdir().unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        AutoVault::open(temp.path())
            .unwrap()
            .set(
                &id,
                &SecretInput {
                    password: Some("secret".into()),
                    passphrase: None,
                },
            )
            .unwrap();
        fs::remove_file(temp.path().join(KEY_FILE)).unwrap();
        assert!(AutoVault::open(temp.path()).is_err());
    }
}
