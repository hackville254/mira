// Configuration AI de DÉVELOPPEMENT via un fichier `.env`.
//
// Objectif : pouvoir tester l'agent sans passer par l'UI (Settings > AI) ni
// saisir la clé à la main. Ce module est un FALLBACK : les valeurs de l'UI
// (keychain OS + localStorage) restent prioritaires.
//
// Sécurité :
//   - Le `.env` n'est lu QUE en build debug (`#[cfg(debug_assertions)]`).
//     En release, `load_dotenv_into_env` est un no-op → aucune valeur n'est
//     injectée, donc rien ne peut fuiter dans un binaire distribué.
//   - La clé n'est JAMAIS renvoyée au front sous forme bundlée : elle reste
//     côté Rust et n'est exposée qu'à la demande, via le même canal que le
//     keychain (`get_secret`).
//   - Parseur volontairement minimal (KEY=VALUE), sans shell, sans expansion
//     de variables, sans exécution : un `.env` hostile ne peut rien exécuter.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Variables reconnues. Toute variable hors de ces clés est ignorée.
const KEY_PROVIDER: &str = "ORVYX_AI_PROVIDER";
const KEY_MODEL: &str = "ORVYX_AI_MODEL";
const KEY_API_KEY: &str = "ORVYX_AI_API_KEY";
const KEY_BASE_URL: &str = "ORVYX_AI_BASE_URL";
const KEY_ALLOWED_MODELS: &str = "ORVYX_ALLOWED_MODELS";
/// URL du plan de contrôle Mira (locale pour tester, ou en ligne
/// `https://api.miracoder.com`). C'est la SOURCE de vérité : `cloud.rs` la lit
/// en priorité et ne retombe sur sa constante qu'en release, où le `.env`
/// n'est pas lu (build debug uniquement).
const KEY_DASHBOARD_URL: &str = "MIRA_DASHBOARD_URL";

/// Configuration AI de dev, telle que lue depuis l'environnement.
#[derive(serde::Serialize)]
pub struct DevAiConfig {
    pub provider: Option<String>,
    pub model: Option<String>,
    pub api_key: Option<String>,
    pub base_url: Option<String>,
    /// Liste ordonnée de modèles autorisés (cascade en cas de rate-limit).
    /// Chaîne brute séparée par des virgules ; le front la découpe et la
    /// déduplique. `None` si non définie.
    pub allowed_models: Option<String>,
    /// URL du plan de contrôle Mira, définie par `MIRA_DASHBOARD_URL`. `None`
    /// si la variable est absente (release) : `cloud.rs` applique alors son
    /// URL de repli.
    pub dashboard_url: Option<String>,
    /// Vrai si au moins une des clés reconnues est présente.
    pub configured: bool,
}

/// Parse un contenu `.env` en paires clé/valeur.
///
/// Règles (volontairement simples et sûres) :
///   - une ligne vide ou commençant par `#` est ignorée ;
///   - `export FOO=bar` est accepté (le préfixe `export` est retiré) ;
///   - la valeur peut être entourée de guillemets simples ou doubles ;
///   - aucune interpolation `${...}`, aucune exécution, aucun échappement.
fn parse_dotenv(content: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for raw in content.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").unwrap_or(line);
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        if key.is_empty() {
            continue;
        }
        let mut value = value.trim().to_string();
        // Retire une paire de guillemets encadrants (simple ou double).
        if value.len() >= 2 {
            let bytes = value.as_bytes();
            let quoted = (bytes[0] == b'"' && bytes[value.len() - 1] == b'"')
                || (bytes[0] == b'\'' && bytes[value.len() - 1] == b'\'');
            if quoted {
                value = value[1..value.len() - 1].to_string();
            }
        }
        map.insert(key.to_string(), value);
    }
    map
}

/// Cherche le `.env` : d'abord à la racine du projet (à côté de `src-tauri`),
/// puis dans le répertoire courant et ses parents (le cwd de `tauri dev` est
/// celui du package, pas celui de la crate).
fn locate_dotenv() -> Option<PathBuf> {
    // 1. Racine du projet dérivée de la crate (compile-time).
    let manifest_root = Path::new(env!("CARGO_MANIFEST_DIR"));
    if let Some(project_root) = manifest_root.parent() {
        let candidate = project_root.join(".env");
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    // 2. Remontée depuis le cwd.
    let mut dir = std::env::current_dir().ok()?;
    loop {
        let candidate = dir.join(".env");
        if candidate.is_file() {
            return Some(candidate);
        }
        if !dir.pop() {
            break;
        }
    }
    None
}

/// Charge le `.env` dans l'environnement du process. No-op en release.
///
/// On n'écrase JAMAIS une variable déjà définie : l'environnement réel
/// (CI, shell de l'utilisateur) garde la priorité sur le fichier.
#[cfg(debug_assertions)]
pub fn load_dotenv_into_env() {
    let Some(path) = locate_dotenv() else {
        return;
    };
    let Ok(content) = std::fs::read_to_string(&path) else {
        return;
    };
    for (key, value) in parse_dotenv(&content) {
        if std::env::var_os(&key).is_none() {
            std::env::set_var(key, value);
        }
    }
}

/// No-op en release : on ne charge jamais de `.env` dans un binaire livré.
#[cfg(not(debug_assertions))]
pub fn load_dotenv_into_env() {}

fn get(key: &str) -> Option<String> {
    match std::env::var(key) {
        Ok(v) if !v.trim().is_empty() => Some(v),
        _ => None,
    }
}

/// Clé API de dev pour un provider donné, si elle est définie dans l'env.
///
/// Sert de fallback au keychain : `get_secret` l'utilise quand aucune clé n'a
/// été saisie dans l'UI. On ne renvoie la clé que pour le provider courant
/// (`ORVYX_AI_PROVIDER`) afin qu'un `.env` configuré pour Anthropic ne fuite
/// pas sa clé si l'UI bascule sur un autre provider.
pub fn api_key_for(provider: &str) -> Option<String> {
    let configured = get(KEY_PROVIDER)?;
    if configured != provider {
        return None;
    }
    get(KEY_API_KEY)
}

/// Provider par défaut défini dans le `.env`, s'il y en a un.
pub fn default_provider() -> Option<String> {
    get(KEY_PROVIDER)
}

/// Modèle par défaut défini dans le `.env`, s'il y en a un.
pub fn default_model() -> Option<String> {
    get(KEY_MODEL)
}

/// Base URL personnalisée définie dans le `.env`, s'il y en a une.
pub fn default_base_url() -> Option<String> {
    get(KEY_BASE_URL)
}

/// Liste ordonnée de modèles autorisés définie dans le `.env`, s'il y en a une.
///
/// Chaîne brute (`a,b,c`) : le front la découpe et la déduplique via
/// `parseAllowedModels`. On ne valide pas les identifiants ici (côté Rust on ne
/// connaît pas le catalogue de modèles) — la validation d'usage est faite côté
/// front, qui ne bascule que vers un modèle réellement constructible.
pub fn default_allowed_models() -> Option<String> {
    get(KEY_ALLOWED_MODELS)
}

/// URL du plan de contrôle Mira définie dans le `.env` de dev, s'il y en a une.
pub fn default_dashboard_url() -> Option<String> {
    get(KEY_DASHBOARD_URL)
}

/// Renvoie la config AI de dev complète. Exposée au front pour préremplir les
/// champs quand ni le keychain ni le localStorage n'ont de valeur.
#[tauri::command]
pub fn dev_ai_config() -> DevAiConfig {
    let provider = default_provider();
    let model = default_model();
    let base_url = default_base_url();
    let allowed_models = default_allowed_models();
    let dashboard_url = default_dashboard_url();
    // La clé n'est renvoyée que si elle correspond au provider configuré.
    let api_key = provider.as_deref().and_then(api_key_for);
    DevAiConfig {
        configured: provider.is_some() || api_key.is_some(),
        provider,
        model,
        api_key,
        base_url,
        allowed_models,
        dashboard_url,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_simple_pairs() {
        let map = parse_dotenv("ORVYX_AI_PROVIDER=anthropic\nORVYX_AI_MODEL=claude-sonnet-4-5");
        assert_eq!(map.get("ORVYX_AI_PROVIDER").unwrap(), "anthropic");
        assert_eq!(map.get("ORVYX_AI_MODEL").unwrap(), "claude-sonnet-4-5");
    }

    #[test]
    fn ignores_comments_and_blanks() {
        let map = parse_dotenv("# comment\n\n   \nORVYX_AI_MODEL=x");
        assert_eq!(map.len(), 1);
        assert_eq!(map.get("ORVYX_AI_MODEL").unwrap(), "x");
    }

    #[test]
    fn strips_export_prefix_and_quotes() {
        let map = parse_dotenv("export ORVYX_AI_API_KEY=\"sk-ant-123\"");
        assert_eq!(map.get("ORVYX_AI_API_KEY").unwrap(), "sk-ant-123");
    }

    #[test]
    fn strips_single_quotes() {
        let map = parse_dotenv("ORVYX_AI_API_KEY='sk-abc'");
        assert_eq!(map.get("ORVYX_AI_API_KEY").unwrap(), "sk-abc");
    }

    #[test]
    fn preserves_equals_in_value() {
        let map = parse_dotenv("ORVYX_AI_BASE_URL=http://x/v1?a=b");
        assert_eq!(map.get("ORVYX_AI_BASE_URL").unwrap(), "http://x/v1?a=b");
    }

    #[test]
    fn skips_lines_without_equals() {
        let map = parse_dotenv("JUST_A_WORD\nORVYX_AI_MODEL=y");
        assert_eq!(map.len(), 1);
        assert_eq!(map.get("ORVYX_AI_MODEL").unwrap(), "y");
    }

    #[test]
    fn no_expansion_is_performed() {
        // Volontaire : on ne fait AUCUNE interpolation, un `.env` hostile ne
        // peut pas extraire d'autres variables de l'environnement.
        let map = parse_dotenv("ORVYX_AI_API_KEY=${HOME}");
        assert_eq!(map.get("ORVYX_AI_API_KEY").unwrap(), "${HOME}");
    }
}
