use keyring::Entry;

const SERVICE: &str = "mira-ide";
/// Service historique (marque « Origin »), utilisé UNIQUEMENT pour migrer à la
/// volée les secrets posés par une ancienne version. On n'y écrit jamais.
const LEGACY_SERVICE: &str = "origin-ide";

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
            // Migration à la volée : une version antérieure (marque « Origin »)
            // a pu poser ce secret sous l'ancien service. On le recopie vers le
            // nouveau service (best-effort) pour que l'utilisateur n'ait pas à
            // ressaisir sa clé. `dev_fallback` reste le dernier recours en dev.
            if let Some(secret) = read_legacy(&account) {
                let _ = Entry::new(SERVICE, &account).and_then(|e| e.set_password(&secret));
                return Ok(Some(secret));
            }
            // Fallback dev : si le keychain est vide, on regarde le `.env`
            // (`ORVYX_AI_API_KEY`) pour le provider concerné. No-op en release.
            Ok(dev_fallback(&account))
        }
        Err(e) => Err(e.to_string()),
    }
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

#[tauri::command]
pub fn delete_secret(account: String) -> Result<(), String> {
    let entry = Entry::new(SERVICE, &account).map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(_) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
