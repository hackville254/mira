use std::collections::HashMap;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicI64, Ordering},
};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader as TokioBufReader};
use tokio::sync::{mpsc, oneshot};
use tauri::Emitter;

struct DapSession {
    msg_tx:      mpsc::UnboundedSender<serde_json::Value>,
    seq_counter: Arc<AtomicI64>,
    pending:     Arc<Mutex<HashMap<i64, oneshot::Sender<serde_json::Value>>>>,
    _child:      tokio::process::Child, // kill_on_drop kills the adapter on drop
}

pub struct DapState(Mutex<HashMap<String, DapSession>>);

impl DapState {
    pub fn new() -> Self {
        DapState(Mutex::new(HashMap::new()))
    }
}

// Content-Length framing is identical to LSP.
async fn read_dap_msg(
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

fn encode_dap_msg(msg: &serde_json::Value) -> Vec<u8> {
    let body = msg.to_string();
    let header = format!("Content-Length: {}\r\n\r\n", body.len());
    let mut out = header.into_bytes();
    out.extend_from_slice(body.as_bytes());
    out
}

/// Returns (exe, args) for a given adapter type.
///
/// `adapter_id` provient du frontend (config utilisateur) : cette allowlist est
/// la **seule** autorité d'exécution. Un id inconnu est rejeté, donc le frontend
/// ne peut jamais faire exécuter un binaire arbitraire.
/// `adapter_path` (chemin absolu vers le binaire) reste optionnel : il ne change
/// que le chemin, jamais la nature de l'adaptateur lancé.
fn dap_exe_and_args(adapter_id: &str) -> Option<(&'static [&'static str], &'static [&'static str])> {
    match adapter_id {
        "codelldb"   => Some((&["codelldb"], &["--stdio"])),
        // debugpy s'installe comme module Python : on passe par `python -m`.
        "debugpy"    => Some((&["python", "python3"], &["-m", "debugpy.adapter"])),
        "delve"      => Some((&["dlv"], &["dap"])),
        "netcoredbg" => Some((&["netcoredbg"], &["--interpreter=vscode"])),
        "js-debug"   => Some((&["js-debug-adapter"], &[])),
        "php-debug"  => Some((&["php-debug-adapter"], &[])),
        "kotlin-debug-adapter" => Some((&["kotlin-debug-adapter"], &[])),
        _ => None,
    }
}

/// Valide un composant d'argv fourni par le frontend (défense en profondeur).
///
/// Le processus est lancé **sans shell** (argv direct), donc il n'y a pas de
/// risque d'interprétation métacaractère ; on interdit malgré tout les entrées
/// qui casseraient le framing ou les logs (NUL, sauts de ligne, vide, trop long).
fn validate_dap_arg(arg: &str) -> Result<(), String> {
    if arg.is_empty() { return Err("empty DAP argument".into()); }
    if arg.len() > 4096 { return Err("DAP argument too long".into()); }
    if arg.contains('\0') || arg.contains('\n') || arg.contains('\r') {
        return Err("DAP argument contains forbidden control characters".into());
    }
    Ok(())
}

/// Valide un chemin de binaire fourni par l'utilisateur (`adapter_path`).
fn validate_adapter_path(path: &str) -> Result<(), String> {
    if path.is_empty() { return Err("empty adapter path".into()); }
    if path.len() > 4096 { return Err("adapter path too long".into()); }
    if path.contains('\0') || path.contains('\n') || path.contains('\r') {
        return Err("adapter path contains forbidden control characters".into());
    }
    Ok(())
}


/// Spawn a debug adapter child process.
///
/// Le binaire est lancé **sans shell** : `Command::new(exe).arg(..)` construit un
/// argv, donc aucune injection métacaractère n'est possible.
///
/// Exception Windows : certains adaptateurs distribués via npm (`js-debug-adapter`,
/// `php-debug-adapter`…) sont des shims `.cmd` que `CreateProcess` ne sait pas
/// résoudre via PATHEXT. Dans ce cas seulement on délègue à `cmd /C`, ce qui est
/// sûr car `exe` provient de l'allowlist et les args ont été validés.
fn make_dap_process(exe: &str, args: &[String]) -> tokio::process::Command {
    #[cfg(target_os = "windows")]
    let mut cmd = {
        // Les shims npm sont des .cmd : on passe par cmd.exe pour la résolution PATHEXT.
        let uses_cmd_shim = exe.starts_with("js-debug") || exe.starts_with("php-debug")
            || exe.ends_with(".cmd") || exe.ends_with(".bat");
        if uses_cmd_shim {
            let mut c = tokio::process::Command::new("cmd");
            c.arg("/C").arg(exe);
            for a in args { c.arg(a); }
            c.creation_flags(0x08000000); // CREATE_NO_WINDOW
            c
        } else {
            let mut c = tokio::process::Command::new(exe);
            for a in args { c.arg(a); }
            c.creation_flags(0x08000000);
            c
        }
    };

    #[cfg(not(target_os = "windows"))]
    let mut cmd = {
        let mut c = tokio::process::Command::new(exe);
        for a in args { c.arg(a); }
        c
    };

    cmd.stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    cmd
}

#[tauri::command]
pub async fn dap_start(
    session_id: String,
    adapter: String,
    adapter_path: Option<String>,
    app: tauri::AppHandle,
    state: tauri::State<'_, DapState>,
) -> Result<(), String> {
    if state.0.lock().unwrap().contains_key(&session_id) {
        return Ok(()); // session already running
    }

    let (exe_candidates, default_args) = dap_exe_and_args(&adapter)
        .ok_or_else(|| format!("No DAP adapter configured for '{}'", adapter))?;

    // Chemin du binaire : valeur utilisateur (validée) sinon 1ᵉʳ candidat de l'allowlist.
    let exe: String = match adapter_path.as_deref() {
        Some(p) if !p.trim().is_empty() => {
            validate_adapter_path(p)?;
            p.to_string()
        }
        _ => exe_candidates[0].to_string(),
    };

    // Arguments par défaut de l'allowlist (jamais ceux du frontend : bornés ici).
    let args: Vec<String> = default_args.iter().map(|s| s.to_string()).collect();
    for a in &args { validate_dap_arg(a)?; }

    let mut cmd = make_dap_process(&exe, &args);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn {} ({}): {}", exe, adapter, e))?;

    let stdin  = child.stdin.take().ok_or("stdin unavailable")?;
    let stdout = child.stdout.take().ok_or("stdout unavailable")?;

    let (msg_tx, mut msg_rx) = mpsc::unbounded_channel::<serde_json::Value>();
    let seq_counter = Arc::new(AtomicI64::new(1));
    let pending: Arc<Mutex<HashMap<i64, oneshot::Sender<serde_json::Value>>>> =
        Arc::new(Mutex::new(HashMap::new()));

    // Writer task: drain channel → adapter stdin
    tokio::spawn(async move {
        let mut stdin = stdin;
        while let Some(msg) = msg_rx.recv().await {
            let bytes = encode_dap_msg(&msg);
            if stdin.write_all(&bytes).await.is_err() { break; }
            let _ = stdin.flush().await;
        }
    });

    // Reader task: adapter stdout → pending responses | frontend events
    let pending_r = pending.clone();
    let app_r     = app.clone();
    let sid_r     = session_id.clone();
    let msg_tx_r  = msg_tx.clone();
    tokio::spawn(async move {
        let mut reader = TokioBufReader::new(stdout);
        loop {
            let Some(msg) = read_dap_msg(&mut reader).await else { break };
            let msg_type = msg.get("type").and_then(|v| v.as_str()).unwrap_or("").to_string();

            match msg_type.as_str() {
                "response" => {
                    // Route to the pending oneshot via request_seq (NOT seq).
                    // seq is the adapter's own counter; request_seq echoes the client's seq.
                    if let Some(req_seq) = msg.get("request_seq").and_then(|v| v.as_i64()) {
                        if let Some(tx) = pending_r.lock().unwrap().remove(&req_seq) {
                            let _ = tx.send(msg);
                        }
                    }
                }
                "event" => {
                    let _ = app_r.emit(&format!("dap-event-{}", sid_r), &msg);
                }
                "request" => {
                    // Adapter → client request (e.g. runInTerminal). Forward and auto-reply null.
                    let _ = app_r.emit(&format!("dap-server-request-{}", sid_r), &msg);
                    if let Some(seq) = msg.get("seq").and_then(|v| v.as_i64()) {
                        let cmd_name = msg.get("command")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        let _ = msg_tx_r.send(serde_json::json!({
                            "seq": 0,
                            "type": "response",
                            "request_seq": seq,
                            "success": true,
                            "command": cmd_name,
                            "body": null,
                        }));
                    }
                }
                _ => {}
            }
        }
    });

    state.0.lock().unwrap().insert(session_id, DapSession {
        msg_tx,
        seq_counter,
        pending,
        _child: child,
    });

    Ok(())
}

#[tauri::command]
pub async fn dap_request(
    session_id: String,
    command: String,
    arguments: serde_json::Value,
    state: tauri::State<'_, DapState>,
) -> Result<serde_json::Value, String> {
    let (tx, rx) = oneshot::channel();
    let (seq, msg_tx) = {
        let guard = state.0.lock().unwrap();
        let session = guard
            .get(&session_id)
            .ok_or_else(|| format!("DAP session '{}' not running", session_id))?;
        let seq = session.seq_counter.fetch_add(1, Ordering::Relaxed);
        session.pending.lock().unwrap().insert(seq, tx);
        (seq, session.msg_tx.clone())
    };
    msg_tx
        .send(serde_json::json!({
            "seq":       seq,
            "type":      "request",
            "command":   command,
            "arguments": arguments,
        }))
        .map_err(|e| e.to_string())?;

    // 30s timeout — launch/attach requests can take several seconds
    tokio::time::timeout(std::time::Duration::from_secs(30), rx)
        .await
        .map_err(|_| format!("DAP request '{}' timed out", command))?
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn dap_stop(
    session_id: String,
    state: tauri::State<'_, DapState>,
) -> Result<(), String> {
    state.0.lock().unwrap().remove(&session_id);
    Ok(())
}
