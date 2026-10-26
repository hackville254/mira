//! Retour de la fenêtre principale au premier plan, une seule implémentation.
//!
//! Trois chemins veulent ramener Mira devant l'utilisateur :
//!
//! 1. **Fin d'authentification** (`cloud_focus_window`, appelé par l'UI dès que
//!    le poll du device flow renvoie `approved`) ;
//! 2. **Deep link `mira://auth`** (`deep_link::handle_urls`) ;
//! 3. **Relance du binaire** (double-clic d'icône, `single_instance`).
//!
//! Le geste se fait en DEUX temps, dans cet ordre :
//!
//! 1. activer l'app au niveau de l'OS (macOS : `NSApplication`) ;
//! 2. `unminimize` / `show` / `set_focus` sur la fenêtre.
//!
//! **Ces appels se font directement, sans `run_on_main_thread`.** C'est
//! volontaire : les publier sur la file du main thread les exécute *trop tard*
//! (une fois le main thread libre), et le navigateur a repris le focus entre
//! temps — la fenêtre restait alors derrière. Les chemins appelants sont déjà
//! sur le main thread, ce qui suffit à `NSApplication`.
//!
//! On garde le tout tolérant à l'échec : un focus refusé par l'OS ne doit jamais
//! faire échouer une connexion ou un deep link.

use tauri::{Manager, Runtime};

/// Active l'application au niveau de l'OS (macOS uniquement).
///
/// Sans cet appel, `window.set_focus()` ne fait que *demander* le focus : macOS
/// le refuse si l'app n'est pas déjà active, et la fenêtre reste derrière le
/// navigateur après une authentification ou un deep link.
///
/// No-op hors macOS, et best-effort intégral : toute erreur est ignorée.
#[cfg(target_os = "macos")]
fn activate_app() {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSApplication, NSApplicationActivationPolicy};

    // `NSApplication` est `MainThreadOnly` : `new()` renvoie `None` hors du
    // thread principal, auquel cas on abandonne sans bruit.
    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let app = NSApplication::sharedApplication(mtm);
    // Une app sans icône dans le Dock (Accessory/Prohibited) ne peut pas être
    // activée : on repasse en `Regular` avant de demander le premier plan.
    app.setActivationPolicy(NSApplicationActivationPolicy::Regular);
    app.unhide(None);
    // `activate()` est non-garanti sur macOS (« does not guarantee that the app
    // will be activated at all ») et déprécié en faveur d'un comportement
    // coopératif. `activateIgnoringOtherApps(true)` force le passage au premier
    // plan même si une autre app (le navigateur) détient le focus — exactement
    // notre cas après un device flow.
    #[allow(deprecated)]
    app.activateIgnoringOtherApps(true);
}

/// Politique d'activation par défaut : no-op hors macOS.
#[cfg(not(target_os = "macos"))]
fn activate_app() {}

/// Ramène la fenêtre principale de l'application au premier plan.
///
/// Best-effort : chaque étape est tolérée en échec.
pub fn bring_to_front<R: Runtime>(app: &tauri::AppHandle<R>) {
    activate_app();
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Variante quand on a déjà la fenêtre sous la main (commande `cloud_focus_window`).
pub fn bring_window_to_front<R: Runtime>(window: &tauri::WebviewWindow<R>) {
    activate_app();
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}
