//! Retour de la fenêtre principale au premier plan, une seule implémentation.
//!
//! Trois chemins veulent ramener Mira devant l'utilisateur :
//!
//! 1. **Fin d'authentification** (`cloud_focus_window`, appelé par l'UI dès que
//!    le poll du device flow renvoie `approved`) ;
//! 2. **Deep link `mira://auth`** (`deep_link::handle_urls`) ;
//! 3. **Relance du binaire** (double-clic d'icône, `single_instance`).
//!
//! Historiquement ces trois chemins faisaient chacun `unminimize`/`show`/
//! `set_focus`. Le `set_focus` seul **ne suffit pas sur macOS** : il faut que le
//! process soit une application *activée* (politique d'activation `Regular` et
//! appel à `NSApplication.activate()`), sinon le système refuse de donner le
//! premier plan à un binaire non enregistré auprès de LaunchServices — ce qui
//! est précisément le cas du binaire de dev lancé par `cargo tauri dev`.
//!
//! On centralise donc ici le geste : une seule implémentation, tolérante à
//! l'échec (le focus peut être refusé sans geste utilisateur ; on ne doit
//! jamais faire échouer une connexion ou un deep link pour ça).

use tauri::{Manager, Runtime};

/// Force l'activation de l'application au niveau de l'OS (macOS uniquement).
///
/// Sans cet appel, `window.set_focus()` ne fait que demander le focus : macOS le
/// refuse si l'app n'est pas active, et la fenêtre reste derrière le navigateur
/// après une authentification ou un deep link.
///
/// Best-effort intégral : toute erreur (pas de main thread disponible, etc.) est
/// ignorée. Objectif : ne jamais faire échouer l'appelant pour un souci de focus.
#[cfg(target_os = "macos")]
fn activate_app_macos() {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSApplication, NSApplicationActivationPolicy};

    // `NSApplication` est `MainThreadOnly` : on ne peut y accéder que depuis le
    // thread principal. `MainThreadMarker::new()` échoue sinon → on abandonne
    // silencieusement (les appels Tauri de ce module partent du main thread).
    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let app = NSApplication::sharedApplication(mtm);
    // Une app sans icône dans le Dock (Accessory/Prohibited) ne peut pas être
    // activée : on repasse en `Regular` avant de demander le premier plan.
    app.setActivationPolicy(NSApplicationActivationPolicy::Regular);
    app.unhide(None);
    app.activate();
}

/// Politique d'activation par défaut : no-op hors macOS.
#[cfg(not(target_os = "macos"))]
fn activate_app_macos() {}

/// Ramène la fenêtre principale de l'application au premier plan.
///
/// Étape 1 : activer l'app au niveau de l'OS (indispensable sur macOS).
/// Étape 2 : sortir la fenêtre de la barre des tâches, la restaurer si réduite,
///          et lui rendre le focus.
///
/// Best-effort : chaque étape est tolérée en échec.
pub fn bring_to_front<R: Runtime>(app: &tauri::AppHandle<R>) {
    activate_app_macos();
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Variante quand on a déjà la fenêtre sous la main (commande `cloud_focus_window`).
///
/// On repasse par l'`AppHandle` pour activer l'app avant de toucher la fenêtre.
pub fn bring_window_to_front<R: Runtime>(window: &tauri::WebviewWindow<R>) {
    activate_app_macos();
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}
