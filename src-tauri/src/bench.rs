// Exécuteur de commandes pour le BANC D'ESSAI — DEV-ONLY.
//
// POURQUOI CE MODULE (et pas `agent_bash_run`)
// --------------------------------------------
// `agent_bash_run` est calibré pour l'usage AGENT : timeout 120 s et sortie
// plafonnée à 64 Ko. Ces bornes sont saines pour un outil qui alimente le
// contexte d'un modèle, mais elles rendent l'ÉVALUATION d'une tâche SWE-bench
// impossible : une seule exécution pytest dans un conteneur Docker peut durer
// plusieurs minutes et produire une sortie bien plus volumineuse que 64 Ko.
//
// Ce module fournit donc un exécuteur SÉPARÉ, réservé au banc, avec :
//   - un timeout PARAMÉTRABLE (borné dur par `BENCH_MAX_TIMEOUT_SECS`) ;
//   - un plafond de sortie plus large (`BENCH_MAX_OUTPUT_BYTES`).
//
// SÉCURITÉ
// --------
//   - **DEV-ONLY** : l'enregistrement de la commande est gardé par
//     `#[cfg(debug_assertions)]` (cf. `lib.rs`). En release, la commande
//     n'existe pas dans le binaire → aucun vecteur d'exécution ajouté.
//   - **cwd validé** : le répertoire doit exister et être un dossier.
//   - **timeout plafonné dur** : une valeur hostile (ou un bug d'appelant) ne
//     peut pas créer un process immortel ; au-delà du plafond on borne.
//   - **kill_on_drop** : à l'expiration du délai, le process ET ses enfants
//     (groupe de process sur Unix) sont tués — pas de fuite en arrière-plan.

use std::process::Stdio;

/// Plafond DUR du timeout demandable par le banc (30 min). Au-delà : borné.
const BENCH_MAX_TIMEOUT_SECS: u64 = 30 * 60;

/// Plafond de sortie par flux pour le banc (4 Mo). Une sortie pytest complète
/// (`-rA`) reste largement en dessous, mais on garde une marge confortable.
const BENCH_MAX_OUTPUT_BYTES: usize = 4 * 1024 * 1024;

/// Résultat d'une commande de banc. Même forme que `BashResult` côté front,
/// pour que l'appelant (webview) réutilise le même typage.
#[derive(serde::Serialize)]
pub struct BenchBashResult {
    stdout: String,
    stderr: String,
    exit_code: i32,
    timed_out: bool,
    truncated: bool,
}

/// Tronque une sortie au plafond du banc en signalant la troncature.
fn truncate_output(bytes: &[u8]) -> (String, bool) {
    if bytes.len() <= BENCH_MAX_OUTPUT_BYTES {
        return (String::from_utf8_lossy(bytes).into_owned(), false);
    }
    let mut s = String::from_utf8_lossy(&bytes[..BENCH_MAX_OUTPUT_BYTES]).into_owned();
    s.push_str("\n… [bench output truncated]");
    (s, true)
}

/// Exécute une commande de banc dans `cwd`, avec un timeout paramétrable.
///
/// `timeout_ms` est borné dur à `BENCH_MAX_TIMEOUT_SECS`. Les erreurs de
/// validation (cwd vide/inexistant) sont renvoyées telles quelles ; une
/// expiration de délai n'est PAS une erreur mais un résultat (`timed_out`).
#[tauri::command]
pub async fn bench_bash_run(
    command: String,
    cwd: String,
    timeout_ms: u64,
) -> Result<BenchBashResult, String> {
    if cwd.trim().is_empty() {
        return Err("cwd must not be empty".into());
    }
    if !std::path::Path::new(&cwd).is_dir() {
        return Err(format!("cwd does not exist or is not a directory: {cwd}"));
    }

    #[cfg(windows)]
    let (shell, flag): (String, &str) = ("powershell.exe".into(), "-Command");
    #[cfg(not(windows))]
    let (shell, flag): (String, &str) = (
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into()),
        "-c",
    );

    let mut cmd = tokio::process::Command::new(&shell);
    cmd.args([flag, &command])
        .current_dir(&cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.as_std_mut().creation_flags(0x08000000);
    }

    let child = cmd.spawn().map_err(|e| e.to_string())?;

    // Bornage dur : jamais plus que le plafond, jamais 0.
    let secs = (timeout_ms / 1000).clamp(1, BENCH_MAX_TIMEOUT_SECS);

    match tokio::time::timeout(std::time::Duration::from_secs(secs), child.wait_with_output()).await {
        Ok(Ok(out)) => {
            let (stdout, t1) = truncate_output(&out.stdout);
            let (stderr, t2) = truncate_output(&out.stderr);
            Ok(BenchBashResult {
                stdout,
                stderr,
                exit_code: out.status.code().unwrap_or(-1),
                timed_out: false,
                truncated: t1 || t2,
            })
        }
        Ok(Err(e)) => Err(e.to_string()),
        Err(_) => Ok(BenchBashResult {
            stdout: String::new(),
            stderr: format!("bench command timed out after {secs}s"),
            exit_code: -1,
            timed_out: true,
            truncated: false,
        }),
    }
}
