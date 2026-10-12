use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicI64, Ordering},
};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader as TokioBufReader};
use tokio::sync::{mpsc, oneshot};
use tauri::Emitter;

struct LspServer {
    msg_tx:      mpsc::UnboundedSender<serde_json::Value>,
    req_counter: Arc<AtomicI64>,
    pending:     Arc<Mutex<HashMap<i64, oneshot::Sender<serde_json::Value>>>>,
    _child:      tokio::process::Child, // kill_on_drop kills on drop
}

pub struct LspState(Mutex<HashMap<String, LspServer>>);

impl LspState {
    pub fn new() -> Self {
        LspState(Mutex::new(HashMap::new()))
    }
}

/// Read one Content-Length-framed LSP message from an async buffered reader.
async fn read_lsp_msg(
    reader: &mut TokioBufReader<tokio::process::ChildStdout>,
) -> Option<serde_json::Value> {
    let mut content_length: usize = 0;
    loop {
        let mut line = String::new();
        let n = reader.read_line(&mut line).await.ok()?;
        if n == 0 { return None; }
        let trimmed = line.trim();
        if trimmed.is_empty() { break; }
        let lower = trimmed.to_ascii_lowercase();
        if let Some(rest) = lower.strip_prefix("content-length: ") {
            content_length = rest.trim().parse().ok()?;
        }
    }
    if content_length == 0 { return None; }
    let mut buf = vec![0u8; content_length];
    reader.read_exact(&mut buf).await.ok()?;
    serde_json::from_slice(&buf).ok()
}

/// Encode a JSON value as a Content-Length-framed LSP message.
fn encode_lsp_msg(msg: &serde_json::Value) -> Vec<u8> {
    let body = msg.to_string();
    let header = format!("Content-Length: {}\r\n\r\n", body.len());
    let mut out = header.into_bytes();
    out.extend_from_slice(body.as_bytes());
    out
}

fn make_lsp_process(exe: &str) -> tokio::process::Command {
    // On Windows, npm global binaries are .cmd shims; CreateProcess cannot resolve
    // them via PATHEXT. Delegate to cmd.exe so PATHEXT resolution works correctly.
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = tokio::process::Command::new("cmd");
        c.args(["/C", exe]);
        c.creation_flags(0x08000000); // CREATE_NO_WINDOW
        c
    };
    #[cfg(not(target_os = "windows"))]
    let mut cmd = tokio::process::Command::new(exe);

    cmd.stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    cmd
}

/// Allowlist des serveurs LSP internalisés.
///
/// `serverId` provient du frontend (config utilisateur) : ce mapping est la
/// **seule** autorité d'exécution. Un `serverId` inconnu est rejeté, donc le
/// frontend ne peut jamais faire exécuter un binaire arbitraire.
fn lsp_exe_and_args(server_id: &str) -> Option<(&'static str, &'static [&'static str])> {
    match server_id {
        "typescript-language-server" => Some(("typescript-language-server", &["--stdio"])),
        "rust-analyzer"              => Some(("rust-analyzer", &[])),
        "pylsp"                      => Some(("pylsp", &[])),
        // Python ouvert (PAS Pylance) : basedpyright, installé via Node+npm.
        "basedpyright"               => Some(("basedpyright-langserver", &["--stdio"])),
        "gopls"                      => Some(("gopls", &[])),
        "clangd"                     => Some(("clangd", &[])),
        "jdtls"                      => Some(("jdtls", &[])),
        "bash-language-server"       => Some(("bash-language-server", &["start"])),
        "vscode-json-language-server" => Some(("vscode-json-language-server", &["--stdio"])),
        "vscode-css-language-server"  => Some(("vscode-css-language-server", &["--stdio"])),
        "vscode-html-language-server" => Some(("vscode-html-language-server", &["--stdio"])),
        "yaml-language-server"        => Some(("yaml-language-server", &["--stdio"])),
        "dockerfile-language-server-nodejs" => Some(("dockerfile-language-server-nodejs", &["--stdio"])),
        // Markdown : binaire natif marksman, sous-commande `server`.
        "marksman"                    => Some(("marksman", &["server"])),
        // Dart / Flutter : language server fourni par le SDK Dart (`dart
        // language-server`). Jamais téléchargé par l'app : présent uniquement
        // si le SDK Dart/Flutter est installé sur la machine.
        "dart-analysis-server"        => Some(("dart", &["language-server"])),
        _ => None,
    }
}

/// Code d'erreur structuré : binaire du serveur introuvable.
///
/// Le frontend ne doit **jamais** déduire un manque de binaire en parsant un
/// message libre (fragile, localisé, dépendant de l'OS). On renvoie un objet
/// sérialisé avec un code stable ; `isMissingBinaryError` devient une simple
/// comparaison de code.
pub const ERR_BINARY_NOT_FOUND: &str = "LSP_BINARY_NOT_FOUND";

/// Erreur de résolution d'un binaire LSP, sérialisée vers le frontend.
#[derive(serde::Serialize, Clone, Debug)]
pub struct LspBinaryError {
    /// Code stable (`LSP_BINARY_NOT_FOUND`).
    pub code: &'static str,
    /// Id du serveur concerné.
    pub server_id: String,
    /// Nom du binaire recherché.
    pub binary: String,
    /// Emplacements consultés (pour le diagnostic utilisateur).
    pub searched: Vec<String>,
}

impl LspBinaryError {
    fn to_json(&self) -> String {
        // Sérialisation infaillible d'une struct de champs simples.
        serde_json::to_string(self).unwrap_or_else(|_| {
            format!(r#"{{"code":"{}","serverId":"{}"}}"#, ERR_BINARY_NOT_FOUND, self.server_id)
        })
    }
}

/// Résout la source d'exécution d'un serveur LSP, par ordre de précédence :
///
///  1. **Chemin local explicite** (`serverPath` de la config workspace/globale) —
///     s'il est fourni il fait autorité : c'est un choix utilisateur délibéré,
///     versionnable dans le projet. Doit être absolu et exister.
///  2. **Binaires embarqués dans l'app** (`<app_data>/lsp-servers/<serverId>/…`) —
///     permet à une future installation locale de fonctionner sans toucher au PATH.
///  3. **PATH système** — le cas courant (`pip install`, `npm -g`, `rustup`…).
///
/// Retourne le chemin effectif à exécuter, ou une {@link LspBinaryError} si rien
/// n'a été trouvé. Ne lance jamais de processus : pure résolution de chemin.
fn resolve_lsp_binary(
    app: &tauri::AppHandle,
    server_id: &str,
    bare_name: &str,
    server_path: Option<&str>,
) -> Result<PathBuf, LspBinaryError> {
    use tauri::Manager;

    let mut searched: Vec<String> = Vec::new();

    // 1. Chemin local explicite.
    if let Some(p) = server_path.map(str::trim).filter(|p| !p.is_empty()) {
        let path = Path::new(p);
        if path.is_absolute() && path.is_file() {
            return Ok(path.to_path_buf());
        }
        // Chemin explicite invalide : on le signale et on poursuit la recherche
        // (un chemin périmé ne doit pas bloquer un serveur installé ailleurs).
        searched.push(format!("{p} (serverPath — absent/relatif)"));
    }

    // 2. Binaires embarqués dans le dossier de données de l'app.
    //    Le dossier est nommé d'après `install_dir` (et non `server_id`) car
    //    plusieurs serveurs npm partagent un même paquet — css/html/json vivent
    //    tous trois sous `vscode-langservers-extracted`. On couvre :
    //      * `node_modules/.bin` — binaires créés par `npm install --prefix` ;
    //      * `bin` / `Scripts`       — venv Python isolé (pylsp) ;
    //      * racine                   — binaire nu décompressé (rust-analyzer).
    if let Ok(base) = app.path().app_data_dir() {
        let install_dir = crate::lsp_index::component_for(server_id)
            .map(|c| c.install_dir)
            .unwrap_or(server_id);
        let dir = base.join("lsp-servers").join(install_dir);
        let sub_dirs = [
            Some("node_modules/.bin"),
            Some("bin"),
            Some("Scripts"),
            None,
        ];
        for sub in sub_dirs {
            let target = match sub {
                Some(s) => dir.join(s),
                None => dir.clone(),
            };
            if let Some(p) = pick_executable(&target, bare_name) {
                return Ok(p);
            }
        }
        searched.push(dir.display().to_string());
    }

    // 3. PATH système.
    if let Some(p) = find_in_path(bare_name) {
        return Ok(p);
    }
    searched.push("PATH".to_string());

    // 4. Extensions VS Code installées ayant embarqué un serveur LSP.
    //    Dernier recours : couvre les `.vsix` qui expédient leur binaire (dossier
    //    `node_modules/.bin`, `bin/`, `server/` ou racine de l'extension).
    if let Some(p) = find_in_extensions(app, bare_name) {
        return Ok(p);
    }
    searched.push("<app_data>/extensions/*".to_string());

    Err(LspBinaryError {
        code: ERR_BINARY_NOT_FOUND,
        server_id: server_id.to_string(),
        binary: bare_name.to_string(),
        searched,
    })
}

/// Sous-dossiers d'une extension où un serveur LSP embarqué peut résider, par
/// ordre de probabilité. Volontairement limité (pas de scan récursif profond) :
/// une extension qui n'expose pas son binaire à l'un de ces emplacements ne sera
/// pas devinée — on préfère un échec clair plutôt qu'une découverte hasardeuse.
const EXTENSION_SERVER_DIRS: &[&str] = &[
    "node_modules/.bin",
    "bin",
    "server",
    "out",
    "dist",
    "",
];

/// Cherche `bare_name` dans les extensions installées. Lecture seule : on ne
/// résout que le **chemin**, aucune extension n'est exécutée ni son code chargé.
/// Une extension ne peut pas « piéger » la résolution : le nom de binaire est
/// imposé par l'allowlist, jamais par l'extension elle-même.
fn find_in_extensions(app: &tauri::AppHandle, bare_name: &str) -> Option<PathBuf> {
    use tauri::Manager;
    let base = app.path().app_data_dir().ok()?;
    let ext_root = base.join("extensions");
    if !ext_root.is_dir() {
        return None;
    }
    // Parcours déterministe (ordre alphabétique) pour un résultat reproductible.
    let mut dirs: Vec<PathBuf> = std::fs::read_dir(&ext_root)
        .ok()?
        .flatten()
        .filter(|e| e.path().is_dir())
        .map(|e| e.path())
        .collect();
    dirs.sort();

    for ext_dir in dirs {
        for sub in EXTENSION_SERVER_DIRS {
            let target = if sub.is_empty() {
                ext_dir.clone()
            } else {
                ext_dir.join(sub)
            };
            if let Some(p) = pick_executable(&target, bare_name) {
                return Some(p);
            }
        }
    }
    None
}

/// Cherche un exécutable `bare_name` dans un dossier dédié (avec extension
/// Windows). Retourne le premier fichier correspondant.
fn pick_executable(dir: &Path, bare_name: &str) -> Option<PathBuf> {
    if !dir.is_dir() {
        return None;
    }
    #[cfg(windows)]
    {
        for ext in [".exe", ".cmd", ".bat", ".com", ""] {
            let p = dir.join(format!("{bare_name}{ext}"));
            if p.is_file() {
                return Some(p);
            }
        }
        return None;
    }
    #[cfg(not(windows))]
    {
        let p = dir.join(bare_name);
        if p.is_file() {
            return Some(p);
        }
        None
    }
}

/// Cherche `bare_name` dans le **PATH enrichi** (process + shell de login +
/// dossiers usuels — voir `env_path`) et retourne son chemin absolu s'il existe.
/// Équivalent `which` — vérification d'existence uniquement, sans exécution.
///
/// On ne lit PAS `std::env::var_os("PATH")` directement : une app GUI n'hérite
/// pas du PATH du shell, donc le binaire serait invisible bien qu'installé.
fn find_in_path(bare_name: &str) -> Option<PathBuf> {
    #[cfg(windows)]
    let extensions: Vec<String> = std::env::var("PATHEXT")
        .unwrap_or_else(|_| ".EXE;.CMD;.BAT;.COM".to_string())
        .split(';')
        .map(|e| e.trim().to_lowercase())
        .filter(|e| !e.is_empty())
        .collect();

    for dir in crate::env_path::enriched_dirs() {
        #[cfg(windows)]
        {
            for ext in &extensions {
                let p = dir.join(format!("{bare_name}{ext}"));
                if p.is_file() {
                    return Some(p);
                }
            }
        }
        #[cfg(not(windows))]
        {
            let p = dir.join(bare_name);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

/// Valide un argument supplémentaire fourni par le frontend.
///
/// Interdit : chaîne vide, NUL, et sauts de ligne (empêchent toute tentative
/// d'injection dans un log ou un framing). Le processus est lancé sans shell,
/// donc il n'y a pas de risque d'interprétation métacaractère ; cette validation
/// est une défense en profondeur.
fn validate_lsp_arg(arg: &str) -> Result<(), String> {
    if arg.is_empty() { return Err("empty LSP argument".into()); }
    if arg.len() > 512 { return Err("LSP argument too long".into()); }
    if arg.contains('\0') || arg.contains('\n') || arg.contains('\r') {
        return Err("LSP argument contains forbidden control characters".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn lsp_start(
    language: String,
    root_path: String,
    args: Option<Vec<String>>,
    server_path: Option<String>,
    app: tauri::AppHandle,
    state: tauri::State<'_, LspState>,
) -> Result<(), String> {
    if state.0.lock().unwrap().contains_key(&language) {
        return Ok(());
    }

    // `language` porte en réalité le `serverId` (voir lib/lspConfig). L'allowlist
    // ci-dessous est l'autorité : tout id inconnu est refusé avant tout spawn.
    let (exe, default_args) = lsp_exe_and_args(&language)
        .ok_or_else(|| format!("No LSP server configured for '{}'", language))?;

    // Résolution multi-source : chemin local → binaires embarqués → PATH.
    // En cas d'échec on renvoie une erreur STRUCTURÉE (code stable) que le
    // frontend reconnaît sans parser de texte.
    let resolved = resolve_lsp_binary(&app, &language, exe, server_path.as_deref())
        .map_err(|e| e.to_json())?;

    // Arguments effectifs : ceux fournis (validés) sinon ceux par défaut.
    let extra: Vec<String> = match args {
        Some(list) => {
            for a in &list { validate_lsp_arg(a)?; }
            list
        }
        None => default_args.iter().map(|s| s.to_string()).collect(),
    };

    let exe_str = resolved.to_string_lossy().to_string();
    let mut cmd = make_lsp_process(&exe_str);
    for arg in &extra { cmd.arg(arg); }
    cmd.current_dir(&root_path);
    // Le serveur enfant doit voir le MÊME PATH que celui qu'on a utilisé pour le
    // résoudre : sans ça, `node`, `python`, ou un binaire lancé par le serveur
    // (ex. wrapper npm) serait introuvable depuis une app GUI.
    cmd.env("PATH", crate::env_path::enriched_path_os());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn {} ({}): {}", exe_str, language, e))?;

    let stdin  = child.stdin.take().ok_or("stdin unavailable")?;
    let stdout = child.stdout.take().ok_or("stdout unavailable")?;

    let (msg_tx, mut msg_rx) = mpsc::unbounded_channel::<serde_json::Value>();
    let req_counter = Arc::new(AtomicI64::new(1));
    let pending: Arc<Mutex<HashMap<i64, oneshot::Sender<serde_json::Value>>>> =
        Arc::new(Mutex::new(HashMap::new()));

    // Writer task: drain channel → stdin
    tokio::spawn(async move {
        let mut stdin = stdin;
        while let Some(msg) = msg_rx.recv().await {
            let bytes = encode_lsp_msg(&msg);
            if stdin.write_all(&bytes).await.is_err() { break; }
            let _ = stdin.flush().await;
        }
    });

    // Reader task: stdout → pending responses | frontend notifications.
    // msg_tx_r is used to auto-reply to server→client requests (see below).
    let pending_r  = pending.clone();
    let app_r      = app.clone();
    let lang_r     = language.clone();
    let msg_tx_r   = msg_tx.clone();
    tokio::spawn(async move {
        let mut reader = TokioBufReader::new(stdout);
        loop {
            let Some(msg) = read_lsp_msg(&mut reader).await else { break };
            let method_str = msg.get("method").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let has_method = !method_str.is_empty();
            let id_opt     = msg.get("id").and_then(|v| v.as_i64());

            match (has_method, id_opt) {
                // Response to a client request (id present, no method)
                (false, Some(id)) => {
                    if let Some(tx) = pending_r.lock().unwrap().remove(&id) {
                        let _ = tx.send(msg);
                    }
                }
                // Server→client request (both method and id present).
                // Auto-reply null so the server isn't left waiting.
                (true, Some(id)) => {
                    let _ = app_r.emit(&format!("lsp-server-request-{}", lang_r), &msg);
                    let _ = msg_tx_r.send(serde_json::json!({
                        "jsonrpc": "2.0",
                        "id":      id,
                        "result":  null,
                    }));
                }
                // Pure server notification (method, no id) — forward normally
                (true, None) => {
                    let _ = app_r.emit(&format!("lsp-notification-{}", lang_r), &msg);
                }
                _ => {}
            }
        }
    });

    state.0.lock().unwrap().insert(language, LspServer {
        msg_tx,
        req_counter,
        pending,
        _child: child,
    });

    Ok(())
}

#[tauri::command]
pub async fn lsp_request(
    language: String,
    method: String,
    params: serde_json::Value,
    state: tauri::State<'_, LspState>,
) -> Result<serde_json::Value, String> {
    let (tx, rx) = oneshot::channel();
    let (id, msg_tx) = {
        let guard = state.0.lock().unwrap();
        let srv = guard
            .get(&language)
            .ok_or_else(|| format!("LSP not running for '{}'", language))?;
        let id = srv.req_counter.fetch_add(1, Ordering::Relaxed);
        srv.pending.lock().unwrap().insert(id, tx);
        (id, srv.msg_tx.clone())
    };
    msg_tx
        .send(serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        }))
        .map_err(|e| e.to_string())?;
    tokio::time::timeout(std::time::Duration::from_secs(10), rx)
        .await
        .map_err(|_| "LSP request timed out".to_string())?
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn lsp_notify(
    language: String,
    method: String,
    params: serde_json::Value,
    state: tauri::State<'_, LspState>,
) -> Result<(), String> {
    let msg_tx = {
        let guard = state.0.lock().unwrap();
        let srv = guard
            .get(&language)
            .ok_or_else(|| format!("LSP not running for '{}'", language))?;
        srv.msg_tx.clone()
    };
    msg_tx
        .send(serde_json::json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        }))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn lsp_stop(
    language: String,
    state: tauri::State<'_, LspState>,
) -> Result<(), String> {
    state.0.lock().unwrap().remove(&language);
    Ok(())
}

/// Résultat de diagnostic pour un serveur LSP (commande `lsp_probe`).
#[derive(serde::Serialize, Clone, Debug)]
pub struct LspProbeResult {
    /// Id du serveur interrogé.
    pub server_id: String,
    /// Binaire recherché.
    pub binary: String,
    /// Vrai si une source exécutable a été trouvée.
    pub found: bool,
    /// Chemin absolu retenu, si trouvé.
    pub path: Option<String>,
    /// Source retenue : "serverPath" | "app" | "PATH".
    pub source: Option<String>,
    /// Emplacements consultés (toujours renseigné).
    pub searched: Vec<String>,
}

/// Interroge la disponibilité d'un serveur LSP **sans le lancer**.
///
/// Permet à l'UI de connaître l'état de chaque langage à l'avance (au lieu de
/// ne le découvrir qu'à l'ouverture d'un fichier). Purement en lecture seule.
#[tauri::command]
pub async fn lsp_probe(
    server_id: String,
    server_path: Option<String>,
    app: tauri::AppHandle,
) -> Result<LspProbeResult, String> {
    let (exe, _) = lsp_exe_and_args(&server_id)
        .ok_or_else(|| format!("No LSP server configured for '{}'", server_id))?;

    match resolve_lsp_binary(&app, &server_id, exe, server_path.as_deref()) {
        Ok(path) => {
            // Détermine la source retenue à des fins de diagnostic.
            let source = classify_source(&path, server_path.as_deref(), &app, &server_id);
            Ok(LspProbeResult {
                server_id,
                binary: exe.to_string(),
                found: true,
                path: Some(path.to_string_lossy().to_string()),
                source: Some(source),
                searched: Vec::new(),
            })
        }
        Err(e) => Ok(LspProbeResult {
            server_id: e.server_id,
            binary: e.binary,
            found: false,
            path: None,
            source: None,
            searched: e.searched,
        }),
    }
}

/// Classe la source d'un binaire résolu, pour l'affichage (serverPath / app / PATH).
fn classify_source(
    resolved: &Path,
    server_path: Option<&str>,
    app: &tauri::AppHandle,
    server_id: &str,
) -> String {
    use tauri::Manager;
    if let Some(p) = server_path.map(str::trim).filter(|p| !p.is_empty()) {
        if resolved == Path::new(p) {
            return "serverPath".to_string();
        }
    }
    if let Ok(base) = app.path().app_data_dir() {
        // Le dossier d'install est nommé d'après `install_dir` (peut différer du
        // `server_id` lorsque plusieurs serveurs partagent un paquet npm).
        let install_dir = crate::lsp_index::component_for(server_id)
            .map(|c| c.install_dir)
            .unwrap_or(server_id);
        let dir = base.join("lsp-servers").join(install_dir);
        if resolved.starts_with(&dir) {
            return "app".to_string();
        }
        let ext_root = base.join("extensions");
        if resolved.starts_with(&ext_root) {
            return "extension".to_string();
        }
    }
    "PATH".to_string()
}

// ── Installation automatique des serveurs LSP ───────────────────────────────
//
// POLITIQUE PRODUIT : l'utilisateur ne doit jamais installer un serveur à la
// main. Si un serveur installable est absent, l'app le télécharge elle-même
// (voir `lsp_index`), le vérifie par SHA-256, l'extrait et le rend exécutable
// dans `<app_data>/lsp-servers/<id>/` — exactement l'emplacement que
// `resolve_lsp_binary` consulte en priorité n°2. Aucune action manuelle ensuite.

/// Résultat d'une installation réussie.
#[derive(serde::Serialize, Clone, Debug)]
pub struct LspInstallResult {
    /// Id du serveur installé.
    pub server_id: String,
    /// Chemin absolu de l'exécutable installé.
    pub path: String,
    /// Taille téléchargée (octets).
    pub bytes: u64,
}

/// Code d'erreur structuré : serveur sans installation automatique.
pub const ERR_NOT_AUTO_INSTALLABLE: &str = "LSP_NOT_AUTO_INSTALLABLE";
/// Code d'erreur structuré : composant non disponible pour cette plateforme.
pub const ERR_UNSUPPORTED_PLATFORM: &str = "LSP_UNSUPPORTED_PLATFORM";
/// Code d'erreur structuré : serveur inconnu de l'allowlist.
pub const ERR_UNKNOWN_SERVER: &str = "LSP_UNKNOWN_SERVER";

/// Émet un événement de progression vers le frontend. Le frontend écoute
/// `lsp://install-progress` et met à jour son indicateur. Best-effort : un échec
/// d'émission ne doit jamais interrompre l'installation.
fn emit_install_progress(app: &tauri::AppHandle, server_id: &str, phase: &str, percent: u8) {
    let _ = app.emit(
        "lsp://install-progress",
        serde_json::json!({
            "serverId": server_id,
            "phase": phase,       // "download" | "extract" | "done"
            "percent": percent,
        }),
    );
}

/// Détecte la présence d'un runtime Node utilisable (PATH enrichi ou app-data).
/// Utilisé pour installer basedpyright / typescript-language-server via npm.
fn find_node() -> Option<PathBuf> {
    if let Some(p) = find_in_path("node") {
        return Some(p);
    }
    None
}

/// Détecte un interpréteur Python utilisable (PATH enrichi), pour créer un venv
/// isolé et installer `pylsp` via pip — sans droits admin, sans toucher au
/// système. On privilégie `python3` (nom canonique sur macOS/Linux modernes).
fn find_python() -> Option<PathBuf> {
    find_in_path("python3").or_else(|| find_in_path("python"))
}

/// Entrée du catalogue d'installation, exposée au frontend pour piloter l'UI
/// (bouton « Installer », ou état grisé avec explication courte).
#[derive(serde::Serialize, Clone, Debug)]
pub struct LspCatalogEntry {
    /// Id `serverId`.
    pub server_id: String,
    /// Binaire attendu (affichage).
    pub binary: String,
    /// Vrai si l'app sait l'installer automatiquement sur cette plateforme.
    pub auto_installable: bool,
    /// Taille approximative (Mo) — affichée dans le toast avant téléchargement.
    pub approx_mb: u32,
    /// Vrai si un exécutable a déjà été résolu (app-data / PATH / extension).
    pub installed: bool,
    /// Chemin résolu, si installé.
    pub path: Option<String>,
    /// Source : "serverPath" | "app" | "PATH" | "extension".
    pub source: Option<String>,
    /// Raison d'une non-installabilité automatique (code stable, ex.
    /// "NEEDS_GO_TOOLCHAIN") — jamais une phrase d'erreur. `None` si installable.
    pub reason: Option<String>,
}

/// Retourne le catalogue complet : pour chaque serveur de l'allowlist, son état
/// de disponibilité et sa capacité d'installation automatique. Lecture seule.
///
/// Le frontend s'en sert pour n'afficher que des actions exécutables : bouton
/// « Installer » si `auto_installable` et `!installed`, sinon état grisé avec
/// `reason`. Aucune erreur affichée pour un serveur simplement non installable.
#[tauri::command]
pub async fn lsp_catalog(app: tauri::AppHandle) -> Result<Vec<LspCatalogEntry>, String> {
    // Liste exhaustive de l'allowlist (alignée sur `lsp_exe_and_args`).
    const SERVER_IDS: &[&str] = &[
        "typescript-language-server",
        "rust-analyzer",
        "pylsp",
        "basedpyright",
        "gopls",
        "clangd",
        "jdtls",
        "bash-language-server",
        "vscode-json-language-server",
        "vscode-css-language-server",
        "vscode-html-language-server",
        "yaml-language-server",
        "dockerfile-language-server-nodejs",
        "marksman",
        "dart-analysis-server",
    ];

    let (os, arch) = crate::lsp_index::platform_key();
    let mut out = Vec::with_capacity(SERVER_IDS.len());

    for &id in SERVER_IDS {
        let (exe, _) = match lsp_exe_and_args(id) {
            Some(v) => v,
            None => continue,
        };
        let resolved = resolve_lsp_binary(&app, id, exe, None);
        let (installed, path, source) = match resolved {
            Ok(p) => {
                let src = classify_source(&p, None, &app, id);
                (true, Some(p.to_string_lossy().to_string()), Some(src))
            }
            Err(_) => (false, None, None),
        };

        let (auto_installable, approx_mb, reason) =
            match crate::lsp_index::component_for(id) {
                Some(comp) => {
                    // Un composant sans artefact direct reste installable dès lors
                    // qu'une voie locale existe (npm via Node, ou pip via Python).
                    let ok = crate::lsp_index::is_installable(comp, os, arch)
                        || npm_packages_for(id).is_some()
                        || id == "pylsp";
                    (ok, comp.approx_mb, None)
                }
                None => (
                    false,
                    0,
                    crate::lsp_index::not_auto_installable(id).map(str::to_string),
                ),
            };

        out.push(LspCatalogEntry {
            server_id: id.to_string(),
            binary: exe.to_string(),
            auto_installable,
            approx_mb,
            installed,
            path,
            source,
            reason,
        });
    }

    Ok(out)
}

/// Installe un serveur LSP dans app-data, en un clic, sans droits admin.
///
/// Sécurité — l'autorité vient EXCLUSIVEMENT de `lsp_index::COMPONENTS`, qui
/// est figé à la compilation. Le `server_id` fourni par le frontend est
/// confronté à cette liste ; un id inconnu est rejeté avant tout accès réseau.
/// L'URL et l'empreinte ne sont jamais contrôlées par l'appelant.
#[tauri::command]
pub async fn lsp_install(server_id: String, app: tauri::AppHandle) -> Result<LspInstallResult, String> {
    use tauri::Manager;

    // 0. Le serveur doit être dans l'allowlist d'exécution.
    let (exe, _) = lsp_exe_and_args(&server_id)
        .ok_or_else(|| format!(r#"{{"code":"{}","serverId":"{}"}}"#, ERR_UNKNOWN_SERVER, server_id))?;

    // 1. Le serveur doit avoir une installation automatique (sinon grisé côté UI).
    let comp = match crate::lsp_index::component_for(&server_id) {
        Some(c) => c,
        None => {
            let reason = crate::lsp_index::not_auto_installable(&server_id).unwrap_or("NO_AUTO_INSTALL");
            return Err(format!(
                r#"{{"code":"{}","serverId":"{}","reason":"{}"}}"#,
                ERR_NOT_AUTO_INSTALLABLE, server_id, reason
            ));
        }
    };

    let (os, arch) = crate::lsp_index::platform_key();
    let artifact = crate::lsp_index::select_artifact(comp, os, arch);

    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!(r#"{{"code":"{}","message":"{}"}}"#, crate::downloader::ERR_EXTRACT_FAILED, e))?;
    let install_root = base.join("lsp-servers");
    let dest = install_root.join(comp.install_dir);

    // 2. Cas Node+npm : basedpyright / typescript-language-server et les
    //    serveurs web/config (vscode-*, yaml, bash, dockerfile). On exige un
    //    Node présent ; sinon on renvoie une action exécutable (installer Node)
    //    plutôt qu'un échec sec — conforme à la politique « zéro travail ».
    if artifact.is_none() {
        if npm_packages_for(&server_id).is_some() {
            let node = find_node().ok_or_else(|| {
                format!(
                    r#"{{"code":"{}","serverId":"{}","reason":"NEEDS_NODE"}}"#,
                    ERR_UNSUPPORTED_PLATFORM, server_id
                )
            })?;
            emit_install_progress(&app, &server_id, "download", 10);
            let installed = install_via_npm(&node, &server_id, &dest).await?;
            emit_install_progress(&app, &server_id, "done", 100);
            return Ok(LspInstallResult {
                server_id,
                path: installed.to_string_lossy().to_string(),
                bytes: 0,
            });
        }
        // pylsp : venv Python isolé dans app-data + pip install. On exige un
        // Python présent ; sinon action exécutable (installer Python) plutôt
        // qu'un échec sec — politique « zéro travail ».
        if server_id == "pylsp" {
            let python = find_python().ok_or_else(|| {
                format!(
                    r#"{{"code":"{}","serverId":"{}","reason":"NEEDS_PYTHON"}}"#,
                    ERR_UNSUPPORTED_PLATFORM, server_id
                )
            })?;
            emit_install_progress(&app, &server_id, "download", 10);
            let installed = install_via_pip(&python, &dest).await?;
            emit_install_progress(&app, &server_id, "done", 100);
            return Ok(LspInstallResult {
                server_id,
                path: installed.to_string_lossy().to_string(),
                bytes: 0,
            });
        }
        // Composant reconnu mais sans artefact pour cette plateforme.
        return Err(format!(
            r#"{{"code":"{}","serverId":"{}","os":"{}","arch":"{}"}}"#,
            ERR_UNSUPPORTED_PLATFORM, server_id, os, arch
        ));
    }
    let artifact = artifact.unwrap();

    // 3. Téléchargement vérifié par SHA-256 (échec → rien n'est écrit).
    emit_install_progress(&app, &server_id, "download", 5);
    let bytes = crate::downloader::fetch_verified(artifact.url, artifact.sha256)
        .await
        .map_err(|e| e.to_json())?;
    let total = bytes.len() as u64;
    emit_install_progress(&app, &server_id, "download", 80);

    // 4. Extraction sûre vers app-data (anti zip-slip), puis chmod +x.
    emit_install_progress(&app, &server_id, "extract", 90);
    // Repart d'un dossier propre : un ancien binaire partiel ne doit pas masquer
    // le nouveau. On retire uniquement le dossier cible (sous notre app-data).
    if dest.exists() {
        let _ = std::fs::remove_dir_all(&dest);
    }
    let installed: PathBuf = match artifact.archive {
        "bin" => {
            // Binaire nu mono-fichier (marksman) : écrit tel quel + chmod +x.
            let exe_name = if cfg!(windows) { format!("{exe}.exe") } else { exe.to_string() };
            crate::downloader::write_binary(&bytes, &dest, &exe_name).map_err(|e| e.to_json())?
        }
        "gz" => {
            // rust-analyzer : gzip d'un binaire nu (pas un tar.gz).
            let exe_name = if cfg!(windows) { format!("{exe}.exe") } else { exe.to_string() };
            crate::downloader::extract_single_gz(&bytes, &dest, &exe_name).map_err(|e| e.to_json())?
        }
        "zip" => {
            let files = crate::downloader::extract_zip(&bytes, &dest).map_err(|e| e.to_json())?;
            // Retrouve l'exécutable attendu (exe_hint) dans ce qui a été extrait.
            let want = artifact.exe_hint;
            let found = files
                .iter()
                .find(|p| p.file_name().map(|n| n == want).unwrap_or(false))
                .map(|p| dest.join(p))
                .ok_or_else(|| {
                    format!(
                        r#"{{"code":"{}","message":"exe '{}' absent de l'archive"}}"#,
                        crate::downloader::ERR_EXTRACT_FAILED, want
                    )
                })?;
            crate::downloader::make_executable(&found);
            found
        }
        other => {
            return Err(format!(
                r#"{{"code":"{}","message":"archive inconnue: {}"}}"#,
                crate::downloader::ERR_EXTRACT_FAILED, other
            ));
        }
    };

    emit_install_progress(&app, &server_id, "done", 100);
    Ok(LspInstallResult {
        server_id,
        path: installed.to_string_lossy().to_string(),
        bytes: total,
    })
}

/// Paquets npm à installer pour un `serverId`, ou `None` si ce serveur ne
/// s'installe pas via npm. **Source unique** : sert à la fois à décider du
/// routage (`lsp_install`) et à construire la commande `npm install`.
fn npm_packages_for(server_id: &str) -> Option<&'static [&'static str]> {
    match server_id {
        "basedpyright" => Some(&["basedpyright"]),
        "typescript-language-server" => Some(&["typescript-language-server", "typescript"]),
        // Un seul paquet fournit trois binaires (css/html/json).
        "vscode-css-language-server"
        | "vscode-html-language-server"
        | "vscode-json-language-server" => Some(&["vscode-langservers-extracted"]),
        "yaml-language-server" => Some(&["yaml-language-server"]),
        "bash-language-server" => Some(&["bash-language-server"]),
        "dockerfile-language-server-nodejs" => Some(&["dockerfile-language-server-nodejs"]),
        _ => None,
    }
}

/// Noms de binaires attendus dans `node_modules/.bin` après installation, par
/// ordre de préférence (le premier trouvé gagne).
fn npm_bin_names(server_id: &str) -> &'static [&'static str] {
    match server_id {
        "basedpyright" => &["basedpyright-langserver", "basedpyright"],
        "typescript-language-server" => &["typescript-language-server"],
        "vscode-css-language-server" => &["vscode-css-language-server"],
        "vscode-html-language-server" => &["vscode-html-language-server"],
        "vscode-json-language-server" => &["vscode-json-language-server"],
        "yaml-language-server" => &["yaml-language-server"],
        "bash-language-server" => &["bash-language-server"],
        "dockerfile-language-server-nodejs" => &["dockerfile-language-server-nodejs"],
        _ => &[],
    }
}

/// Installe un serveur npm (`basedpyright`, `typescript-language-server`, et les
/// serveurs web/config) dans app-data via `npm install --prefix`, sans droits
/// admin et sans toucher au système. Retourne le chemin de l'exécutable installé
/// dans `node_modules/.bin`.
async fn install_via_npm(node: &Path, server_id: &str, dest: &Path) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dest).map_err(|e| {
        format!(r#"{{"code":"{}","message":"{}"}}"#, crate::downloader::ERR_EXTRACT_FAILED, e)
    })?;

    // Paquets officiels et ouverts (pas de composant propriétaire).
    let packages: &[&str] = npm_packages_for(server_id)
        .ok_or_else(|| format!(r#"{{"code":"{}","message":"npm: id inconnu"}}"#, ERR_UNKNOWN_SERVER))?;

    // npm doit être invoqué via le node détecté. On ne passe PAS par un shell :
    // on localise `npm-cli.js` relativement au binaire node. Les dispositions
    // diffèrent selon le gestionnaire :
    //   * nvm / `n` / Homebrew : `<node_bin>/../lib/node_modules/npm/bin/npm-cli.js`
    //     (npm est dans le `lib/` du préfixe, pas à côté du binaire) ;
    //   * distributions Windows / npm embarqué : `<node_bin>/node_modules/npm/bin/npm-cli.js`.
    // On ne retombe PAS sur `npm` du PATH : sous nvm/`n` c'est un script shell
    // (shim), qu'on ne peut pas passer comme script à `node`.
    let npm_cli = node.parent().and_then(|bin| {
        [
            bin.join("..").join("lib").join("node_modules").join("npm").join("bin").join("npm-cli.js"),
            bin.join("node_modules").join("npm").join("bin").join("npm-cli.js"),
        ]
        .into_iter()
        .find(|p| p.is_file())
    });

    let mut cmd = tokio::process::Command::new(node);
    match npm_cli {
        Some(cli) => {
            cmd.arg(cli);
        }
        None => {
            return Err(format!(
                r#"{{"code":"{}","serverId":"{}","reason":"NEEDS_NODE"}}"#,
                ERR_UNSUPPORTED_PLATFORM, server_id
            ));
        }
    }
    cmd.arg("install")
        .arg("--prefix")
        .arg(dest)
        .arg("--no-audit")
        .arg("--no-fund");
    for p in packages {
        cmd.arg(p);
    }
    // PATH enrichi pour que npm retrouve node ; répertoire de travail isolé.
    cmd.env("PATH", crate::env_path::enriched_path_os())
        .current_dir(dest)
        .stdin(std::process::Stdio::null());

    let out = cmd.output().await.map_err(|e| {
        format!(r#"{{"code":"{}","message":"npm spawn: {}"}}"#, crate::downloader::ERR_DOWNLOAD_FAILED, e)
    })?;
    if !out.status.success() {
        return Err(format!(
            r#"{{"code":"{}","message":"npm a échoué (code {:?})"}}"#,
            crate::downloader::ERR_DOWNLOAD_FAILED,
            out.status.code()
        ));
    }

    // Exécutable attendu dans le dossier .bin local.
    let bin = dest.join("node_modules").join(".bin");
    for n in npm_bin_names(server_id) {
        if let Some(p) = pick_executable(&bin, n) {
            return Ok(p);
        }
    }
    Err(format!(
        r#"{{"code":"{}","message":"exe npm introuvable après install"}}"#,
        crate::downloader::ERR_EXTRACT_FAILED
    ))
}

/// Installe `pylsp` (python-lsp-server) dans un **venv isolé** créé dans
/// app-data, via `python -m venv` puis `<venv>/bin/pip install`. Aucune action
/// système : pas de `pip install` global, pas de droits admin, pas de pollution
/// du Python de l'utilisateur. Retourne le chemin de l'exécutable `pylsp` du venv
/// (`bin/pylsp` sur Unix, `Scripts/pylsp.exe` sur Windows).
async fn install_via_pip(python: &Path, dest: &Path) -> Result<PathBuf, String> {
    // Repart d'un environnement propre : un venv partiel ne doit pas masquer
    // une installation neuve. On ne touche que notre dossier app-data.
    if dest.exists() {
        let _ = std::fs::remove_dir_all(dest);
    }
    std::fs::create_dir_all(dest).map_err(|e| {
        format!(r#"{{"code":"{}","message":"{}"}}"#, crate::downloader::ERR_EXTRACT_FAILED, e)
    })?;

    // 1. Créer le venv isolé dans app-data.
    let out = tokio::process::Command::new(python)
        .arg("-m")
        .arg("venv")
        .arg(dest)
        .env("PATH", crate::env_path::enriched_path_os())
        .stdin(std::process::Stdio::null())
        .output()
        .await
        .map_err(|e| {
            format!(r#"{{"code":"{}","message":"venv spawn: {}"}}"#, crate::downloader::ERR_DOWNLOAD_FAILED, e)
        })?;
    if !out.status.success() {
        return Err(format!(
            r#"{{"code":"{}","message":"python -m venv a échoué (code {:?})"}}"#,
            crate::downloader::ERR_DOWNLOAD_FAILED,
            out.status.code()
        ));
    }

    // 2. Localiser le python/pip du venv (noms dépendants de l'OS).
    let venv_python = pick_executable(&dest.join("bin"), "python")
        .or_else(|| pick_executable(&dest.join("Scripts"), "python"))
        .ok_or_else(|| {
            format!(
                r#"{{"code":"{}","message":"python du venv introuvable"}}"#,
                crate::downloader::ERR_EXTRACT_FAILED
            )
        })?;

    // 3. pip install python-lsp-server (paquet officiel et ouvert, pas Pylance).
    let out = tokio::process::Command::new(&venv_python)
        .arg("-m")
        .arg("pip")
        .arg("install")
        .arg("--no-input")
        .arg("--disable-pip-version-check")
        .arg("python-lsp-server")
        .env("PATH", crate::env_path::enriched_path_os())
        .stdin(std::process::Stdio::null())
        .output()
        .await
        .map_err(|e| {
            format!(r#"{{"code":"{}","message":"pip spawn: {}"}}"#, crate::downloader::ERR_DOWNLOAD_FAILED, e)
        })?;
    if !out.status.success() {
        return Err(format!(
            r#"{{"code":"{}","message":"pip install a échoué (code {:?})"}}"#,
            crate::downloader::ERR_DOWNLOAD_FAILED,
            out.status.code()
        ));
    }

    // 4. Exécutable attendu dans le venv. `pick_executable` gère l'extension
    //    Windows (.exe/.cmd/.bat) via le même chemin de résolution que le reste.
    pick_executable(&dest.join("bin"), "pylsp")
        .or_else(|| pick_executable(&dest.join("Scripts"), "pylsp"))
        .ok_or_else(|| {
            format!(
                r#"{{"code":"{}","message":"exe pylsp introuvable après install"}}"#,
                crate::downloader::ERR_EXTRACT_FAILED
            )
        })
}
