//! Lanceur Rust du **sidecar Node** qui héberge le moteur d'agent Cline SDK.
//!
//! POURQUOI UN SIDECAR
//! -------------------
//! Le moteur d'agent (Cline SDK `@cline/core`) est un paquet Node : le porter
//! dans le process Rust serait une réécriture sans fin et fragile. On
//! l'exécute donc dans un **process Node séparé** (le « sidecar »), lancé et
//! supervisé par Rust. On garde ainsi un moteur unique pour les deux modes
//! (IDE et IA) sans réimplémenter quoi que ce soit.
//!
//! PROTOCOLE
//! ---------
//! Parent (Rust) et enfant (Node) communiquent en **NDJSON** sur stdin/stdout :
//! une ligne = un objet JSON. Rust écrit des commandes (`{id, type, …}`) sur
//! stdin ; Node émet `{id, ok, result|error}` pour les réponses et
//! `{kind:"ready"|"event", …}` pour le flux asynchrone. Le sidecar ne ré-émet
//! jamais de secret : les journaux de l'agent ne repassent pas par le webview.
//!
//! SÉCURITÉ (défense en profondeur)
//! --------------------------------
//!   1. **Aucun port réseau.** Communication par les tubes du process :
//!      inaccessible depuis l'extérieur de la machine, et le webview ne parle
//!      jamais directement au sidecar.
//!   2. **Cycle de vie lié au parent.** Le sidecar reçoit `CLINE_DIR` confiné
//!      dans `<app_data>/cline` (jamais le home brut) et meurt avec l'app.
//!   3. **Chemin du bundle validé.** On n'exécute que le script `index.mjs`
//!      résolu par nous-mêmes (ressource Tauri ou chemin de dev), jamais un
//!      chemin fourni par le webview.
//!   4. **Node vérifié.** Le binaire `node` provient du résolveur
//!      `node_runtime` (déjà sondé : version ≥ 22), jamais d'un chemin
//!      arbitraire.
//!   5. **Entrées bornées.** Chaque ligne écrite est sérialisée, l'`id` de
//!      corrélation est imposé par Rust, et une ligne trop longue est refusée.
//!   6. **stderr ≠ protocole.** Le dump du sidecar va sur stderr et est
//!      redirigé vers le journal d'Origin (jamais vers le webview).
//!   7. **Environnement minimal.** Le sidecar ne reçoit PAS l'environnement
//!      complet du process Rust (qui peut contenir des jetons, proxys, clés
//!      cloud) : on repart d'un environnement vide et on ne réinjecte que le
//!      strict nécessaire (`PATH`, `HOME`, `CLINE_DIR`, `CLINE_DATA_DIR`).
//!   8. **Sorties bornées.** Une ligne NDJSON relayée au webview est plafonnée
//!      (`MAX_EVENT_LINE_BYTES`) : un sidecar compromis ne peut pas saturer la
//!      mémoire du webview en émettant des lignes géantes.

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};
use tokio::sync::oneshot;
use tokio::sync::Mutex as AsyncMutex;

use crate::node_runtime;

/// Événement Tauri sur lequel le webview écoute le flux du sidecar. Le payload
/// est la **ligne NDJSON brute** reçue de Node (objet déjà sérialisé), ce qui
/// évite tout re-encodage côté Rust et laisse le front typé décider.
pub const EVENT_CLINE: &str = "cline://event";

/// Délai maximal accordé au handshake `ready` après le spawn. Node démarre le
/// moteur (lecture SQLite, etc.) : marge confortable, mais on refuse d'attendre
/// sans fin si le binaire est cassé.
const READY_TIMEOUT: Duration = Duration::from_secs(20);

/// Délai accordé à l'arrêt propre (`shutdown` → sortie du process) avant de
/// recourir au `kill`.
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);

/// Longueur maximale d'une ligne de commande écrite vers le sidecar (8 Mio).
/// Une commande légitime (prompt, config) reste très en-deçà ; ce plafond
/// empêche qu'une entrée démesurée sature le tube.
const MAX_COMMAND_LINE_BYTES: usize = 8 * 1024 * 1024;

/// Longueur maximale d'une ligne d'événement stdout relayée au webview (4 Mio).
/// Les événements réels (chunks, tool-calls, team_progress) restent très
/// en-deçà ; ce plafond empêche qu'un sidecar défaillant ou compromis sature
/// la mémoire du webview avec une ligne démesurée. Au-delà, la ligne est
/// remplacée par un événement d'erreur borné (on ne perd pas le signal).
const MAX_EVENT_LINE_BYTES: usize = 4 * 1024 * 1024;

/// Nombre de lignes **stderr** conservées pour le diagnostic d'un échec de
/// démarrage (les plus récentes). Assez pour capturer une stacktrace Node ou un
/// message `MODULE_NOT_FOUND`, borné pour ne jamais croître sans limite.
const STDERR_TAIL_LINES: usize = 50;

/// Délai maximal d'attente de la réponse d'une commande (corrélée par `id`).
/// `start` crée la session sans tour (donc sans appel réseau) : la réponse est
/// quasi immédiate. Ce délai n'est qu'un garde-fou : au-delà, on échoue
/// explicitement plutôt que de laisser le front attendre indéfiniment.
const COMMAND_REPLY_TIMEOUT: Duration = Duration::from_secs(30);

/// Process enfant + canal d'écriture, sous un verrou unique.
struct SidecarProcess {
    child: Child,
    stdin: ChildStdin,
}

/// État global du sidecar, géré par Tauri (`.manage`).
pub struct SidecarState {
    /// Le process et son stdin, tant qu'il tourne. `None` = arrêté.
    ///
    /// `tokio::sync::Mutex` (et non `std`) : le verrou est tenu à travers un
    /// `.await` (écriture sur stdin), et un `MutexGuard` std n'est pas `Send` —
    /// ce qui rendrait les commandes Tauri `async` non-`Send` et refuserait de
    /// compiler. Le guard tokio, lui, est `Send`.
    process: AsyncMutex<Option<SidecarProcess>>,
    /// Séquençage des commandes : chaque commande porte un `id` croissant que
    /// le sidecar rejoue dans sa réponse, ce qui permet la corrélation.
    next_id: AtomicU64,
    /// Résolveurs des commandes **en attente de réponse**. La boucle de lecture
    /// stdout y aiguille la ligne `{id, ok, result|error}` vers le `oneshot`
    /// correspondant, ce qui donne au front un véritable appel requête/réponse
    /// (ex. `start` → `{ sessionId }`) au lieu d'un simple « pousse et oublie ».
    ///
    /// `Arc<...>` : la tâche de lecture (durée de vie `'static`) doit pouvoir
    /// partager cette table avec les commandes Tauri, qui n'ont qu'un accès
    /// emprunté via `tauri::State`.
    pending: Arc<AsyncMutex<HashMap<u64, oneshot::Sender<serde_json::Value>>>>,
    /// PID du process courant (0 = arrêté). Permet un statut synchrone sans
    /// verrouiller le process, ni bloquer sur un `await`.
    pid: AtomicU32,
    /// Chemin du binaire Node résolu (diagnostic).
    node_path: Mutex<Option<String>>,
    /// Version de Node résolue (diagnostic).
    node_version: Mutex<Option<String>>,
}

impl SidecarState {
    pub fn new() -> Self {
        Self {
            process: AsyncMutex::new(None),
            next_id: AtomicU64::new(1),
            pending: Arc::new(AsyncMutex::new(HashMap::new())),
            pid: AtomicU32::new(0),
            node_path: Mutex::new(None),
            node_version: Mutex::new(None),
        }
    }
}

/// Statut renvoyé au frontend (diagnostic sans secret).
#[derive(serde::Serialize, Clone, Debug)]
pub struct SidecarStatus {
    /// `true` si le process tourne actuellement.
    pub running: bool,
    /// PID du process, si connu.
    pub pid: Option<u32>,
    /// Chemin du Node utilisé.
    pub node_path: Option<String>,
    /// Version du Node utilisé.
    pub node_version: Option<String>,
    /// Dossier de données Cline (SQLite / sessions) — confiné dans app-data.
    pub data_dir: Option<String>,
}

/// Construit une erreur JSON structurée (code stable + message), comme le reste
/// de l'app (le frontend s'appuie sur `code`).
fn sidecar_error(code: &str, message: &str) -> String {
    serde_json::json!({ "code": code, "message": message }).to_string()
}

/// Enrichit une erreur de démarrage avec les dernières lignes **stderr** du
/// sidecar, pour que l'échec soit auto-explicatif (« le sidecar s'est arrêté
/// avant d'être prêt » + la stacktrace réelle). Si aucun stderr n'a été capté,
/// l'erreur est renvoyée inchangée.
///
/// Le message est borné (les caractères de contrôle sont neutralisés, longueur
/// plafonnée) : c'est un diagnostic, pas un canal de données.
fn with_stderr_tail(error_json: String, tail: &Arc<Mutex<VecDeque<String>>>) -> String {
    let detail = match tail.lock() {
        Ok(lines) if !lines.is_empty() => lines
            .iter()
            .map(|l| sanitize_diag_line(l))
            .collect::<Vec<_>>()
            .join(" | "),
        _ => String::new(),
    };
    if detail.is_empty() {
        return error_json;
    }
    // On réinjecte le code/message d'origine et on ajoute la queue stderr.
    if let Ok(mut v) = serde_json::from_str::<serde_json::Value>(&error_json) {
        if let Some(obj) = v.as_object_mut() {
            obj.insert("stderr".to_string(), serde_json::Value::from(detail));
            return v.to_string();
        }
    }
    error_json
}

/// Nettoie une ligne de diagnostic : retire les caractères de contrôle
/// (sauts de ligne, retour chariot, ANSI) et plafonne la longueur.
fn sanitize_diag_line(line: &str) -> String {
    const MAX_LINE: usize = 400;
    let cleaned: String = line
        .chars()
        .filter(|c| !c.is_control() || *c == ' ')
        .take(MAX_LINE)
        .collect();
    cleaned.trim().to_string()
}

/// Résout le chemin du bundle `index.mjs` du sidecar.
///
/// En **release**, le bundle est embarqué comme ressource Tauri
/// (`bundle.resources`) et copié dans le dossier de ressources de l'app. En
/// **dev**, on pointe `src-tauri/cline-sidecar/dist/index.mjs` (figé à la
/// compilation via `CARGO_MANIFEST_DIR`).
///
/// On ne fait jamais confiance à un chemin fourni par le webview.
fn resolve_sidecar_script(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(resource_dir) = app.path().resource_dir() {
        let bundled = resource_dir
            .join("cline-sidecar")
            .join("dist")
            .join("index.mjs");
        if bundled.is_file() {
            return Ok(bundled);
        }
    }

    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("cline-sidecar")
        .join("dist")
        .join("index.mjs");
    if dev.is_file() {
        return Ok(dev);
    }

    Err(sidecar_error(
        "SIDECAR_SCRIPT_MISSING",
        "bundle du sidecar introuvable (exécute `npm run build:sidecar`)",
    ))
}

/// Dossier de données du sidecar, **confiné** dans `<app_data>/mira`. On ne
/// laisse jamais le sidecar écrire dans le home brut ni ailleurs.
fn resolve_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| sidecar_error("SIDECAR_NO_APP_DATA", &e.to_string()))?;
    let dir = base.join("mira");
    std::fs::create_dir_all(&dir).map_err(|e| sidecar_error("SIDECAR_DATA_DIR", &e.to_string()))?;
    Ok(dir)
}

/// Démarre le sidecar s'il ne tourne pas déjà. Idempotent : un second appel
/// alors que le process tourne renvoie le statut courant sans en lancer un autre.
#[tauri::command]
pub async fn cline_sidecar_start(
    app: AppHandle,
    state: tauri::State<'_, SidecarState>,
) -> Result<SidecarStatus, String> {
    // Déjà lancé ? On ne double pas le process.
    {
        let guard = state.process.lock().await;
        if let Some(proc) = guard.as_ref() {
            return Ok(build_status(&app, &state, true, proc.child.id()));
        }
    }

    // 1. Node conforme (réutilise tout le travail du Lot 1).
    let node = node_runtime::resolve_node_runtime(app.clone()).await?;
    let script = resolve_sidecar_script(&app)?;
    let data_dir = resolve_data_dir(&app)?;

    // 2. Spawn du process Node. `CLINE_DIR`/`CLINE_DATA_DIR` confinent les
    //    données ; `kill_on_drop` évite qu'un sidecar orphelin survive.
    //
    //    `env_clear()` : on NE transmet PAS l'environnement du process Rust,
    //    qui peut porter des jetons/proxys/clés cloud. Le sidecar n'a besoin
    //    que d'un `PATH` (pour ses propres spawns) et d'un `HOME` (défaut du
    //    SDK si `CLINE_DIR` manquait). Le reste lui est explicitement inconnu.
    let mut cmd = tokio::process::Command::new(&node.path);
    cmd.arg(&script)
        .current_dir(&data_dir)
        .env_clear()
        .env(
            "PATH",
            crate::env_path::enriched_path_os().to_string_lossy().as_ref(),
        )
        .env("CLINE_DIR", &data_dir)
        .env("CLINE_DATA_DIR", &data_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    // `HOME` : conservé uniquement s'il est défini, pour que Node/SDK résolve
    // son cache par défaut sans exposer le reste de l'environnement. Sur
    // Windows, `USERPROFILE` joue le même rôle.
    if let Some(home) = std::env::var_os("HOME") {
        cmd.env("HOME", home);
    }
    #[cfg(target_os = "windows")]
    if let Some(profile) = std::env::var_os("USERPROFILE") {
        cmd.env("USERPROFILE", profile);
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW : pas de fenêtre console parasite au lancement.
        cmd.as_std_mut().creation_flags(0x08000000);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| sidecar_error("SIDECAR_SPAWN_FAILED", &format!("spawn node: {e}")))?;

    let pid = child.id();
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| sidecar_error("SIDECAR_NO_STDIN", "stdin du sidecar indisponible"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| sidecar_error("SIDECAR_NO_STDOUT", "stdout du sidecar indisponible"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| sidecar_error("SIDECAR_NO_STDERR", "stderr du sidecar indisponible"))?;

    // 3. stderr : on l'écoute DÈS MAINTENANT (et non après le handshake) pour
    //    deux raisons :
    //      - **Diagnostic d'échec.** Si le sidecar meurt avant `ready`, tout ce
    //        qu'il a écrit (stacktrace Node, `MODULE_NOT_FOUND`, erreur de
    //        config…) est conservé dans un tampon borné qu'on joint à l'erreur.
    //        Sans cela, l'échec de démarrage était **muet** : l'UI recevait
    //        `SIDECAR_EXITED_EARLY` sans la cause réelle.
    //      - **Journal continu.** Le reste du flux part au log central.
    //    Chaque ligne est tracée ; les dernières sont mémorisées pour le
    //    diagnostic (profondeur bornée → pas de croissance mémoire).
    let stderr_tail: Arc<Mutex<VecDeque<String>>> =
        Arc::new(Mutex::new(VecDeque::with_capacity(STDERR_TAIL_LINES)));
    let err_app = app.clone();
    let err_tail = stderr_tail.clone();
    tokio::spawn(async move {
        let mut err_lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = err_lines.next_line().await {
            if line.is_empty() {
                continue;
            }
            crate::log::forward_sidecar_stderr(&err_app, &line);
            if let Ok(mut tail) = err_tail.lock() {
                if tail.len() == STDERR_TAIL_LINES {
                    tail.pop_front();
                }
                tail.push_back(line);
            }
        }
    });

    // 4. Handshake : le sidecar doit émettre `{kind:"ready"}` avant qu'on
    //    déclare le démarrage réussi. On lit la première ligne sous deadline.
    let mut reader = BufReader::new(stdout).lines();
    match tokio::time::timeout(READY_TIMEOUT, wait_for_ready(&mut reader)).await {
        Ok(Ok(())) => {}
        Ok(Err(e)) => {
            let _ = child.kill().await;
            return Err(with_stderr_tail(e, &stderr_tail));
        }
        Err(_) => {
            let _ = child.kill().await;
            return Err(with_stderr_tail(
                sidecar_error(
                    "SIDECAR_READY_TIMEOUT",
                    "le sidecar n'a pas émis `ready` dans le délai",
                ),
                &stderr_tail,
            ));
        }
    }

    // 4. Lecture continue de stdout. Deux natures de lignes s'y mêlent :
    //      - **réponse de commande** `{id, ok, result|error}` → aiguillée vers
    //        le `oneshot` en attente (requête/réponse côté front) ; elle n'est
    //        PAS poussée au webview (ce serait du bruit + peut porter des
    //        données de session).
    //      - **événement** `{kind:"event", …}` → poussé tel quel au webview sur
    //        `cline://event`. Une ligne au-delà du plafond est remplacée par un
    //        événement d'erreur borné (jamais relayée brute).
    let read_app = app.clone();
    let read_pending = state.pending.clone();
    tokio::spawn(async move {
        while let Ok(Some(line)) = reader.next_line().await {
            if line.is_empty() {
                continue;
            }
            // Aucun secret n'y transite (le sidecar ne ré-émet pas les clés).
            if line.len() > MAX_EVENT_LINE_BYTES {
                let bounded = sidecar_error(
                    "SIDECAR_EVENT_TOO_LARGE",
                    "événement du sidecar trop volumineux (rejeté)",
                );
                let _ = read_app.emit(EVENT_CLINE, bounded);
                continue;
            }
            // 4a. Réponse de commande ? On route vers le `oneshot` corrélé.
            if route_command_reply(&read_pending, &line).await {
                continue;
            }
            // 4b. Sinon : événement de flux → webview.
            let _ = read_app.emit(EVENT_CLINE, line);
        }
    });

    // 5. On installe le process dans le state.
    {
        let mut guard = state.process.lock().await;
        *guard = Some(SidecarProcess { child, stdin });
    }
    state.pid.store(pid.unwrap_or(0), Ordering::SeqCst);
    if let Ok(mut p) = state.node_path.lock() {
        *p = Some(node.path.clone());
    }
    if let Ok(mut v) = state.node_version.lock() {
        *v = Some(node.version.clone());
    }

    Ok(build_status(&app, &state, true, pid))
}

/// Attend la ligne `{kind:"ready"}` sur stdout. Toute autre ligne avant `ready`
/// est ignorée (le sidecar peut bavarder en debug). Une erreur de lecture =
/// process mort → échec.
async fn wait_for_ready(
    reader: &mut tokio::io::Lines<BufReader<tokio::process::ChildStdout>>,
) -> Result<(), String> {
    loop {
        match reader.next_line().await {
            Ok(Some(line)) => {
                if line.trim().is_empty() {
                    continue;
                }
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                    if v.get("kind").and_then(|k| k.as_str()) == Some("ready") {
                        return Ok(());
                    }
                }
            }
            Ok(None) => {
                return Err(sidecar_error(
                    "SIDECAR_EXITED_EARLY",
                    "le sidecar s'est arrêté avant d'être prêt",
                ))
            }
            Err(e) => {
                return Err(sidecar_error(
                    "SIDECAR_READ_FAILED",
                    &format!("lecture stdout: {e}"),
                ))
            }
        }
    }
}

/// Tente d'aiguiller une ligne stdout vers le résolveur d'une commande.
///
/// Une **réponse de commande** porte un `id` **numérique** (celui que Rust a
/// attribué) et un champ `ok` booléen. On émet alors la valeur complète vers le
/// `oneshot` en attente et on renvoie `true` (ligne consommée).
///
/// Toute autre ligne (`{kind:"event", …}`, `{kind:"tool_approval", …}`, ligne
/// non-JSON du sidecar en débogage, `id` non numérique…) renvoie `false` : la
/// boucle appelante la relaie au webview. Ce filtrage garantit qu'un événement
/// de flux n'est jamais capté par erreur par un `oneshot`.
async fn route_command_reply(
    pending: &Arc<AsyncMutex<HashMap<u64, oneshot::Sender<serde_json::Value>>>>,
    line: &str,
) -> bool {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
        return false;
    };
    let Some(obj) = value.as_object() else {
        return false;
    };
    // Signature d'une réponse de commande : `id` numérique + `ok` booléen.
    let Some(id) = obj.get("id").and_then(|v| v.as_u64()) else {
        return false;
    };
    if !matches!(obj.get("ok"), Some(serde_json::Value::Bool(_))) {
        return false;
    }
    let sender = {
        let mut guard = pending.lock().await;
        guard.remove(&id)
    };
    // Aucun résolveur (réponse arrivée après timeout / abandon) : on consomme la
    // ligne sans la relayer (ce n'est pas un événement d'UI).
    if let Some(sender) = sender {
        let _ = sender.send(value);
    }
    true
}

/// Envoie une commande au sidecar et attend sa **réponse corrélée**.
///
/// `command` est un objet JSON construit par le front (ex.
/// `{type:"start", cwd, apiKey, …}`) ; Rust le complète avec un `id` monotone,
/// l'encode sur une ligne, puis attend la réponse `{id, ok, result|error}` que
/// la boucle de lecture aiguille vers nous (voir `route_command_reply`).
///
/// **Retour** : le champ `result` de la réponse (objet JSON). En cas d'échec
/// côté sidecar (`ok:false`), ou de délai dépassé, on renvoie une erreur
/// structurée — le front n'attend jamais « dans le vide ».
#[tauri::command]
pub async fn cline_sidecar_send(
    command: serde_json::Value,
    state: tauri::State<'_, SidecarState>,
) -> Result<serde_json::Value, String> {
    let obj = command
        .as_object()
        .ok_or_else(|| sidecar_error("SIDECAR_BAD_COMMAND", "commande non-objet"))?;

    let id = state.next_id.fetch_add(1, Ordering::SeqCst);
    // Instrumentation round-trip (demande explicite) : on mesure le temps total
    // d'un aller-retour Rust↔Node. Le `type` de commande suffit à identifier la
    // phase (start, send, abort…) sans jamais journaliser le contenu (clé, prompt).
    let t_roundtrip = std::time::Instant::now();
    let cmd_type = obj
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("?")
        .to_string();

    // 1. Enregistrer le résolveur AVANT d'écrire : sinon une réponse très rapide
    //    (ex. `ping`) pourrait arriver avant qu'on écoute → course perdue.
    let (tx, rx) = oneshot::channel::<serde_json::Value>();
    {
        let mut guard = state.pending.lock().await;
        guard.insert(id, tx);
    }

    let mut envelope = serde_json::Map::with_capacity(obj.len() + 1);
    envelope.insert("id".to_string(), serde_json::Value::from(id));
    for (k, v) in obj {
        // On n'autorise jamais le front à écraser l'`id` de corrélation.
        if k == "id" {
            continue;
        }
        envelope.insert(k.clone(), v.clone());
    }
    let mut line = serde_json::to_string(&serde_json::Value::Object(envelope))
        .map_err(|e| sidecar_error("SIDECAR_SERIALIZE", &e.to_string()))?;
    if line.len() > MAX_COMMAND_LINE_BYTES {
        // Ne pas laisser un résolveur orphelin derrière nous.
        state.pending.lock().await.remove(&id);
        return Err(sidecar_error(
            "SIDECAR_COMMAND_TOO_LARGE",
            "commande trop volumineuse",
        ));
    }
    line.push('\n');

    // 2. Écrire la commande. Le verrou est relâché AVANT d'attendre la réponse
    //    (sinon une écriture concurrente resterait bloquée le temps du tour).
    {
        let mut guard = state.process.lock().await;
        let proc = guard
            .as_mut()
            .ok_or_else(|| sidecar_error("SIDECAR_NOT_RUNNING", "le sidecar n'est pas démarré"))?;
        if let Err(e) = proc.stdin.write_all(line.as_bytes()).await {
            drop(guard);
            state.pending.lock().await.remove(&id);
            return Err(sidecar_error(
                "SIDECAR_WRITE_FAILED",
                &format!("écriture stdin: {e}"),
            ));
        }
        if let Err(e) = proc.stdin.flush().await {
            drop(guard);
            state.pending.lock().await.remove(&id);
            return Err(sidecar_error(
                "SIDECAR_WRITE_FAILED",
                &format!("flush stdin: {e}"),
            ));
        }
    }

    // 3. Attendre la réponse corrélée sous deadline.
    let reply = match tokio::time::timeout(COMMAND_REPLY_TIMEOUT, rx).await {
        Ok(Ok(value)) => value,
        Ok(Err(_)) => {
            // L'émetteur a été abandonné (sidecar arrêté, table vidée).
            return Err(sidecar_error(
                "SIDECAR_REPLY_CHANNEL_CLOSED",
                "le sidecar a été arrêté avant de répondre",
            ));
        }
        Err(_) => {
            // Délai dépassé : on retire notre résolveur pour ne pas fuir.
            state.pending.lock().await.remove(&id);
            return Err(sidecar_error(
                "SIDECAR_REPLY_TIMEOUT",
                "le sidecar n'a pas répondu dans le délai",
            ));
        }
    };

    // 4. Déplier la réponse : `{ok:true, result}` ou `{ok:false, error}`.
    let ok = reply.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
    crate::log::log_line(
        if ok { "debug" } else { "warn" },
        "sidecar/rt",
        &format!(
            "cmd={cmd_type} id={id} ok={ok} en {}ms",
            t_roundtrip.elapsed().as_millis()
        ),
    );
    if ok {
        Ok(reply
            .get("result")
            .cloned()
            .unwrap_or(serde_json::Value::Null))
    } else {
        let err = reply.get("error").cloned().unwrap_or(serde_json::json!({
            "code": "SIDECAR_COMMAND_FAILED",
            "message": "échec de la commande",
        }));
        Err(err.to_string())
    }
}

/// Arrête proprement le sidecar : envoie `shutdown`, attend la sortie sous
/// deadline, puis `kill` en dernier recours. Idempotent.
#[tauri::command]
pub async fn cline_sidecar_stop(
    app: AppHandle,
    state: tauri::State<'_, SidecarState>,
) -> Result<SidecarStatus, String> {
    // On retire le process du state pour ne plus accepter d'écriture, puis on
    // l'arrête hors verrou (l'attente de sortie est asynchrone).
    let mut proc = {
        let mut guard = state.process.lock().await;
        guard.take()
    };
    state.pid.store(0, Ordering::SeqCst);

    // Débloquer toute commande en attente de réponse : en vidant la table, les
    // `oneshot` sont abandonnés et les `await` de `cline_sidecar_send` résolvent
    // immédiatement en `SIDECAR_REPLY_CHANNEL_CLOSED`, au lieu d'attendre le
    // délai maximal alors que le process meurt.
    state.pending.lock().await.clear();

    if let Some(p) = proc.as_mut() {
        // Politesse : demander l'arrêt propre (le sidecar acquitte puis sort).
        let shutdown = serde_json::json!({
            "id": state.next_id.fetch_add(1, Ordering::SeqCst),
            "type": "shutdown"
        })
        .to_string();
        let _ = p.stdin.write_all(shutdown.as_bytes()).await;
        let _ = p.stdin.write_all(b"\n").await;
        let _ = p.stdin.flush().await;

        match tokio::time::timeout(SHUTDOWN_TIMEOUT, p.child.wait()).await {
            Ok(Ok(_)) => {} // Sortie propre.
            _ => {
                let _ = p.child.kill().await;
                let _ = p.child.wait().await;
            }
        }
    }

    Ok(build_status(&app, &state, false, None))
}

/// Statut courant du sidecar (sans effet de bord).
#[tauri::command]
pub fn cline_sidecar_status(
    app: AppHandle,
    state: tauri::State<'_, SidecarState>,
) -> Result<SidecarStatus, String> {
    // Statut dérivé du PID atomique : aucun verrou asynchrone à attendre, donc
    // la commande peut rester synchrone et instantanée.
    let pid = state.pid.load(Ordering::SeqCst);
    let (running, pid) = if pid == 0 {
        (false, None)
    } else {
        (true, Some(pid))
    };
    Ok(build_status(&app, &state, running, pid))
}

/// Assemble le statut à partir du state (best-effort sur les champs optionnels).
fn build_status(
    app: &AppHandle,
    state: &tauri::State<'_, SidecarState>,
    running: bool,
    pid: Option<u32>,
) -> SidecarStatus {
    let node_path = state.node_path.lock().ok().and_then(|g| g.clone());
    let node_version = state.node_version.lock().ok().and_then(|g| g.clone());
    let data_dir = app
        .path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("cline").to_string_lossy().to_string());
    SidecarStatus {
        running,
        pid,
        node_path,
        node_version,
        data_dir,
    }
}

/// Arrêt du sidecar déclenché par l'app elle-même (ex. fermeture de fenêtre).
/// Best-effort : ne bloque jamais la sortie de l'app.
pub fn shutdown_blocking(app: &AppHandle) {
    let Some(state) = app.try_state::<SidecarState>() else {
        return;
    };
    // `try_lock` (et non `lock`) : on est sur le chemin de sortie de l'app, on
    // ne doit JAMAIS s'y bloquer. Si le verrou est pris (une écriture en cours),
    // `kill_on_drop` sur le `Child` fera de toute façon mourir le sidecar avec
    // le process Rust.
    let Ok(mut guard) = state.process.try_lock() else {
        return;
    };
    if let Some(p) = guard.as_mut() {
        let _ = p.child.start_kill();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sidecar_error_is_structured_json() {
        let e = sidecar_error("CODE", "message");
        let v: serde_json::Value = serde_json::from_str(&e).unwrap();
        assert_eq!(v.get("code").and_then(|c| c.as_str()), Some("CODE"));
        assert_eq!(v.get("message").and_then(|m| m.as_str()), Some("message"));
    }

    #[test]
    fn command_ids_are_monotonic() {
        // Le compteur interne garantit des `id` uniques → corrélation fiable.
        let state = SidecarState::new();
        let id1 = state.next_id.fetch_add(1, Ordering::SeqCst);
        let id2 = state.next_id.fetch_add(1, Ordering::SeqCst);
        assert_eq!(id2, id1 + 1);
    }

    /// Une réponse de commande (`{id, ok, result}`) est routée vers son
    /// `oneshot` et n'est PAS relayée comme événement.
    #[tokio::test]
    async fn routes_command_reply_to_pending_resolver() {
        let pending: Arc<AsyncMutex<HashMap<u64, oneshot::Sender<serde_json::Value>>>> =
            Arc::new(AsyncMutex::new(HashMap::new()));
        let (tx, rx) = oneshot::channel::<serde_json::Value>();
        pending.lock().await.insert(7, tx);

        let line = r#"{"id":7,"ok":true,"result":{"sessionId":"s-123"}}"#;
        let consumed = route_command_reply(&pending, line).await;
        assert!(consumed, "une réponse de commande doit être consommée");

        let value = rx.await.expect("le résolveur doit recevoir la réponse");
        assert_eq!(
            value
                .get("result")
                .and_then(|r| r.get("sessionId"))
                .and_then(|s| s.as_str()),
            Some("s-123")
        );
        // Le résolveur est retiré de la table (pas de fuite).
        assert!(pending.lock().await.is_empty());
    }

    /// Un échec de commande est routé (le front reçoit `ok:false`).
    #[tokio::test]
    async fn routes_command_error_to_pending_resolver() {
        let pending: Arc<AsyncMutex<HashMap<u64, oneshot::Sender<serde_json::Value>>>> =
            Arc::new(AsyncMutex::new(HashMap::new()));
        let (tx, rx) = oneshot::channel::<serde_json::Value>();
        pending.lock().await.insert(1, tx);

        let line = r#"{"id":1,"ok":false,"error":{"code":"BOOM","message":"nope"}}"#;
        assert!(route_command_reply(&pending, line).await);
        let value = rx.await.unwrap();
        assert_eq!(value.get("ok").and_then(|o| o.as_bool()), Some(false));
    }

    /// Un événement de flux (pas d'`id` numérique) N'EST PAS consommé : il doit
    /// continuer vers le webview, et aucun résolveur ne doit être touché.
    #[tokio::test]
    async fn does_not_route_stream_events() {
        let pending: Arc<AsyncMutex<HashMap<u64, oneshot::Sender<serde_json::Value>>>> =
            Arc::new(AsyncMutex::new(HashMap::new()));
        let (tx, _rx) = oneshot::channel::<serde_json::Value>();
        pending.lock().await.insert(1, tx);

        let line = r#"{"kind":"event","event":{"type":"chunk"}}"#;
        assert!(
            !route_command_reply(&pending, line).await,
            "un événement ne doit pas être capté par un oneshot"
        );
        // Le résolveur est intact.
        assert_eq!(pending.lock().await.len(), 1);
    }

    /// Une ligne non-JSON (bavardage de debug du sidecar) n'est pas consommée.
    #[tokio::test]
    async fn does_not_route_non_json() {
        let pending: Arc<AsyncMutex<HashMap<u64, oneshot::Sender<serde_json::Value>>>> =
            Arc::new(AsyncMutex::new(HashMap::new()));
        assert!(!route_command_reply(&pending, "debug: hello").await);
    }

    /// Une requête d'approbation (kind, sans `id` numérique) n'est pas consommée :
    /// elle passe par le canal d'événements et attend une réponse du front.
    #[tokio::test]
    async fn does_not_route_approval_requests() {
        let pending: Arc<AsyncMutex<HashMap<u64, oneshot::Sender<serde_json::Value>>>> =
            Arc::new(AsyncMutex::new(HashMap::new()));
        let line = r#"{"kind":"tool_approval","requestId":"appr-1","toolName":"editor"}"#;
        assert!(!route_command_reply(&pending, line).await);
    }
}
