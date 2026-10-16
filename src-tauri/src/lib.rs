mod ai;
mod ai_env;
mod checkpoint;
mod dap;
// `downloader` et `lsp_index` sont publics pour permettre au test d'intégration
// réseau (`tests/lsp_install_e2e.rs`) de télécharger réellement un binaire LSP
// et de vérifier son empreinte. Cela n'ajoute aucune commande `invoke`.
pub mod downloader;
mod env;
mod env_path;
mod extensions;
mod fs;
mod git;
mod keychain;
mod log;
mod lsp;
pub mod lsp_index;
mod node_runtime;
mod search;
mod sidecar;
mod system;
mod terminal;
mod tree;

use std::collections::HashMap;
use std::sync::Mutex;

use tauri::{AppHandle, Manager, WebviewBuilder, WebviewUrl};
use dpi::{LogicalPosition, LogicalSize};

/// URL courante des webviews embarqués (`embed_ide_panel`), indexée par label.
///
/// On NE lit PAS `webview.url()` : dans wry 0.55.1, `url_from_webview` fait
/// `webview.URL().unwrap()`, qui **panic** (et tue tout le process) dès que le
/// WKWebView n'a pas encore d'URL non-nulle — cas systématique pendant le
/// chargement initial. Ce state est la source de vérité, alimenté à l'embed et
/// mis à jour par le handler de navigation.
#[derive(Default)]
struct PanelUrlState(Mutex<HashMap<String, String>>);

// IMPORTANT: these commands MUST be `async fn`.
//
// `Window::add_child` (Tauri 2.11.2) dispatches the webview build onto the main
// thread via `run_on_main_thread` and then *blocks* on `rx.recv()` waiting for
// the result. A synchronous `#[tauri::command]` runs on the main thread itself,
// so the command would dispatch work to the main thread and then block that same
// thread waiting for it — a self-deadlock. The spinner would spin forever.
//
// Declaring the command `async` makes Tauri run it on its async runtime thread
// pool instead of the main thread, so the dispatch-and-wait completes normally.
#[tauri::command]
async fn embed_ide_panel(
    app: AppHandle,
    state: tauri::State<'_, PanelUrlState>,
    panel_id: String,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    // Destroy any existing embedded webview with this label first
    if let Some(existing) = app.get_webview(&panel_id) {
        let _ = existing.close();
    }
    let host = app
        .get_webview_window("main")
        .ok_or_else(|| "Host window not found".to_string())?;
    let window = host.as_ref().window();
    let parsed_url = url::Url::parse(&url).map_err(|e| e.to_string())?;

    // Capture l'URL demandée comme source de vérité, et mets à jour ce state à
    // chaque navigation (clics de liens, redirections). On évite ainsi tout
    // appel à `webview.url()` qui paniquerait tant que le WKWebView n'a pas
    // d'URL non-nulle.
    if let Ok(mut map) = state.0.lock() {
        map.insert(panel_id.clone(), url.clone());
    }
    let nav_app = app.clone();
    let nav_panel = panel_id.clone();
    window
        .add_child(
            WebviewBuilder::new(&panel_id, WebviewUrl::External(parsed_url))
                .on_navigation(move |target| {
                    if let Some(s) = nav_app.try_state::<PanelUrlState>() {
                        if let Ok(mut map) = s.0.lock() {
                            map.insert(nav_panel.clone(), target.to_string());
                        }
                    }
                    true // n'interrompt jamais la navigation
                }),
            LogicalPosition::new(x, y),
            LogicalSize::new(width, height),
        )
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn resize_ide_panel(
    app: AppHandle,
    panel_id: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    if let Some(webview) = app.get_webview(&panel_id) {
        webview
            .set_position(LogicalPosition::new(x, y))
            .map_err(|e| e.to_string())?;
        webview
            .set_size(LogicalSize::new(width, height))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn destroy_ide_panel(
    app: AppHandle,
    state: tauri::State<'_, PanelUrlState>,
    panel_id: String,
) -> Result<(), String> {
    if let Ok(mut map) = state.0.lock() {
        map.remove(&panel_id);
    }
    if let Some(webview) = app.get_webview(&panel_id) {
        webview.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn get_ide_panel_url(
    state: tauri::State<'_, PanelUrlState>,
    panel_id: String,
) -> Result<String, String> {
    // Lecture depuis le state : on n'appelle JAMAIS `webview.url()` (panic wry).
    let map = state.0.lock().map_err(|e| e.to_string())?;
    map.get(&panel_id)
        .cloned()
        .ok_or_else(|| "panel not found".to_string())
}

/// Construit et installe le menu applicatif natif, adapté à l'OS.
///
/// Objectif : **retirer** l'item natif « Select All » (Cmd+A sur macOS, Ctrl+A
/// ailleurs) du menu Édition. Sur macOS en particulier, cet item est fourni par
/// le menu par défaut de Tauri et déclenche une sélection « tout » NATIVE, au
/// niveau OS, qui court-circuite le `preventDefault()` du webview — d'où le
/// contournement impossible à bloquer depuis le JS. En le retirant, le raccourci
/// retombe dans le DOM et notre handler le gère (sélection confinée à l'éditeur).
///
/// Contenu par OS :
/// - macOS : sous-menu applicatif (À propos / Quitter) + Édition (Couper/Copier/
///   Coller) + Fenêtre. PAS de SelectAll.
/// - Windows / Linux : barre « Édition » (Couper/Copier/Coller) + Quitter. PAS de
///   SelectAll. (Sur ces OS, `Undo/Redo` natifs ne sont pas supportés : ils
///   restent gérés par CodeMirror et le DOM.)
fn build_app_menu(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{MenuBuilder, SubmenuBuilder};

    let edit = SubmenuBuilder::new(app, "Edit")
        .cut()
        .copy()
        .paste()
        .build()?;

    #[cfg(target_os = "macos")]
    let menu = {
        let app_menu = SubmenuBuilder::new(app, "Origin")
            .about(None)
            .separator()
            .quit()
            .build()?;
        let window = SubmenuBuilder::new(app, "Window")
            .minimize()
            .maximize()
            .separator()
            .close_window()
            .build()?;
        MenuBuilder::new(app)
            .item(&app_menu)
            .item(&edit)
            .item(&window)
            .build()?
    };

    #[cfg(not(target_os = "macos"))]
    let menu = {
        let file = SubmenuBuilder::new(app, "File").quit().build()?;
        MenuBuilder::new(app).item(&file).item(&edit).build()?
    };

    app.set_menu(menu)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Dev uniquement : injecte le `.env` (clé API, provider/modèle par défaut)
    // dans l'environnement du process. No-op en build release.
    ai_env::load_dotenv_into_env();
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(terminal::TerminalState::new())
        .manage(lsp::LspState::new())
        .manage(dap::DapState::new())
        .manage(sidecar::SidecarState::new())
        .manage(PanelUrlState::default())
        .setup(|app| {
            // Menu applicatif EXPLICITE, par OS. Raison : sur macOS, Tauri ajoute
            // sinon un menu par défaut dont l'item « Edit ▸ Select All » est lié à
            // Cmd+A au niveau de l'OS — cet item déclenche un « tout sélectionner »
            // NATIF qui court-circuite le `preventDefault()` du DOM. Impossible
            // depuis le JS de l'empêcher. On fournit donc notre propre menu, SANS
            // l'item natif SelectAll, pour que Cmd+A / Ctrl+A atteigne la webview
            // et soit géré par notre logique (sélection confinée à l'éditeur).
            build_app_menu(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // Cycle de vie du sidecar Node lié à la fenêtre principale : à la
            // destruction, on coupe le process (sinon un `node` orphelin
            // continuerait à tourner et à tenir son fichier SQLite). Best-effort
            // et non bloquant — `kill_on_drop` sert de filet de sécurité.
            if let tauri::WindowEvent::Destroyed = event {
                if window.label() == "main" {
                    sidecar::shutdown_blocking(window.app_handle());
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            keychain::set_secret,
            keychain::get_secret,
            keychain::delete_secret,
            fs::read_dir,
            fs::read_file,
            fs::read_file_range,
            fs::read_file_base64,
            fs::write_file,
            fs::rename_path,
            fs::delete_path,
            fs::create_dir_cmd,
            fs::copy_path,
            fs::path_exists,
            fs::reveal_in_explorer,
            fs::read_editor_keybindings,
            fs::detect_installed_editors,
            git::git_branch,
            git::git_changes,
            git::git_status_files,
            git::git_log_full,
            git::git_commit,
            git::git_commit_push,
            git::git_stage,
            git::git_stage_all,
            git::git_unstage,
            git::git_discard,
            git::git_pull,
            git::git_push,
            git::git_fetch,
            git::git_list_branches,
            git::git_checkout,
            git::git_create_branch,
            git::git_commit_amend,
            git::git_commit_sync,
            git::git_diff,
            git::git_file_head,
            git::git_stash_save,
            git::git_stash_list,
            git::git_stash_pop,
            git::git_stash_apply,
            git::git_stash_drop,
            git::git_blame,
            system::sys_memory,
            env::detect_dev_environment,
            terminal::terminal_create,
            terminal::terminal_create_task,
            terminal::terminal_shell_name,
            terminal::terminal_write,
            terminal::terminal_resize,
            terminal::terminal_close,
            search::search_in_files,
            search::replace_in_files,
            search::replace_one,
            search::search_symbols,
            search::list_workspace_files,
            tree::get_file_tree,
            tree::get_import_edges,
            ai::agent_bash_run,
            ai::ai_stream_proxy,
            ai::fetch_text,
            checkpoint::checkpoint_begin,
            checkpoint::checkpoint_touch_file,
            checkpoint::checkpoint_undo,
            checkpoint::checkpoint_discard,
            checkpoint::checkpoint_count,
            checkpoint::checkpoint_summary,
            checkpoint::checkpoint_list_turns,
            checkpoint::checkpoint_file_before,
            checkpoint::checkpoint_revert_preview,
            checkpoint::checkpoint_undo_many,
            ai_env::dev_ai_config,
            log::origin_log,
            lsp::lsp_start,
            lsp::lsp_request,
            lsp::lsp_notify,
            lsp::lsp_stop,
            lsp::lsp_probe,
            lsp::lsp_install,
            lsp::lsp_catalog,
            dap::dap_start,
            dap::dap_request,
            dap::dap_stop,
            extensions::extensions_root_path,
            extensions::list_extensions,
            extensions::install_extension,
            extensions::uninstall_extension,
            extensions::read_extension_asset,
            extensions::inspect_extension,
            node_runtime::resolve_node_runtime,
            sidecar::cline_sidecar_start,
            sidecar::cline_sidecar_send,
            sidecar::cline_sidecar_stop,
            sidecar::cline_sidecar_status,
            embed_ide_panel,
            resize_ide_panel,
            destroy_ide_panel,
            get_ide_panel_url,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
