use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{
    atomic::{AtomicU32, Ordering},
    Mutex,
};
use tauri::Emitter;

struct TermInstance {
    master: Box<dyn portable_pty::MasterPty + Send>,
    writer: Box<dyn Write + Send>,
}

pub struct TerminalState {
    instances: Mutex<HashMap<u32, TermInstance>>,
    next_id:   AtomicU32,
}

impl TerminalState {
    pub fn new() -> Self {
        Self {
            instances: Mutex::new(HashMap::new()),
            next_id:   AtomicU32::new(1),
        }
    }
}

#[cfg(windows)]
fn default_shell() -> String {
    "powershell.exe".to_string()
}

#[cfg(not(windows))]
fn default_shell() -> String {
    std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
}

/// Basename of the shell used for terminals (e.g. "bash", "zsh", "powershell").
#[tauri::command]
pub fn terminal_shell_name() -> String {
    let shell = default_shell();
    std::path::Path::new(&shell)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(&shell)
        .to_string()
}

// ── Exécution de tâches (Run) ────────────────────────────────────────────────
//
// Sécurité : on n'écrit JAMAIS de chaîne arbitraire dans le shell. Le programme
// et ses arguments sont passés **en tableau** à `CommandBuilder`, qui construit
// un argv sans passer par un shell — aucune injection de commande possible
// (`;`, `&&`, `$(...)`, redirections, etc. restent des caractères littéraux).
//
// Le programme doit par ailleurs appartenir à une allowlist d'interpréteurs
// connus. `enforce_program` accepte soit un **nom nu** (`python3`, `cargo`) —
// auquel cas le binaire doit être trouvé dans le PATH — soit un **chemin absolu**
// dont le nom de fichier est dans l'allowlist (permet de binder un interpréteur
// détecté à un chemin précis).

/// Interpréteurs/outils autorisés à être lancés par une tâche.
const TASK_PROGRAM_ALLOWLIST: &[&str] = &[
    "python", "python3", "pypy", "pypy3", "node", "npm", "npx", "bun", "deno",
    "tsx", "ts-node", "cargo", "rustc", "go", "java", "javac", "dotnet", "ruby",
    "php", "perl", "lua", "Rscript", "swift", "dart", "kotlin", "kotlinc",
    "scala", "make", "cmake", "bash", "sh", "zsh", "fish", "powershell", "pwsh",
    "gcc", "g++", "clang", "clang++", "zig",
];

/// Vérifie qu'une chaîne d'argv ne contient pas de caractère de contrôle dangereux.
fn validate_argv_component(value: &str, what: &str) -> Result<(), String> {
    if value.is_empty() {
        return Err(format!("task {what} must not be empty"));
    }
    if value.len() > 4096 {
        return Err(format!("task {what} is too long"));
    }
    if value.contains('\0') || value.contains('\n') || value.contains('\r') {
        return Err(format!("task {what} contains an illegal control character"));
    }
    Ok(())
}

/// Résout un programme nu via le PATH **enrichi** (comme `which`). Retourne
/// `true` si un fichier exécutable correspondant existe. Purement une
/// vérification : le binaire trouvé n'est PAS exécuté ici.
///
/// On interroge le PATH enrichi et non celui du process : lancée depuis le GUI,
/// l'app ne voit pas `~/.cargo/bin`, `/opt/homebrew/bin`, etc.
fn program_in_path(program: &str) -> bool {
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
                if dir.join(format!("{program}{ext}")).is_file() {
                    return true;
                }
            }
            if dir.join(program).is_file() {
                return true;
            }
        }
        #[cfg(not(windows))]
        {
            if dir.join(program).is_file() {
                return true;
            }
        }
    }
    false
}

/// Valide le programme d'une tâche contre l'allowlist + l'existence réelle.
/// Retourne le token à passer à `CommandBuilder` (nom nu ou chemin absolu validé).
fn enforce_program(program: &str) -> Result<String, String> {
    validate_argv_component(program, "program")?;

    let looks_like_path = program.contains('/') || program.contains('\\');

    let base = if looks_like_path {
        // Chemin absolu requis : un chemin relatif dépendrait du cwd et serait
        // ambigu — on l'interdit pour rester déterministe.
        if !std::path::Path::new(program).is_absolute() {
            return Err("task program path must be absolute".to_string());
        }
        std::path::Path::new(program)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string()
    } else {
        program.to_string()
    };

    // Le nom de fichier (sans extension sur Windows) doit être dans l'allowlist.
    #[cfg(windows)]
    let base_no_ext = std::path::Path::new(&base)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(&base)
        .to_string();
    #[cfg(not(windows))]
    let base_no_ext = base.clone();

    let allowed = TASK_PROGRAM_ALLOWLIST
        .iter()
        .any(|p| p.eq_ignore_ascii_case(&base) || p.eq_ignore_ascii_case(&base_no_ext));
    if !allowed {
        return Err(format!(
            "\"{program}\" is not in the allowed interpreter list"
        ));
    }

    if !looks_like_path && !program_in_path(&base) {
        return Err(format!("\"{program}\" was not found in PATH"));
    }

    Ok(program.to_string())
}

/// Lance une tâche (`Run`) dans un PTY dédié, **sans shell**.
///
/// `cwd` : dossier de travail (la racine du workspace est vérifiée côté frontend).
/// `program` + `args` : commande passée en argv direct (pas de concaténation).
#[tauri::command]
pub fn terminal_create_task(
    cwd: String,
    program: String,
    args: Vec<String>,
    cols: u16,
    rows: u16,
    state: tauri::State<'_, TerminalState>,
    app: tauri::AppHandle,
) -> Result<u32, String> {
    validate_argv_component(&cwd, "cwd")?;
    let program = enforce_program(&program)?;
    for arg in &args {
        // Les arguments peuvent être vides (ex. `-c ""`), longueur bornée.
        if arg.len() > 4096 {
            return Err("task argument is too long".to_string());
        }
        if arg.contains('\0') || arg.contains('\n') || arg.contains('\r') {
            return Err("task argument contains an illegal control character".to_string());
        }
    }

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    // CommandBuilder(argv) → spawn direct, aucun shell intermédiaire.
    let mut cmd = CommandBuilder::new(program);
    for arg in &args {
        cmd.arg(arg);
    }
    cmd.cwd(&cwd);
    // PATH enrichi : une app GUI n'hérite pas du PATH du shell, donc `node`,
    // `cargo`, etc. seraient introuvables dans le PTY sans cette injection.
    cmd.env("PATH", crate::env_path::enriched_path_os().to_string_lossy().as_ref());

    let _child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;

    let id = state.next_id.fetch_add(1, Ordering::SeqCst);

    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buf[..n]).into_owned();
                    let _ = app.emit(&format!("terminal-output-{}", id), data);
                }
            }
        }
        let _ = app.emit(&format!("terminal-exit-{}", id), ());
    });

    state
        .instances
        .lock()
        .unwrap()
        .insert(id, TermInstance { master: pair.master, writer });

    Ok(id)
}

#[tauri::command]
pub fn terminal_create(
    cwd: String,
    cols: u16,
    rows: u16,
    state: tauri::State<'_, TerminalState>,
    app: tauri::AppHandle,
) -> Result<u32, String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    let mut cmd = CommandBuilder::new(default_shell());
    cmd.cwd(&cwd);
    // Idem tâche : le shell interactif doit hériter du PATH enrichi (surtout sous
    // macOS où un shell non-login ne relit pas les rc utilisateur).
    cmd.env("PATH", crate::env_path::enriched_path_os().to_string_lossy().as_ref());

    // Slave dropped after spawn so master gets EOF on shell exit
    let _child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;

    let id = state.next_id.fetch_add(1, Ordering::SeqCst);

    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buf[..n]).into_owned();
                    let _ = app.emit(&format!("terminal-output-{}", id), data);
                }
            }
        }
        let _ = app.emit(&format!("terminal-exit-{}", id), ());
    });

    state
        .instances
        .lock()
        .unwrap()
        .insert(id, TermInstance { master: pair.master, writer });

    Ok(id)
}

#[tauri::command]
pub fn terminal_write(
    id: u32,
    data: String,
    state: tauri::State<'_, TerminalState>,
) -> Result<(), String> {
    let mut instances = state.instances.lock().unwrap();
    let inst = instances
        .get_mut(&id)
        .ok_or_else(|| "terminal not found".to_string())?;
    inst.writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn terminal_resize(
    id: u32,
    cols: u16,
    rows: u16,
    state: tauri::State<'_, TerminalState>,
) -> Result<(), String> {
    let instances = state.instances.lock().unwrap();
    let inst = instances
        .get(&id)
        .ok_or_else(|| "terminal not found".to_string())?;
    inst.master
        .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn terminal_close(id: u32, state: tauri::State<'_, TerminalState>) -> Result<(), String> {
    // Dropping TermInstance closes the master PTY, sending EOF to the shell
    state.instances.lock().unwrap().remove(&id);
    Ok(())
}
