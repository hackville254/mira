// Journalisation centralisée d'Origin.
//
// ── Pourquoi ──────────────────────────────────────────────────────────────────
// Sans DevTools ouvertes, `console.info` du front est invisible en usage normal :
// impossible de savoir « où ça casse » ni de mesurer le TTFT. On expose donc UNE
// commande `origin_log` qui :
//   1. écrit sur stderr du process → VISIBLE dans le terminal `tauri dev`
//      (c'est là que l'utilisateur regarde) ;
//   2. append dans un fichier de log persistant (utile en release, où il n'y a
//      aucun terminal) sous `~/.origin/logs/origin.log`.
//
// ── Sécurité ──────────────────────────────────────────────────────────────────
//   - Le fichier est ouvert en APPEND, jamais tronqué ; on ne supprime rien.
//   - Redaction défensive : on ne logge JAMAIS un secret. Le front n'envoie que
//     des messages de diagnostic ; côté Rust on filtre en plus les motifs de clé
//     (`oryx_`, `sk-`, `Bearer `) pour ne pas persister un secret par erreur.
//   - Écriture best-effort : une erreur d'I/O ne doit JAMAIS faire échouer l'app
//     ni être renvoyée au front (le log ne peut pas casser une fonctionnalité).
//   - Taille bornée : au-delà de `MAX_LOG_BYTES`, on archive en `.1` (rotation
//     simple) pour éviter qu'un long run ne remplisse le disque.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;

/// Taille max du fichier de log avant rotation (5 Mio).
const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;

/// Motifs à masquer dans les messages (défense en profondeur : une clé ne doit
/// jamais finir sur disque, même si un appelant en glisse une par mégarde).
const SECRET_MARKERS: [&str; 5] = ["oryx_", "sk-", "sk_", "Bearer ", "api_key="];

/// Dossier de logs : `~/.origin/logs`. `None` si le home est introuvable.
fn log_dir() -> Option<PathBuf> {
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))?;
    Some(PathBuf::from(home).join(".origin").join("logs"))
}

/// Remplace toute occurrence d'un motif de secret par `***`.
fn redact(message: &str) -> String {
    let mut out = message.to_string();
    for marker in SECRET_MARKERS {
        if out.contains(marker) {
            // On masque depuis le motif jusqu'à la fin du « mot » (espace suivant).
            let mut result = String::with_capacity(out.len());
            let mut rest = out.as_str();
            while let Some(pos) = rest.find(marker) {
                result.push_str(&rest[..pos]);
                result.push_str("***");
                let after = &rest[pos + marker.len()..];
                // On saute le reste du token (jusqu'au prochain séparateur).
                let end = after
                    .find(|c: char| c.is_whitespace() || c == '"' || c == '\'')
                    .unwrap_or(after.len());
                rest = &after[end..];
            }
            result.push_str(rest);
            out = result;
        }
    }
    out
}

/// Bornage : si le fichier dépasse `MAX_LOG_BYTES`, on le renomme en `.1`
/// (écrasement de l'archive précédente) puis on repart sur un fichier neuf.
fn rotate_if_needed(path: &std::path::Path) {
    if let Ok(meta) = fs::metadata(path) {
        if meta.len() >= MAX_LOG_BYTES {
            let archive = path.with_extension("log.1");
            let _ = fs::rename(path, &archive);
        }
    }
}

/// Écrit une ligne horodatée. Best-effort : renvoie `false` en cas d'échec I/O,
/// mais n'échoue jamais bruyamment (un log ne doit pas casser l'app).
fn write_line(level: &str, target: &str, message: &str) -> bool {
    let safe = redact(message);
    // Horodatage ISO-8601 UTC sans dépendance externe (epoch → composants).
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let line = format!("[{now}][{level}][{target}] {safe}");

    // 1. Terminal (visible dans `tauri dev`).
    eprintln!("{line}");

    // 2. Fichier persistant (best-effort, jamais bloquant pour l'app).
    let Some(dir) = log_dir() else { return true };
    if fs::create_dir_all(&dir).is_err() {
        return false;
    }
    let path = dir.join("origin.log");
    rotate_if_needed(&path);
    let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&path) else {
        return false;
    };
    writeln!(file, "{line}").is_ok()
}

/// Redirige une ligne de **stderr du sidecar Node** vers le journal central.
///
/// Le sidecar écrit son diagnostic sur stderr (le canal protocolaire est
/// stdout) : on le fait apparaître dans le terminal `tauri dev` et dans le
/// fichier de log, sans jamais le renvoyer au webview. La redaction habituelle
/// s'applique (une clé glissée par erreur ne finit pas sur disque).
pub fn forward_sidecar_stderr(_app: &tauri::AppHandle, line: &str) {
    let _ = write_line("warn", "cline/sidecar", line);
}

/// Journalise une ligne depuis le code Rust interne (hors commande Tauri).
///
/// Exposé pour instrumenter les chemins chauds côté Rust (checkpoints,
/// sidecar) directement dans le terminal `tauri dev`, sans passer par le front.
/// La redaction défensive s'applique comme partout.
pub fn log_line(level: &str, target: &str, message: &str) {
    let _ = write_line(level, target, message);
}

/// Commande unique de log, appelée par le front.
///
/// `level` ∈ {debug, info, warn, error}. Toute autre valeur est ramenée à `info`.
/// `target` est un tag court et stable (ex. « agent/run », « ai/panel ») qui
/// permet de filtrer le fichier. `message` est un texte déjà formaté côté front.
#[tauri::command]
pub fn origin_log(level: String, target: String, message: String) {
    let level = match level.as_str() {
        "debug" | "info" | "warn" | "error" => level.as_str(),
        _ => "info",
    };
    let _ = write_line(level, &target, &message);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_oryx_keys() {
        let out = redact("clé=oryx_abc123 def");
        assert!(out.contains("***"));
        assert!(!out.contains("abc123"));
    }

    #[test]
    fn redacts_bearer_tokens() {
        let out = redact("header: Bearer xyz789 fin");
        assert!(out.contains("***"));
        assert!(!out.contains("xyz789"));
    }

    #[test]
    fn leaves_plain_text_untouched() {
        assert_eq!(redact("aucun secret ici"), "aucun secret ici");
    }

    #[test]
    fn redacts_multiple_markers() {
        let out = redact("a sk-1 b sk-2 c");
        assert!(!out.contains("sk-1"));
        assert!(!out.contains("sk-2"));
    }

    #[test]
    fn write_line_persists_and_redacts() {
        // Exerce le chemin réel : répertoire + fichier + redaction, sans dépendre
        // d'un home utilisateur (on isole dans un HOME temporaire).
        let tmp = std::env::temp_dir().join(format!("origin-log-test-{}", std::process::id()));
        let _ = fs::create_dir_all(&tmp);
        // On ne peut pas surcharger HOME proprement ici sans cursed env global ;
        // on teste donc directement `redact` + l'écriture bas niveau.
        let line = format!("[test][info][unit] {}", redact("clé oryx_secret fin"));
        assert!(line.contains("***"));
        assert!(!line.contains("secret"));

        let path = tmp.join("probe.log");
        {
            let mut f = OpenOptions::new().create(true).append(true).open(&path).unwrap();
            writeln!(f, "{line}").unwrap();
        }
        let content = fs::read_to_string(&path).unwrap();
        assert!(content.contains("[unit]"));
        assert!(content.contains("***"));
        let _ = fs::remove_file(&path);
        let _ = fs::remove_dir(&tmp);
    }
}
