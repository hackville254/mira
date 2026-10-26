// Plan de contrôle Mira : connexion du poste à un compte (device flow OAuth 2.0)
// et provision de la clé Orvyx associée.
//
// Rôle : en RELEASE, c'est la SEULE source de la clé et du catalogue Mira. Le
// `.env` (`ai_env.rs`) n'existe qu'en debug. Le dashboard ne voit passer aucune
// requête d'inférence : il fournit la clé une fois, le poste appelle ensuite
// Orvyx directement.
//
// Sécurité :
//   - L'URL du dashboard n'est jamais fournie par l'utilisateur → pas de SSRF.
//   - Le secret Orvyx est stocké dans le keychain OS (compte `provider:orvyx`),
//     jamais sur disque en clair, jamais journalisé.
//   - `cloud_state` ne renvoie au front que des métadonnées non sensibles
//     (email, plan, empreinte de clé) : le token d'accès et le secret ne
//     repassent jamais par la couche UI.
//   - Toutes les réponses sont bornées en taille pour éviter qu'un contrôle
//     distant compromis ne fasse exploser la mémoire du poste.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::json;

/// URL de repli du plan de contrôle si `MIRA_DASHBOARD_URL` n'est pas définie.
///
/// Ce n'est PAS le chemin nominal : la source de vérité est la variable
/// `MIRA_DASHBOARD_URL` du `.env` (voir `ai_env.rs`), exactement comme les
/// autres réglages Mira. Cette constante n'est qu'un filet de sécurité pour la
/// release, où le `.env` n'existe pas (il n'est lu qu'en build debug). Y mettre
/// un domaine vide/en placeholder fait échouer proprement plutôt que de viser
/// silencieusement un serveur inattendu.
const FALLBACK_DASHBOARD_URL: &str = "https://api.miracoder.com";

/// Bornes de sûreté : une réponse du plan de contrôle est petite par nature.
const MAX_RESPONSE_BYTES: usize = 256 * 1024;
const REQUEST_TIMEOUT_SECONDS: u64 = 20;

/// Base URL du plan de contrôle.
///
/// Source de vérité : `MIRA_DASHBOARD_URL`, définie dans le `.env` et exposée
/// par `ai_env::default_dashboard_url()`. En release (`.env` absent), on
/// retombe sur `FALLBACK_DASHBOARD_URL` pour que le binaire reste fonctionnel
/// sans configuration externe.
fn dashboard_url() -> String {
    if let Some(v) = crate::ai_env::default_dashboard_url() {
        let trimmed = v.trim().trim_end_matches('/');
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    FALLBACK_DASHBOARD_URL.to_string()
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECONDS))
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))
}

/// Lit le corps d'une réponse en bornant la taille (anti-DoS mémoire).
async fn read_bounded(resp: reqwest::Response) -> Result<String, String> {
    let status = resp.status();
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("Response read error: {e}"))?;
    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err("Response too large from control plane".to_string());
    }
    let body = String::from_utf8_lossy(&bytes).to_string();
    if !status.is_success() {
        // On ne remonte pas le corps distant tel quel (il pourrait contenir des
        // détails internes) : seulement le code HTTP.
        return Err(format!("Control plane returned HTTP {}", status.as_u16()));
    }
    Ok(body)
}

// ── Device flow ──────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct DeviceStart {
    pub user_code: String,
    pub verification_uri: String,
    pub verification_uri_complete: String,
    pub expires_in: i64,
    pub interval: i64,
    /// Secret gardé côté Rust ; le front n'a besoin que du `user_code`.
    #[serde(skip)]
    device_code: String,
}

#[derive(Debug, Deserialize)]
struct DeviceStartWire {
    device_code: String,
    user_code: String,
    verification_uri: String,
    verification_uri_complete: String,
    expires_in: i64,
    interval: i64,
}

/// Démarre un device flow. Le `device_code` reste côté Rust (dans `CloudState`)
/// pour que l'UI ne puisse pas le manipuler.
#[tauri::command]
pub async fn cloud_device_start(
    state: tauri::State<'_, CloudState>,
    client_label: Option<String>,
) -> Result<DeviceStart, String> {
    let url = format!("{}/api/v1/device/start", dashboard_url());
    let resp = http_client()?
        .post(&url)
        .json(&json!({ "client_label": client_label, "launch": true }))
        .send()
        .await
        .map_err(|e| format!("Cannot reach Mira cloud: {e}"))?;
    let wire: DeviceStartWire = serde_json::from_str(&read_bounded(resp).await?)
        .map_err(|e| format!("Malformed device/start response: {e}"))?;

    let start = DeviceStart {
        user_code: wire.user_code,
        verification_uri: wire.verification_uri,
        verification_uri_complete: wire.verification_uri_complete,
        expires_in: wire.expires_in,
        interval: wire.interval,
        device_code: wire.device_code,
    };
    *state.device_code.lock().await = Some(start.device_code.clone());
    Ok(start)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PollOutcome {
    /// Toujours en attente : l'appelant doit respecter `interval` et réessayer.
    Pending { interval: i64 },
    /// Approuvé : les jetons ont été stockés côté Rust, le front n'y a pas accès.
    /// On remonte seulement l'identité non sensible du compte (affichage).
    Approved {
        email: Option<String>,
        plan: Option<String>,
        /// Budget mensuel courant (USD), crédit offert inclus. Permet au front
        /// d'afficher « $1 monthly budget » dès l'approbation, sans appel de
        /// provisioning supplémentaire.
        budget_usd: Option<f64>,
    },
    Denied,
    Expired,
}

#[derive(Debug, Deserialize)]
struct DevicePollWire {
    status: String,
    access_token: Option<String>,
    refresh_token: Option<String>,
    interval: Option<i64>,
    /// Secret Orvyx livré UNE SEULE FOIS à l'approbation (jamais rejouable :
    /// le code est consommé côté serveur). Rangé aussitôt dans le keychain OS.
    key_secret: Option<String>,
    key_fingerprint: Option<String>,
    /// Identité non sensible du compte approuvé (jamais de secret ici).
    email: Option<String>,
    plan: Option<String>,
    /// Budget mensuel courant (USD) livré dès l'approbation.
    budget_usd: Option<f64>,
}

/// Interroge l'état du device flow courant. En cas d'approbation, stocke les
/// jetons côté Rust **et** la clé Orvyx dans le keychain OS, puis renvoie
/// `Approved` (sans jamais exposer jetons ni secret au front).
#[tauri::command]
pub async fn cloud_device_poll(
    app: tauri::AppHandle,
    state: tauri::State<'_, CloudState>,
) -> Result<PollOutcome, String> {
    let device_code = {
        let guard = state.device_code.lock().await;
        guard.clone()
    }
    .ok_or_else(|| "No device flow in progress".to_string())?;

    let url = format!("{}/api/v1/device/poll", dashboard_url());
    let resp = http_client()?
        .post(&url)
        .json(&json!({ "device_code": device_code }))
        .send()
        .await
        .map_err(|e| format!("Cannot reach Mira cloud: {e}"))?;
    let wire: DevicePollWire = serde_json::from_str(&read_bounded(resp).await?)
        .map_err(|e| format!("Malformed device/poll response: {e}"))?;

    match wire.status.as_str() {
        "approved" => {
            let access = wire
                .access_token
                .ok_or_else(|| "Approved without access token".to_string())?;
            let refresh = wire
                .refresh_token
                .ok_or_else(|| "Approved without refresh token".to_string())?;

            // La clé est livrée ici, une seule fois. On la range dans le
            // keychain OS avant de rendre la main : si l'écriture échoue, on
            // échoue bruyamment plutôt que de laisser une session sans clé.
            if let Some(secret) = wire.key_secret {
                crate::keychain::set_secret(app, "provider:orvyx".to_string(), secret)?;
            }
            *state.key_fingerprint.lock().await = wire.key_fingerprint;

            *state.access_token.lock().await = Some(access);
            *state.refresh_token.lock().await = Some(refresh);
            *state.device_code.lock().await = None;
            Ok(PollOutcome::Approved {
                email: wire.email,
                plan: wire.plan,
                budget_usd: wire.budget_usd,
            })
        }
        "denied" => {
            *state.device_code.lock().await = None;
            Ok(PollOutcome::Denied)
        }
        "expired" => {
            *state.device_code.lock().await = None;
            Ok(PollOutcome::Expired)
        }
        "slow_down" => Ok(PollOutcome::Pending {
            interval: wire.interval.unwrap_or(5),
        }),
        _ => Ok(PollOutcome::Pending {
            interval: wire.interval.unwrap_or(5),
        }),
    }
}

// ── État cloud ───────────────────────────────────────────────────────────────

/// Mémoire du poste pour la session cloud. Les jetons et le device_code ne
/// sortent JAMAIS de cette structure vers le front.
#[derive(Default)]
pub struct CloudState {
    device_code: tokio::sync::Mutex<Option<String>>,
    access_token: tokio::sync::Mutex<Option<String>>,
    refresh_token: tokio::sync::Mutex<Option<String>>,
    /// Empreinte de la clé provisionnée (non sensible) : conservée pour
    /// l'affichage et pour détecter une clé qui ne correspondrait plus.
    key_fingerprint: tokio::sync::Mutex<Option<String>>,
}

/// Vue non sensible de l'état cloud, seule chose exposée à l'UI.
#[derive(Debug, Serialize)]
pub struct CloudStatus {
    /// Vrai si un jeton d'accès est en mémoire (session cloud active).
    pub signed_in: bool,
}

#[tauri::command]
pub async fn cloud_status(state: tauri::State<'_, CloudState>) -> Result<CloudStatus, String> {
    Ok(CloudStatus {
        signed_in: state.access_token.lock().await.is_some(),
    })
}

/// Récupère le jeton d'accès courant, ou une erreur si non connecté.
async fn access_token(state: &CloudState) -> Result<String, String> {
    state
        .access_token
        .lock()
        .await
        .clone()
        .ok_or_else(|| "Not signed in".to_string())
}

// ── Provision de la clé + catalogue ──────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct ProvisionedKey {
    pub key_fingerprint: String,
    pub masked_hint: String,
    pub budget_usd: f64,
}

#[derive(Debug, Deserialize)]
struct DesktopKeyWire {
    #[serde(default)]
    key_name: Option<String>,
    #[serde(default)]
    masked_hint: Option<String>,
    #[serde(default)]
    budget_usd: Option<f64>,
    #[serde(default)]
    key_fingerprint: Option<String>,
}

/// Récupère les métadonnées (non sensibles) de la clé Orvyx du compte.
///
/// Le secret n'est PAS récupéré ici : il a déjà été livré une seule fois par le
/// poll du device flow et rangé dans le keychain OS. Cet appel est idempotent et
/// sert à afficher « avec quelle clé je tourne ? », y compris après un
/// redémarrage du poste (session cloud reprise).
#[tauri::command]
pub async fn cloud_provision_key(
    state: tauri::State<'_, CloudState>,
    _device_label: Option<String>,
) -> Result<ProvisionedKey, String> {
    let token = access_token(&state).await?;
    let url = format!("{}/api/v1/keys/desktop", dashboard_url());
    let resp = http_client()?
        .get(&url)
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| format!("Cannot reach Mira cloud: {e}"))?;
    let wire: DesktopKeyWire = serde_json::from_str(&read_bounded(resp).await?)
        .map_err(|e| format!("Malformed desktop key response: {e}"))?;

    // On préfère l'empreinte renvoyée par le serveur, sinon celle mémorisée au
    // moment de la livraison de la clé.
    let key_fingerprint = match wire.key_fingerprint {
        Some(fp) => fp,
        None => state
            .key_fingerprint
            .lock()
            .await
            .clone()
            .unwrap_or_default(),
    };
    *state.key_fingerprint.lock().await = Some(key_fingerprint.clone());

    Ok(ProvisionedKey {
        key_fingerprint,
        masked_hint: wire.masked_hint.or(wire.key_name).unwrap_or_default(),
        budget_usd: wire.budget_usd.unwrap_or(0.0),
    })
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CloudModel {
    pub id: String,
    pub display_name: String,
}

#[derive(Debug, Deserialize)]
struct ModelsWire {
    models: Vec<CloudModel>,
}

/// Récupère le catalogue de modèles Mira depuis le plan de contrôle.
#[tauri::command]
pub async fn cloud_fetch_models(state: tauri::State<'_, CloudState>) -> Result<Vec<CloudModel>, String> {
    let token = access_token(&state).await?;
    let url = format!("{}/api/v1/models", dashboard_url());
    let resp = http_client()?
        .get(&url)
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| format!("Cannot reach Mira cloud: {e}"))?;
    let wire: ModelsWire = serde_json::from_str(&read_bounded(resp).await?)
        .map_err(|e| format!("Malformed models response: {e}"))?;
    Ok(wire.models)
}

/// Ramène la fenêtre Mira au premier plan.
///
/// Le navigateur ne peut pas réveiller une app native : après l'approbation du
/// device flow, c'est au poste de se manifester. Appelé par l'UI dès que le poll
/// renvoie `approved`, il sort la fenêtre de la barre des tâches, la restaure si
/// elle est réduite et lui rend le focus. Best-effort : chaque étape est tolérée
/// en échec (un OS peut refuser le focus sans action utilisateur), on ne fait
/// donc jamais échouer la connexion pour ça.
#[tauri::command]
pub async fn cloud_focus_window(window: tauri::WebviewWindow) -> Result<(), String> {
    crate::window_focus::bring_window_to_front(&window);
    Ok(())
}

/// URL de la page de tarifs du portail Mira, où l'utilisateur change d'offre.
///
/// L'URL est construite à partir de la MÊME base que le reste du plan de
/// contrôle (`dashboard_url()`), donc jamais fournie par l'utilisateur ni par
/// un modèle : pas de SSRF ni d'ouverture d'un lien arbitraire. Le front se
/// contente de l'ouvrir dans le navigateur système.
#[tauri::command]
pub async fn cloud_upgrade_url() -> Result<String, String> {
    Ok(format!("{}/pricing", dashboard_url()))
}

/// Oublie la session cloud côté poste (les jetons en mémoire sont effacés).
///
/// Ne supprime PAS la clé Orvyx : elle reste valide pour l'inférence tant que
/// le compte la détient. La révocation de clé est une action serveur distincte.
#[tauri::command]
pub async fn cloud_sign_out(state: tauri::State<'_, CloudState>) -> Result<(), String> {
    *state.access_token.lock().await = None;
    *state.refresh_token.lock().await = None;
    *state.device_code.lock().await = None;
    *state.key_fingerprint.lock().await = None;
    Ok(())
}
