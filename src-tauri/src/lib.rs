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
mod search;
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
        .manage(PanelUrlState::default())
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
            embed_ide_panel,
            resize_ide_panel,
            destroy_ide_panel,
            get_ide_panel_url,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
