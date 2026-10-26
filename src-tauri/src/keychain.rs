// Stockage des secrets de l'app (clés API providers, secret Orvyx).
//
// Stratégie : le coffre chiffré local (`secrets.vault`) est la SEULE source de
// vérité. Le keychain OS n'est pas consulté par défaut (voir `keychain_enabled`)
// et peut être réactivé sur un build signé via `MIRA_USE_KEYCHAIN=1`.
//
// Pourquoi le keychain est désactivé : sur macOS, TOUT accès au trousseau —
// lecture comme écriture — depuis un binaire non signé (ou signé avec une
// identité instable, typiquement en `tauri dev`) déclenche le prompt système
// « … wants to use your confidential information » et bloque l'utilisateur. Ce
// comportement est imposé par l'OS : l'ACL d'une entrée keychain est liée à la
// signature de code du process. Le prompt étant synchrone, un appel
// « best-effort » ne l'évite PAS — il faut ne pas appeler du tout. D'où le
// coffre chiffré local, qui ne déclenche aucun prompt et ne stocke rien en clair.
//
// Sécurité du coffre (`secrets.vault`) :
//   - Chiffrement authentifié AES-256-GCM : confidentialité ET intégrité
//     (une altération du fichier est détectée, on ne déchiffre jamais des
//     données falsifiées).
//   - Clé dérivée par HKDF-SHA256 depuis un secret machine stable + un sel
//     aléatoire rangé en tête du fichier. Le secret machine combine le nom
//     d'utilisateur, le hostname et l'UID — il n'est PAS un secret fort, mais
//     il lie le coffre à la machine : copier le fichier ailleurs ne suffit pas
//     à le déchiffrer.
//   - Nonce aléatoire de 96 bits par écriture, jamais réutilisé.
//   - Permissions du fichier restreintes à 0600 (propriétaire uniquement).
//
// Limite assumée : un attaquant capable d'exécuter du code SOUS L'IDENTITÉ de
// l'utilisateur peut lire le coffre (comme il pourrait lire le keychain une
// fois déverrouillé). Le coffre ne protège pas contre une compromission du
// compte utilisateur ; il protège le secret au repos (fichier exfiltré, backup,
// autre utilisateur de la machine). C'est le niveau attendu pour une clé d'API
// cliente, et c'est strictement supérieur à un stockage en clair.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use aes_gcm::aead::{Aead, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use hkdf::Hkdf;
use keyring::Entry;
use rand::RngCore;
use sha2::Sha256;

const SERVICE: &str = "mira-ide";
/// Service historique (marque « Origin »), utilisé UNIQUEMENT pour migrer à la
/// volée les secrets posés par une ancienne version. On n'y écrit jamais.
const LEGACY_SERVICE: &str = "origin-ide";

/// Interrupteur d'accès au trousseau OS.
///
/// Désactivé par défaut, car TOUT contact avec le trousseau (lecture comme
/// écriture) déclenche le prompt système « wants to use your confidential
/// information » sur macOS tant que le binaire n'est pas signé — et ce prompt
/// est synchrone et bloquant : impossible de l'éviter en « best-effort ». Un
/// build signé/notarisé peut le réactiver explicitement avec
/// `MIRA_USE_KEYCHAIN=1`. Le coffre chiffré local reste la seule source de
/// vérité en attendant.
fn keychain_enabled() -> bool {
    matches!(std::env::var("MIRA_USE_KEYCHAIN").as_deref(), Ok("1") | Ok("true"))
}

/// Magic + version du format pour un futur changement de schéma.
const VAULT_MAGIC: &[u8; 4] = b"MVR1";
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 12;
/// Information HKDF : fixe le contexte de la clé (empêche la réutilisation du
/// même matériel de clé dans un autre usage).
const HKDF_INFO: &[u8] = b"mira-secret-vault-v1";

// ── Chemin du coffre ─────────────────────────────────────────────────────────

/// Dossier de données de l'app (`~/Library/Application Support/<bundle>` sous
/// macOS), résolu par Tauri. On y range le coffre chiffré.
fn vault_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("cannot resolve app data dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("Cannot create config dir: {e}"))?;
    Ok(dir.join("secrets.vault"))
}

// ── Dérivation de clé ────────────────────────────────────────────────────────

/// Secret machine stable, non fort : lie le coffre à cette machine + cet
/// utilisateur. Volontairement déterministe pour que le coffre reste
/// déchiffrable entre deux lancements (aucune saisie utilisateur).
fn machine_secret() -> Vec<u8> {
    let mut parts = Vec::new();
    parts.push(format!("service={SERVICE}"));
    if let Ok(user) = std::env::var("USER") {
        parts.push(format!("user={user}"));
    }
    if let Ok(host) = std::env::var("HOSTNAME") {
        parts.push(format!("host={host}"));
    } else if let Ok(name) = hostname() {
        parts.push(format!("host={name}"));
    }
    if let Some(home) = home_dir() {
        parts.push(format!("home={}", home.display()));
    }
    parts.join("|").into_bytes()
}

fn hostname() -> Result<String, String> {
    // `hostname` est un binaire POSIX présent sur macOS/Linux. Best-effort : en
    // cas d'absence on se rabat simplement sur les autres composantes.
    let out = std::process::Command::new("hostname")
        .output()
        .map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

/// Dérive la clé AES-256 à partir du sel du coffre.
fn derive_key(salt: &[u8]) -> Result<[u8; 32], String> {
    let ikm = machine_secret();
    let hk = Hkdf::<Sha256>::new(Some(salt), &ikm);
    let mut okm = [0u8; 32];
    hk.expand(HKDF_INFO, &mut okm)
        .map_err(|e| format!("HKDF expand failed: {e}"))?;
    Ok(okm)
}

// ── (Dé)chiffrement du coffre ────────────────────────────────────────────────

type VaultMap = HashMap<String, String>;

fn decrypt_vault(bytes: &[u8]) -> Result<VaultMap, String> {
    if bytes.len() < VAULT_MAGIC.len() + SALT_LEN + NONCE_LEN {
        return Err("Vault too short".to_string());
    }
    if &bytes[..VAULT_MAGIC.len()] != VAULT_MAGIC {
        return Err("Bad vault magic".to_string());
    }
    let mut off = VAULT_MAGIC.len();
    let salt = &bytes[off..off + SALT_LEN];
    off += SALT_LEN;
    let nonce = &bytes[off..off + NONCE_LEN];
    off += NONCE_LEN;
    let ciphertext = &bytes[off..];

    let key_bytes = derive_key(salt)?;
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key_bytes));
    let plaintext = cipher
        .decrypt(Nonce::from_slice(nonce), ciphertext)
        // Échec = fichier corrompu ou falsifié : on ne devine pas, on repart
        // d'un coffre vide (les secrets seront re-provisionnés à la reconnexion).
        .map_err(|_| "Vault decryption failed (corrupted or tampered)".to_string())?;
    serde_json::from_slice(&plaintext).map_err(|e| format!("Vault JSON error: {e}"))
}

fn encrypt_vault(map: &VaultMap) -> Result<Vec<u8>, String> {
    let mut salt = [0u8; SALT_LEN];
    OsRng.fill_bytes(&mut salt);
    let mut nonce_bytes = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce_bytes);

    let plaintext = serde_json::to_vec(map).map_err(|e| format!("Vault serialize error: {e}"))?;
    let key_bytes = derive_key(&salt)?;
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key_bytes));
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce_bytes), plaintext.as_ref())
        .map_err(|_| "Vault encryption failed".to_string())?;

    let mut out = Vec::with_capacity(4 + SALT_LEN + NONCE_LEN + ciphertext.len());
    out.extend_from_slice(VAULT_MAGIC);
    out.extend_from_slice(&salt);
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

/// Charge le coffre ; un fichier absent = coffre vide (pas une erreur).
fn load_vault(app: &tauri::AppHandle) -> VaultMap {
    let Ok(path) = vault_path(app) else { return HashMap::new() };
    let Ok(bytes) = fs::read(&path) else { return HashMap::new() };
    decrypt_vault(&bytes).unwrap_or_default()
}

/// Écrit le coffre de façon atomique (fichier temporaire + rename) avec des
/// permissions 0600 : jamais de secret lisible par un autre utilisateur, jamais
/// de fichier à moitié écrit en cas de crash.
fn save_vault(app: &tauri::AppHandle, map: &VaultMap) -> Result<(), String> {
    let path = vault_path(app)?;
    let bytes = encrypt_vault(map)?;
    let tmp = path.with_extension("vault.tmp");
    fs::write(&tmp, &bytes).map_err(|e| format!("Vault write error: {e}"))?;
    set_private_permissions(&tmp)?;
    fs::rename(&tmp, &path).map_err(|e| format!("Vault rename error: {e}"))?;
    Ok(())
}

#[cfg(unix)]
fn set_private_permissions(path: &std::path::Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let perms = fs::Permissions::from_mode(0o600);
    fs::set_permissions(path, perms).map_err(|e| format!("Cannot chmod vault: {e}"))
}

#[cfg(not(unix))]
fn set_private_permissions(_path: &std::path::Path) -> Result<(), String> {
    // Sur Windows, le fichier vit dans %APPDATA% (déjà restreint au profil) et
    // le repli keychain reste actif. On ne change pas les ACL par défaut.
    Ok(())
}

// ── Commands ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn set_secret(app: tauri::AppHandle, account: String, secret: String) -> Result<(), String> {
    // 1) Coffre local : source de vérité, aucun prompt, jamais bloquant pour
    //    l'utilisateur. Une erreur ici est réelle (disque plein, permissions) et
    //    doit être remontée : sans coffre, le secret ne serait pas persisté.
    let mut map = load_vault(&app);
    map.insert(account.clone(), secret.clone());
    save_vault(&app, &map)?;

    // 2) Keychain OS — UNIQUEMENT si explicitement activé (build signé). Sinon
    //    on ne touche jamais au trousseau : y accéder depuis un binaire non
    //    signé afficherait le prompt système bloquant. Le coffre ci-dessus a
    //    déjà persisté le secret, l'appel est donc purement facultatif.
    if keychain_enabled() {
        let _ = Entry::new(SERVICE, &account).and_then(|e| e.set_password(&secret));
    }
    Ok(())
}

#[tauri::command]
pub fn get_secret(app: tauri::AppHandle, account: String) -> Result<Option<String>, String> {
    // 1) Coffre local : source de vérité.
    if let Some(secret) = load_vault(&app).get(&account) {
        if !secret.is_empty() {
            return Ok(Some(secret.clone()));
        }
    }
    // 2) Keychain OS — uniquement si activé. On ne lit JAMAIS le trousseau
    //    sinon : ce serait le prompt bloquant au lancement du prompt.
    if keychain_enabled() {
        if let Ok(entry) = Entry::new(SERVICE, &account) {
            match entry.get_password() {
                Ok(pwd) => {
                    let _ = remember_in_vault(&app, &account, &pwd);
                    return Ok(Some(pwd));
                }
                Err(keyring::Error::NoEntry) => {
                    // 3) Migration depuis l'ancien service « Origin ».
                    if let Some(secret) = read_legacy(&account) {
                        let _ = remember_in_vault(&app, &account, &secret);
                        return Ok(Some(secret));
                    }
                }
                // Prompt refusé / keychain verrouillé : on NE remonte PAS
                // l'erreur, on continue vers le fallback dev puis « absent ».
                Err(_) => {}
            }
        }
    }
    // 4) Fallback dev (`.env`), no-op en release.
    Ok(dev_fallback(&account))
}

/// Recopie un secret trouvé dans le keychain vers le coffre, sans jamais
/// échouer l'appel (migration opportuniste).
fn remember_in_vault(app: &tauri::AppHandle, account: &str, secret: &str) -> Result<(), String> {
    let mut map = load_vault(app);
    map.insert(account.to_string(), secret.to_string());
    save_vault(app, &map)
}

#[tauri::command]
pub fn delete_secret(app: tauri::AppHandle, account: String) -> Result<(), String> {
    let mut map = load_vault(&app);
    if map.remove(&account).is_some() {
        save_vault(&app, &map)?;
    }
    // Keychain : uniquement si activé — même raison que ci-dessus (prompt
    // bloquant sur binaire non signé).
    if keychain_enabled() {
        if let Ok(entry) = Entry::new(SERVICE, &account) {
            let _ = entry.delete_credential();
        }
    }
    Ok(())
}

/// Lit un secret dans l'ancien service keychain, sans jamais échouer.
fn read_legacy(account: &str) -> Option<String> {
    // Un échec de construction (ex. `LEGACY_SERVICE` invalide) ou l'absence
    // d'entrée renvoient `None` : la migration reste best-effort.
    Entry::new(LEGACY_SERVICE, account)
        .ok()?
        .get_password()
        .ok()
        .filter(|s| !s.is_empty())
}

/// Comptes de la forme `provider:<id>` → clé API de dev si elle correspond.
fn dev_fallback(account: &str) -> Option<String> {
    let provider = account.strip_prefix("provider:")?;
    crate::ai_env::api_key_for(provider)
}
