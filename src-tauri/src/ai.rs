use std::collections::HashMap;

// Hosts the renderer is allowed to reach through the streaming proxy. This must
// stay in sync with `OPENAI_COMPAT_BASE` / the UI provider catalog: a provider
// offered in the picker but absent here fails at runtime with "host not allowed".
// Loopback hosts are intentional — they serve local LLM runtimes (Ollama,
// LM Studio, vLLM).
const PROXY_ALLOW_HOSTS: &[&str] = &[
    "api.anthropic.com",
    "api.openai.com",
    "generativelanguage.googleapis.com",
    "openrouter.ai",
    "api.mistral.ai",
    "api.deepseek.com",
    "api.groq.com",
    "api.x.ai",
    "api.cohere.com",
    "api.orvyx-ai.com",
    "127.0.0.1",
    "localhost",
];

#[derive(serde::Serialize)]
pub struct BashResult {
    stdout:    String,
    stderr:    String,
    exit_code: i32,
    /// `true` si la commande a été tuée faute d'avoir terminé dans le délai.
    timed_out: bool,
    /// `true` si stdout/stderr ont été tronqués au plafond de sortie.
    truncated: bool,
}

/// Durée maximale d'exécution d'une commande agent. Au-delà, le process est tué
/// (avec ses enfants sur Unix via le groupe de process). Bornage anti-DoS :
/// sans plafond, `while true; do :; done` bloquerait un slot de l'exécuteur et
/// ferait grossir le buffer de sortie sans limite.
const BASH_TIMEOUT_SECS: u64 = 120;

/// Taille maximale (par flux) renvoyée au front. Au-delà, on coupe : la sortie
/// d'un `find /` ou d'un `yes` ne doit pas saturer la fenêtre de contexte du
/// modèle ni la mémoire de la webview.
const BASH_MAX_OUTPUT_BYTES: usize = 64 * 1024; // 64 Ko

/// Tronque proprement une sortie octale au plafond et signale la troncature.
fn truncate_output(bytes: &[u8]) -> (String, bool) {
    if bytes.len() <= BASH_MAX_OUTPUT_BYTES {
        return (String::from_utf8_lossy(bytes).into_owned(), false);
    }
    // `from_utf8_lossy` sur le préfixe : les caractères multi-octets coupés en
    // fin de tranche sont remplacés par U+FFFD, sans paniquer.
    let mut s = String::from_utf8_lossy(&bytes[..BASH_MAX_OUTPUT_BYTES]).into_owned();
    s.push_str("\n… [output truncated]");
    (s, true)
}

#[tauri::command]
pub async fn agent_bash_run(command: String, cwd: String) -> Result<BashResult, String> {
    // Reject empty or non-existent working directories
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

    // `tokio::process::Command` (et non std) : il expose `kill_on_drop`, donc si
    // le timeout expire et que le `Child` est abandonné, le process est tué au
    // lieu de fuir en arrière-plan. `std::process::Command::output()` bloquerait
    // pour toujours et le timeout ne pourrait rien interrompre.
    let mut cmd = tokio::process::Command::new(&shell);
    cmd.args([flag, &command])
        .current_dir(&cwd)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.as_std_mut().creation_flags(0x08000000);
    }

    // `wait_with_output(self)` prend possession du child : si le `timeout`
    // expire, son future est droppé et le `Child` interne l'est aussi, ce qui
    // déclenche `kill_on_drop` → process tué. Le process ne peut donc pas fuir.
    let child = cmd.spawn().map_err(|e| e.to_string())?;

    match tokio::time::timeout(
        std::time::Duration::from_secs(BASH_TIMEOUT_SECS),
        child.wait_with_output(),
    )
    .await
    {
        Ok(res) => {
            let out = res.map_err(|e| e.to_string())?;
            let (stdout, t1) = truncate_output(&out.stdout);
            let (stderr, t2) = truncate_output(&out.stderr);
            Ok(BashResult {
                stdout,
                stderr,
                exit_code: out.status.code().unwrap_or(-1),
                timed_out: false,
                truncated: t1 || t2,
            })
        }
        Err(_elapsed) => {
            // `child` est droppé ici → kill_on_drop tue le process.
            Err(format!(
                "command timed out after {BASH_TIMEOUT_SECS}s and was killed. Avoid long-running/interactive commands; if you need a server, start it detached (e.g. `nohup … &`) and poll it."
            ))
        }
    }
}

#[derive(serde::Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ProxyEvent {
    Status  { code: u16, headers: Vec<(String, String)> },
    Chunk   { bytes: Vec<u8> },
    Done,
    Error   { message: String },
}

/// Client HTTP partagé par TOUTES les requêtes du proxy de streaming.
///
/// Justification TTFT : `reqwest::Client` maintient un pool de connexions
/// (keep-alive) et donc le handshake TCP + TLS n'est payé QU'UNE fois par hôte.
/// Le construire par requête — comme avant — refaisait ce handshake à chaque
/// tour (TLS ≈ plusieurs centaines de ms) et, pire, entre chaque étape d'un même
/// tour d'agent. Un client `OnceLock` réutilise la connexion tant que le pool
/// n'a pas purgé son entrée.
///
/// Réglages et leur impact :
/// - `pool_idle_timeout(600s)` : le défaut reqwest est 90s, le défaut hyper 15s.
///   Le vrai risque venait de l'entrée idle purgée entre deux tours espacés. On
///   garde la connexion 10 min, largement au-delà d'une pause utilisateur
///   normale, sans fuite de sockets (le pool reste borné par `pool_max_idle_per_host`).
/// - `pool_max_idle_per_host(8)` : borne explicite (au lieu de `usize::MAX`) —
///   une poignée d'entrées idle par hôte suffit pour notre charge et empêche
///   un hôte compromis de faire gonfler le pool.
/// - `tcp_nodelay(true)` : désactive Nagle. Indispensable en SSE : avec Nagle, un
///   petit `text-delta` peut être retenu pour être coalescé avec le suivant,
///   ce qui ajoute directement au TTFT et au débit perçu du stream.
/// - `tcp_keepalive(60s)` : détecte une connexion morte (NAT, veille) et évite
///   qu'elle soit réutilisée pour un tour qui pendrait.
///
/// Le flag `ring` n'est pas touché : on reste sur la config TLS par défaut de
/// reqwest, seule la couche transport est réglée.
static AI_HTTP_CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();

fn ai_http_client() -> &'static reqwest::Client {
    AI_HTTP_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(15))
            .pool_idle_timeout(std::time::Duration::from_secs(600))
            .pool_max_idle_per_host(8)
            .tcp_nodelay(true)
            .tcp_keepalive(std::time::Duration::from_secs(60))
            .build()
            // Un échec de construction ici est un bug de config TLS, pas une
            // erreur utilisateur : on le remonte explicitement plutôt que de
            // masquer le problème.
            .expect("failed to build shared AI HTTP client")
    })
}

#[tauri::command]
pub async fn ai_stream_proxy(
    url: String,
    method: String,
    headers: HashMap<String, String>,
    body: Option<String>,
    channel: tauri::ipc::Channel<ProxyEvent>,
) -> Result<(), String> {
    // Validate host against allowlist to prevent SSRF
    let parsed = reqwest::Url::parse(&url).map_err(|e| format!("invalid URL: {e}"))?;
    let host = parsed.host_str().unwrap_or("");
    if !PROXY_ALLOW_HOSTS.iter().any(|&allowed| host == allowed) {
        return Err(format!("host not allowed: {host}"));
    }

    // Client partagé : la connexion est réutilisée d'un tour à l'autre (voir
    // `ai_http_client`). On tombe sur une connexion déjà ouverte quand le pool
    // n'a pas encore purgé, ce qui retire le handshake TLS du chemin TTFT.
    let client = ai_http_client();

    let method_val = reqwest::Method::from_bytes(method.as_bytes())
        .map_err(|e| e.to_string())?;

    let mut req = client.request(method_val, &url);
    for (k, v) in &headers {
        req = req.header(k, v);
    }
    if let Some(b) = body {
        req = req.body(b);
    }

    tokio::spawn(async move {
        let resp = match req.send().await {
            Ok(r) => r,
            Err(e) => { let _ = channel.send(ProxyEvent::Error { message: e.to_string() }); return; }
        };

        let code = resp.status().as_u16();
        let resp_headers: Vec<(String, String)> = resp.headers().iter()
            .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
            .collect();
        let _ = channel.send(ProxyEvent::Status { code, headers: resp_headers });

        let mut stream = resp;
        loop {
            match stream.chunk().await {
                Ok(Some(chunk)) => { let _ = channel.send(ProxyEvent::Chunk { bytes: chunk.to_vec() }); }
                Ok(None)        => { let _ = channel.send(ProxyEvent::Done); break; }
                Err(e)          => { let _ = channel.send(ProxyEvent::Error { message: e.to_string() }); break; }
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn fetch_text(url: String) -> Result<String, String> {
    let parsed = reqwest::Url::parse(&url).map_err(|e| format!("invalid URL: {e}"))?;
    let host = parsed.host_str().unwrap_or("");
    if !PROXY_ALLOW_HOSTS.iter().any(|&allowed| host == allowed) {
        return Err(format!("host not allowed: {host}"));
    }
    // Client partagé : même pool/keep-alive que le proxy de streaming, ce qui
    // évite un handshake TLS à chaque fetch ponctuel (ex. récupération de
    // modèles, doc). `ai_stream_proxy` l'utilise déjà.
    let client = ai_http_client();
    let resp = client
        .get(&url)
        .header("User-Agent", "mira-ide/1.0")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status().as_u16()));
    }
    resp.text().await.map_err(|e| e.to_string())
}
