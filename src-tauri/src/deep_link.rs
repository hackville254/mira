//! Deep links `mira://` : retour du navigateur vers l'app native.
//!
//! Parcours : après approbation d'un device flow, la page web de Mira redirige
//! le navigateur vers `mira://auth?status=approved`. L'OS remet cette URL au
//! process Mira (ou le démarre s'il était fermé), ce qui :
//!
//! 1. ramène la fenêtre au premier plan,
//! 2. signale au front qu'une approbation vient d'arriver.
//!
//! Le deep link est un **signal d'accélération**, jamais une source de vérité :
//! la clé Orvyx et les jetons ne s'obtiennent qu'en interrogeant le plan de
//! contrôle (le poll du device flow). Aucun secret ne transite dans l'URL, donc
//! un `mira://` forgé par un logiciel tiers ne peut pas faire croire à une
//! connexion : au pire il réveille la fenêtre, et le poll tranche.
//!
//! Sécurité : le schéma est vérifié contre la liste blanche (`mira`), et seuls
//! les hôtes connus sont acceptés. Tout le reste est ignoré en silence.

use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_deep_link::DeepLinkExt;

/// Nom de l'évènement écouté par le front (voir `src/lib/deepLink.ts`).
pub const DEEP_LINK_EVENT: &str = "mira://deep-link";

/// Schéma enregistré dans `tauri.conf.json > plugins > deep-link`.
const SCHEME: &str = "mira";

/// Hôtes acceptés pour `mira://<host>`. Un hôte hors de cette liste est ignoré :
/// on ne veut pas transformer un lien arbitraire en action applicative.
const ALLOWED_HOSTS: &[&str] = &["auth", "open"];

/// Analyse une URL de deep link et dit si elle doit être transmise au front.
///
/// Renvoie l'URL canonique si elle est légitime. Volontairement strict : schéma
/// `mira`, hôte connu, pas de contenu inattendu.
fn parse_deep_link(raw: &str) -> Option<String> {
    let parsed = tauri::Url::parse(raw).ok()?;
    if parsed.scheme() != SCHEME {
        return None;
    }
    if !ALLOWED_HOSTS.contains(&parsed.host_str().unwrap_or("")) {
        return None;
    }
    Some(parsed.to_string())
}

/// Ramène la fenêtre principale au premier plan, puis prévient le front.
///
/// Best-effort sur le focus (un OS peut refuser sans geste utilisateur) : on
/// émet l'évènement quoi qu'il arrive, car c'est lui qui débloque l'UI.
pub fn handle_urls<R: Runtime>(app: &AppHandle<R>, urls: Vec<String>) {
    let accepted: Vec<String> = urls.iter().filter_map(|u| parse_deep_link(u)).collect();
    if accepted.is_empty() {
        return;
    }

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }

    for url in accepted {
        let _ = app.emit(DEEP_LINK_EVENT, url);
    }
}

/// Branche l'écoute des deep links auprès du plugin.
///
/// - `get_current` couvre le cas « l'app a été DÉMARRÉE par le lien »
///   (l'app était fermée : le process est neuf, aucun évènement ne suit).
/// - `on_open_url` couvre le cas « l'app tournait déjà ».
pub fn init<R: Runtime>(app: &AppHandle<R>) {
    if let Ok(Some(urls)) = app.deep_link().get_current() {
        handle_urls(app, urls.iter().map(|u| u.to_string()).collect());
    }

    let handle = app.clone();
    app.deep_link().on_open_url(move |event| {
        handle_urls(&handle, event.urls().iter().map(|u| u.to_string()).collect());
    });
}
