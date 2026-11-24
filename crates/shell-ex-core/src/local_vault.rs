//! Application-local encrypted credential database. Only ciphertext is persisted;
//! the Argon2id-derived key exists in memory until the user locks or quits.
use crate::{
    credentials::CredentialVault,
    error::{AppError, Result},
    models::SecretInput,
};
use aes_gcm::{
    aead::{Aead, Payload},
    Aes256Gcm, KeyInit, Nonce,
};
use argon2::{Algorithm, Argon2, Params, Version};
use rand::{rngs::OsRng, RngCore};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::{
    path::Path,
    sync::{Mutex, MutexGuard},
    time::Duration,
};
use zeroize::Zeroizing;

const PROOF: &[u8] = b"Shell EX local vault v1";
const AAD_PREFIX: &[u8] = b"shell-ex/credential/v1/";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultStatus {
    pub initialized: bool,
    pub unlocked: bool,
    pub count: u64,
}

pub struct LocalVault {
    db: Mutex<Connection>,
    key: Mutex<Option<Zeroizing<[u8; 32]>>>,
}
impl LocalVault {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))?;
            }
        }
        if std::fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_symlink()) {
            return Err(AppError::new(
                "VAULT_INVALID_PATH",
                "凭据库不能使用符号链接",
            ));
        }
        let conn = Connection::open(path)?;
        conn.busy_timeout(Duration::from_secs(5))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
        }
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
          CREATE TABLE IF NOT EXISTS vault_config(
            id INTEGER PRIMARY KEY CHECK(id=1),
            salt BLOB NOT NULL, nonce BLOB NOT NULL, proof BLOB NOT NULL
          );
          CREATE TABLE IF NOT EXISTS local_secrets(
            id TEXT PRIMARY KEY, nonce BLOB NOT NULL, ciphertext BLOB NOT NULL
          );",
        )?;
        Ok(Self {
            db: Mutex::new(conn),
            key: Mutex::new(None),
        })
    }

    fn db(&self) -> Result<MutexGuard<'_, Connection>> {
        self.db
            .lock()
            .map_err(|_| AppError::new("VAULT_STORAGE_LOCK", "本地凭据库繁忙"))
    }
    fn key(&self) -> Result<MutexGuard<'_, Option<Zeroizing<[u8; 32]>>>> {
        self.key
            .lock()
            .map_err(|_| AppError::new("VAULT_KEY_LOCK", "无法访问密码库解锁状态"))
    }
    fn config(&self) -> Result<Option<(Vec<u8>, Vec<u8>, Vec<u8>)>> {
        self.db()?
            .query_row(
                "SELECT salt,nonce,proof FROM vault_config WHERE id=1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()
            .map_err(Into::into)
    }
    fn derive(passphrase: &str, salt: &[u8]) -> Result<Zeroizing<[u8; 32]>> {
        if passphrase.len() > 4096 {
            return Err(AppError::new(
                "VAULT_PASSWORD_INVALID",
                "主密码长度超出限制",
            ));
        }
        let params = Params::new(65536, 3, 1, Some(32)).map_err(AppError::internal)?;
        let mut key = Zeroizing::new([0u8; 32]);
        Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
            .hash_password_into(passphrase.as_bytes(), salt, &mut *key)
            .map_err(AppError::internal)?;
        Ok(key)
    }
    fn cipher(key: &[u8; 32]) -> Result<Aes256Gcm> {
        Aes256Gcm::new_from_slice(key).map_err(AppError::internal)
    }
    fn random<const N: usize>() -> [u8; N] {
        let mut bytes = [0u8; N];
        OsRng.fill_bytes(&mut bytes);
        bytes
    }
    fn check_id(id: &str) -> Result<()> {
        uuid::Uuid::parse_str(id)
            .map_err(|_| AppError::new("INVALID_HOST", "无效的主机凭据标识"))?;
        Ok(())
    }
    fn associated_data(id: &str) -> Vec<u8> {
        let mut aad = AAD_PREFIX.to_vec();
        aad.extend_from_slice(id.as_bytes());
        aad
    }
    pub fn status(&self) -> Result<VaultStatus> {
        let count = self
            .db()?
            .query_row("SELECT COUNT(*) FROM local_secrets", [], |r| {
                r.get::<_, u64>(0)
            })?;
        Ok(VaultStatus {
            initialized: self.config()?.is_some(),
            unlocked: self.key()?.is_some(),
            count,
        })
    }
    pub fn initialize(&self, passphrase: &str) -> Result<()> {
        if passphrase.chars().count() < 12 || passphrase.len() > 4096 {
            return Err(AppError::new(
                "WEAK_VAULT_PASSWORD",
                "主密码至少需要 12 个字符",
            ));
        }
        let mut db = self.db()?;
        if db.query_row(
            "SELECT EXISTS(SELECT 1 FROM vault_config WHERE id=1)",
            [],
            |r| r.get::<_, i32>(0),
        )? != 0
        {
            return Err(AppError::new(
                "VAULT_ALREADY_INITIALIZED",
                "密码库已初始化，请输入原主密码解锁",
            ));
        }
        let salt = Self::random::<16>();
        let nonce = Self::random::<12>();
        let key = Self::derive(passphrase, &salt)?;
        let proof = Self::cipher(&key)?
            .encrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: PROOF,
                    aad: b"shell-ex/vault-proof/v1",
                },
            )
            .map_err(|_| AppError::new("VAULT_ENCRYPT_FAILED", "初始化密码库失败"))?;
        db.execute(
            "INSERT INTO vault_config(id,salt,nonce,proof) VALUES(1,?1,?2,?3)",
            params![&salt, &nonce, &proof],
        )?;
        drop(db);
        *self.key()? = Some(key);
        Ok(())
    }
    pub fn unlock(&self, passphrase: &str) -> Result<()> {
        let (salt, nonce, proof) = self
            .config()?
            .ok_or_else(|| AppError::new("VAULT_NOT_INITIALIZED", "请先设置本地密码库主密码"))?;
        if salt.len() != 16 || nonce.len() != 12 {
            return Err(AppError::new("VAULT_CORRUPT", "密码库元数据损坏"));
        }
        let key = Self::derive(passphrase, &salt)?;
        let opened = Self::cipher(&key)?.decrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &proof,
                aad: b"shell-ex/vault-proof/v1",
            },
        );
        if !matches!(opened, Ok(ref bytes) if bytes == PROOF) {
            return Err(AppError::new(
                "VAULT_AUTH_FAILED",
                "主密码错误或密码库已损坏",
            ));
        }
        *self.key()? = Some(key);
        Ok(())
    }
    pub fn lock(&self) -> Result<()> {
        *self.key()? = None;
        Ok(())
    }
    pub fn has(&self, id: &str) -> Result<bool> {
        Self::check_id(id)?;
        Ok(self.db()?.query_row(
            "SELECT EXISTS(SELECT 1 FROM local_secrets WHERE id=?1)",
            [id],
            |r| r.get::<_, i32>(0),
        )? != 0)
    }
    pub fn change_password(&self, old: &str, new: &str) -> Result<()> {
        if new.chars().count() < 12 || new.len() > 4096 {
            return Err(AppError::new(
                "WEAK_VAULT_PASSWORD",
                "新主密码至少需要 12 个字符",
            ));
        }
        // Validate old passphrase, even if the vault was previously unlocked.
        self.unlock(old)?;
        let old_key = self
            .key()?
            .as_ref()
            .ok_or_else(|| AppError::new("VAULT_LOCKED", "请先解锁密码库"))?
            .clone();
        let new_salt = Self::random::<16>();
        let new_key = Self::derive(new, &new_salt)?;
        let new_nonce = Self::random::<12>();
        let new_proof = Self::cipher(&new_key)?
            .encrypt(
                Nonce::from_slice(&new_nonce),
                Payload {
                    msg: PROOF,
                    aad: b"shell-ex/vault-proof/v1",
                },
            )
            .map_err(|_| AppError::new("VAULT_ENCRYPT_FAILED", "无法加密新密码库验证记录"))?;
        let mut db = self.db()?;
        let rows: Vec<(String, Vec<u8>, Vec<u8>)> = {
            let mut stmt = db.prepare("SELECT id,nonce,ciphertext FROM local_secrets")?;
            let it = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
            it.collect::<std::result::Result<_, _>>()?
        };
        let tx = db.transaction()?;
        for (id, old_nonce, ciphertext) in rows {
            if old_nonce.len() != 12 {
                return Err(AppError::new("VAULT_CORRUPT", "加密记录格式损坏"));
            }
            let aad = Self::associated_data(&id);
            let plain = Zeroizing::new(
                Self::cipher(&old_key)?
                    .decrypt(
                        Nonce::from_slice(&old_nonce),
                        Payload {
                            msg: &ciphertext,
                            aad: &aad,
                        },
                    )
                    .map_err(|_| {
                        AppError::new("VAULT_AUTH_FAILED", "原凭据密文校验失败，未更改主密码")
                    })?,
            );
            let nonce = Self::random::<12>();
            let sealed = Self::cipher(&new_key)?
                .encrypt(
                    Nonce::from_slice(&nonce),
                    Payload {
                        msg: &plain,
                        aad: &aad,
                    },
                )
                .map_err(|_| AppError::new("VAULT_ENCRYPT_FAILED", "凭据重新加密失败"))?;
            tx.execute(
                "UPDATE local_secrets SET nonce=?2,ciphertext=?3 WHERE id=?1",
                params![id, &nonce, &sealed],
            )?;
        }
        tx.execute(
            "UPDATE vault_config SET salt=?1,nonce=?2,proof=?3 WHERE id=1",
            params![&new_salt, &new_nonce, &new_proof],
        )?;
        tx.commit()?;
        drop(db);
        *self.key()? = Some(new_key);
        Ok(())
    }
}
impl CredentialVault for LocalVault {
    fn get(&self, id: &str) -> Result<Option<SecretInput>> {
        Self::check_id(id)?;
        let row: Option<(Vec<u8>, Vec<u8>)> = self
            .db()?
            .query_row(
                "SELECT nonce,ciphertext FROM local_secrets WHERE id=?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let Some((nonce, ciphertext)) = row else {
            return Ok(None);
        };
        if nonce.len() != 12 {
            return Err(AppError::new("VAULT_CORRUPT", "本地凭据密文格式错误"));
        }
        let key = self.key()?;
        let key = key
            .as_ref()
            .ok_or_else(|| AppError::new("VAULT_LOCKED", "本地密码库已锁定，请输入主密码解锁"))?;
        let aad = Self::associated_data(id);
        let plain = Zeroizing::new(
            Self::cipher(key)?
                .decrypt(
                    Nonce::from_slice(&nonce),
                    Payload {
                        msg: &ciphertext,
                        aad: &aad,
                    },
                )
                .map_err(|_| {
                    AppError::new("VAULT_AUTH_FAILED", "保存的凭据验证失败，可能被修改")
                })?,
        );
        serde_json::from_slice(&plain).map(Some).map_err(Into::into)
    }
    fn set(&self, id: &str, secret: &SecretInput) -> Result<()> {
        Self::check_id(id)?;
        let key = self.key()?;
        let key = key
            .as_ref()
            .ok_or_else(|| AppError::new("VAULT_LOCKED", "请先设置或解锁本地密码库主密码"))?;
        let nonce = Self::random::<12>();
        let plain = Zeroizing::new(serde_json::to_vec(secret)?);
        let aad = Self::associated_data(id);
        let sealed = Self::cipher(key)?
            .encrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: &plain,
                    aad: &aad,
                },
            )
            .map_err(|_| AppError::new("VAULT_ENCRYPT_FAILED", "本地密码库写入失败"))?;
        self.db()?.execute(
            "INSERT INTO local_secrets(id,nonce,ciphertext) VALUES(?1,?2,?3)
            ON CONFLICT(id) DO UPDATE SET nonce=excluded.nonce,ciphertext=excluded.ciphertext",
            params![id, &nonce, &sealed],
        )?;
        Ok(())
    }
    fn delete(&self, id: &str) -> Result<()> {
        Self::check_id(id)?;
        self.db()?
            .execute("DELETE FROM local_secrets WHERE id=?1", [id])?;
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn encrypted_vault_requires_master_password_and_detects_tampering() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("credentials.sqlite3");
        let id = uuid::Uuid::new_v4().to_string();
        let id2 = uuid::Uuid::new_v4().to_string();
        let vault = LocalVault::open(&path).unwrap();
        assert!(!vault.status().unwrap().initialized);
        assert!(vault.initialize("short").is_err());
        vault.initialize("my very strong master password").unwrap();
        let secret = SecretInput {
            password: Some("production-password".into()),
            passphrase: None,
        };
        vault.set(&id, &secret).unwrap();
        let row: Vec<u8> = vault
            .db()
            .unwrap()
            .query_row(
                "SELECT ciphertext FROM local_secrets WHERE id=?1",
                [&id],
                |r| r.get(0),
            )
            .unwrap();
        assert!(!String::from_utf8_lossy(&row).contains("production-password"));
        vault.lock().unwrap();
        assert!(vault.get(&id).is_err());
        assert!(vault.unlock("wrong password 1234").is_err());
        vault.unlock("my very strong master password").unwrap();
        assert_eq!(
            vault.get(&id).unwrap().unwrap().password.as_deref(),
            Some("production-password")
        );
        vault.db().unwrap().execute("INSERT INTO local_secrets(id,nonce,ciphertext) SELECT ?1,nonce,ciphertext FROM local_secrets WHERE id=?2",
            params![id2, id]).unwrap();
        assert!(vault.get(&id2).is_err());
        vault
            .change_password(
                "my very strong master password",
                "another strong master passphrase",
            )
            .unwrap_err();
        // Corrupt copied record is detected: never silently skip it during key rotation.
        vault.delete(&id2).unwrap();
        vault
            .change_password(
                "my very strong master password",
                "another strong master passphrase",
            )
            .unwrap();
        vault.lock().unwrap();
        assert!(vault.unlock("my very strong master password").is_err());
        vault.unlock("another strong master passphrase").unwrap();
        assert_eq!(
            vault.get(&id).unwrap().unwrap().password.as_deref(),
            Some("production-password")
        );
        drop(vault);
        let reopened = LocalVault::open(&path).unwrap();
        assert!(!reopened.status().unwrap().unlocked);
        reopened.unlock("another strong master passphrase").unwrap();
        assert_eq!(
            reopened.get(&id).unwrap().unwrap().password.as_deref(),
            Some("production-password")
        );
    }
}
