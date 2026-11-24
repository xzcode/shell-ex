//! Versioned authenticated backups. Parameters are fixed, preventing hostile KDF resource requests.
use crate::{
    credentials::CredentialVault,
    error::{AppError, Result},
    models::*,
    storage::Storage,
};
use aes_gcm::{
    aead::{Aead, Payload},
    Aes256Gcm, KeyInit, Nonce,
};
use argon2::{Algorithm, Argon2, Params, Version};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    io::{Read, Write},
    path::Path,
};
use zeroize::Zeroizing;

const MAGIC: &[u8; 8] = b"SHEX\0\x01\r\n";
const MAX_SIZE: u64 = 32 * 1024 * 1024;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupData {
    pub version: u32,
    pub hosts: Vec<Host>,
    pub snippets: Vec<Snippet>,
    pub settings: AppSettings,
    pub workspace: Workspace,
    #[serde(default)]
    pub credentials: HashMap<String, SecretInput>,
}
#[derive(Serialize)]
pub struct ImportSummary {
    pub hosts: usize,
}

fn derive(passphrase: &str, salt: &[u8]) -> Result<Zeroizing<[u8; 32]>> {
    let mut key = Zeroizing::new([0u8; 32]);
    let params = Params::new(65536, 3, 1, Some(32)).map_err(AppError::internal)?;
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(passphrase.as_bytes(), salt, &mut *key)
        .map_err(AppError::internal)?;
    Ok(key)
}
fn seal(data: &BackupData, passphrase: &str) -> Result<Vec<u8>> {
    if passphrase.chars().count() < 12 || passphrase.len() > 4096 {
        return Err(AppError::new("WEAK_PASSPHRASE", "备份口令至少 12 个字符"));
    }
    let mut salt = [0u8; 16];
    let mut nonce = [0u8; 12];
    OsRng.fill_bytes(&mut salt);
    OsRng.fill_bytes(&mut nonce);
    let key = derive(passphrase, &salt)?;
    let plaintext = Zeroizing::new(serde_json::to_vec(data)?);
    if plaintext.len() as u64 > MAX_SIZE - 64 {
        return Err(AppError::new("BACKUP_TOO_LARGE", "备份超过 32 MiB 限制"));
    }
    let mut header = MAGIC.to_vec();
    header.extend_from_slice(&salt);
    header.extend_from_slice(&nonce);
    let cipher = Aes256Gcm::new_from_slice(&*key).map_err(AppError::internal)?;
    let encrypted = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &plaintext,
                aad: &header,
            },
        )
        .map_err(|_| AppError::new("ENCRYPTION_FAILED", "备份加密失败"))?;
    header.extend_from_slice(&encrypted);
    Ok(header)
}
fn unseal(bytes: &[u8], passphrase: &str) -> Result<BackupData> {
    if bytes.len() < 52
        || bytes.len() as u64 > MAX_SIZE
        || &bytes[..8] != MAGIC
        || passphrase.len() > 4096
    {
        return Err(AppError::new(
            "INVALID_BACKUP",
            "不是支持的 Shell EX 加密备份",
        ));
    }
    let key = derive(passphrase, &bytes[8..24])?;
    let cipher = Aes256Gcm::new_from_slice(&*key).map_err(AppError::internal)?;
    let plaintext = Zeroizing::new(
        cipher
            .decrypt(
                Nonce::from_slice(&bytes[24..36]),
                Payload {
                    msg: &bytes[36..],
                    aad: &bytes[..36],
                },
            )
            .map_err(|_| AppError::new("BACKUP_AUTH_FAILED", "备份口令错误或文件已损坏"))?,
    );
    let data: BackupData = serde_json::from_slice(&plaintext)?;
    if data.version != 1 || data.hosts.len() > 10000 || data.snippets.len() > 10000 {
        return Err(AppError::new(
            "BACKUP_VERSION",
            "备份版本或记录数量不受支持",
        ));
    }
    Ok(data)
}
pub fn export(
    store: &Storage,
    vault: &dyn CredentialVault,
    path: &Path,
    passphrase: &str,
    include_credentials: bool,
) -> Result<()> {
    let hosts = store.hosts()?;
    let mut credentials = HashMap::new();
    if include_credentials {
        for h in &hosts {
            if let Some(secret) = vault.get(&h.id)? {
                credentials.insert(h.id.clone(), secret);
            }
        }
    }
    let data = BackupData {
        version: 1,
        hosts,
        snippets: store.snippets()?,
        settings: store.settings()?,
        workspace: store.preference("workspace")?,
        credentials,
    };
    let encrypted = seal(&data, passphrase)?;
    // create_new prevents a stale save-dialog decision from destroying a file created meanwhile.
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut file = opts.open(path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::AlreadyExists {
            AppError::new("FILE_EXISTS", "备份文件已存在，请选择新文件名")
        } else {
            e.into()
        }
    })?;
    let result = (|| -> std::io::Result<()> {
        file.write_all(&encrypted)?;
        file.sync_all()
    })()
    .map_err(AppError::from);
    if result.is_err() {
        drop(file);
        let _ = std::fs::remove_file(path);
    }
    result
}
pub fn import(
    store: &Storage,
    vault: &dyn CredentialVault,
    path: &Path,
    passphrase: &str,
) -> Result<ImportSummary> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let file = options.open(path)?;
    let meta = file.metadata()?;
    if !meta.is_file() || meta.len() > MAX_SIZE {
        return Err(AppError::new(
            "INVALID_BACKUP",
            "请选择不超过 32 MiB 的普通备份文件",
        ));
    }
    let mut bytes = Vec::new();
    file.take(MAX_SIZE + 1).read_to_end(&mut bytes)?;
    let data = unseal(&bytes, passphrase)?;
    let ids: std::collections::HashSet<&str> = data.hosts.iter().map(|h| h.id.as_str()).collect();
    if ids.len() != data.hosts.len() || data.credentials.keys().any(|id| !ids.contains(id.as_str()))
    {
        return Err(AppError::new(
            "INVALID_BACKUP",
            "备份包含重复主机或不匹配的凭据",
        ));
    }
    // Complete schema/topology validation before the first credential-store mutation.
    store.validate_import(&data.hosts, &data.snippets, &data.settings, &data.workspace)?;
    // Resolve the TARGET location from the imported host rather than the old
    // local host record. This keeps restored credentials in the intended vault.
    let mut previous: Vec<(Host, Option<SecretInput>)> = Vec::new();
    for host in &data.hosts {
        if data.credentials.contains_key(&host.id) {
            previous.push((host.clone(), vault.get_for_host(host)?));
        }
    }
    for (index, (host, _)) in previous.iter().enumerate() {
        if let Err(error) = vault.set_for_host(host, &data.credentials[&host.id]) {
            return Err(restore_error(vault, &previous[..=index], error));
        }
    }
    if let Err(error) =
        store.import_configuration(&data.hosts, &data.snippets, &data.settings, &data.workspace)
    {
        return Err(restore_error(vault, &previous, error));
    }
    Ok(ImportSummary {
        hosts: data.hosts.len(),
    })
}
fn restore_error(
    vault: &dyn CredentialVault,
    previous: &[(Host, Option<SecretInput>)],
    original: AppError,
) -> AppError {
    let mut failed = 0;
    for (host, old) in previous.iter().rev() {
        let result = match old {
            Some(secret) => vault.set_for_host(host, secret),
            None => vault.delete_for_host(host),
        };
        if result.is_err() {
            failed += 1;
        }
    }
    if failed == 0 {
        original
    } else {
        AppError::new("BACKUP_ROLLBACK_FAILED",format!("导入失败（{}），且 {failed} 项凭据未能恢复。配置未导入；请解锁对应的密码库并使用备份重新恢复。",original.code))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn backup_requires_password_and_authenticates_metadata_and_ciphertext() {
        let data = BackupData {
            version: 1,
            hosts: vec![],
            snippets: vec![],
            settings: AppSettings::default(),
            workspace: Workspace::default(),
            credentials: HashMap::new(),
        };
        assert!(seal(&data, "short").is_err());
        let mut encrypted = seal(&data, "correct horse battery").unwrap();
        assert_eq!(
            unseal(&encrypted, "correct horse battery").unwrap().version,
            1
        );
        assert!(unseal(&encrypted, "wrong password here").is_err());
        encrypted[40] ^= 1;
        assert!(unseal(&encrypted, "correct horse battery").is_err());
        encrypted[0] ^= 1;
        assert!(unseal(&encrypted, "correct horse battery").is_err());
    }
}
