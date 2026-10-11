// Détection des environnements de développement installés sur la machine.
//
// Sécurité : on n'invoque jamais de shell. Chaque détection lance directement un
// binaire connu avec un unique argument littéral (`--version`). Aucune donnée
// utilisateur n'est concaténée dans la commande, donc pas de risque d'injection.

use std::process::Command;

#[derive(serde::Serialize)]
pub struct ToolInfo {
    /// Nom logique ("python", "node", "git").
    name:    String,
    /// Chemin de l'exécutable réellement résolu, si trouvé.
    path:    Option<String>,
    /// Version parsée (ex. "3.13.15"), vide si indisponible.
    version: Option<String>,
}

/// Lance un binaire avec `--version` et renvoie la première ligne non vide de
/// stdout (ou stderr, certains outils écrivant leur version sur stderr).
fn probe(exe: &str) -> Option<(String, String)> {
    let out = Command::new(exe).arg("--version").output().ok()?;
    let mut line = String::new();
    for raw in [&out.stdout, &out.stderr] {
        let s = String::from_utf8_lossy(raw);
        if let Some(first) = s.lines().find(|l| !l.trim().is_empty()) {
            line = first.trim().to_string();
            break;
        }
    }
    // Résolution du chemin réel via `which`-like : on garde le nom si introuvable.
    let path = resolve_path(exe).unwrap_or_else(|| exe.to_string());
    Some((path, line))
}

/// Extrait la première séquence ressemblant à un numéro de version.
fn parse_version(raw: &str) -> String {
    let mut best = String::new();
    for token in raw.split(|c: char| c.is_whitespace() || c == 'v') {
        let digits = token
            .trim_matches(|c: char| !c.is_ascii_digit() && c != '.')
            .chars()
            .take_while(|c| c.is_ascii_digit() || *c == '.')
            .collect::<String>();
        if digits.matches('.').count() >= 1 && digits.chars().any(|c| c.is_ascii_digit()) {
            best = digits.trim_end_matches('.').to_string();
            break;
        }
    }
    best
}

/// Résout le chemin absolu d'un binaire en parcourant le PATH (sans shell).
fn resolve_path(exe: &str) -> Option<String> {
    let path_var = std::env::var_os("PATH")?;
    let exts: Vec<String> = if cfg!(windows) {
        std::env::var("PATHEXT")
            .unwrap_or_else(|_| ".EXE;.CMD;.BAT".to_string())
            .split(';')
            .map(|s| s.to_string())
            .collect()
    } else {
        vec![String::new()]
    };
    for dir in std::env::split_paths(&path_var) {
        for ext in &exts {
            let candidate = dir.join(format!("{exe}{ext}"));
            if candidate.is_file() {
                return Some(candidate.to_string_lossy().into_owned());
            }
        }
    }
    None
}

fn detect(names: &[&str]) -> Vec<ToolInfo> {
    names
        .iter()
        .map(|&name| match probe(name) {
            Some((path, raw)) => {
                let version = parse_version(&raw);
                ToolInfo {
                    name: name.to_string(),
                    path: Some(path),
                    version: if version.is_empty() { Some(raw) } else { Some(version) },
                }
            }
            None => ToolInfo {
                name:    name.to_string(),
                path:    None,
                version: None,
            },
        })
        .collect()
}

/// Détecte Python, Node.js et Git. Renvoie une entrée par outil, y compris
/// ceux introuvables (path/version à `None`).
#[tauri::command]
pub fn detect_dev_environment() -> Vec<ToolInfo> {
    let mut tools = Vec::new();
    tools.extend(detect(&["python3", "python"]));
    tools.extend(detect(&["node", "npm"]));
    tools.extend(detect(&["git"]));
    tools
}
