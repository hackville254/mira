use keyring::Entry;

const SERVICE: &str = "origin-ide";

#[tauri::command]
pub fn set_secret(account: String, secret: String) -> Result<(), String> {
    Entry::new(SERVICE, &account)
        .map_err(|e| e.to_string())?
        .set_password(&secret)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_secret(account: String) -> Result<Option<String>, String> {
    let entry = Entry::new(SERVICE, &account).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(pwd) => Ok(Some(pwd)),
        Err(keyring::Error::NoEntry) => {
            // Fallback dev : si le keychain est vide, on regarde le `.env`
            // (`ORVYX_AI_API_KEY`) pour le provider concerné. No-op en release.
            Ok(dev_fallback(&account))
        }
        Err(e) => Err(e.to_string()),
    }
}

/// Comptes de la forme `provider:<id>` → clé API de dev si elle correspond.
fn dev_fallback(account: &str) -> Option<String> {
    let provider = account.strip_prefix("provider:")?;
    crate::ai_env::api_key_for(provider)
}

#[tauri::command]
pub fn delete_secret(account: String) -> Result<(), String> {
    let entry = Entry::new(SERVICE, &account).map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(_) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
