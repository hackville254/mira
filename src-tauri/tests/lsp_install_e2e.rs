//! Test d'intégration **réseau** (opt-in) : vérifie que l'index figé
//! (`lsp_index`) télécharge réellement, que l'empreinte SHA-256 correspond, et
//! que l'extraction `.gz` + `chmod +x` produisent un binaire exécutable.
//!
//! Désactivé par défaut (marqué `#[ignore]`) : on ne veut pas dépendre du réseau
//! dans la suite de tests normale. À lancer explicitement :
//!
//! ```sh
//! cargo test -p mira --test lsp_install_e2e -- --ignored --nocapture
//! ```
//!
//! Ce test est la preuve « conditions réelles » demandée par la politique
//! produit : un binaire réellement téléchargé et rendu exécutable dans un
//! dossier temporaire (jamais dans app-data pour ne rien polluer).

use std::path::PathBuf;

#[tokio::test]
#[ignore = "réseau : lancer avec --ignored"]
async fn downloads_and_extracts_rust_analyzer_for_current_platform() {
    let (os, arch) = mira_lib::lsp_index::platform_key();
    let comp = mira_lib::lsp_index::component_for("rust-analyzer").expect("composant présent");
    let artifact = match mira_lib::lsp_index::select_artifact(comp, os, arch) {
        Some(a) => a,
        None => {
            eprintln!("plateforme {os}/{arch} non couverte — test ignoré");
            return;
        }
    };

    eprintln!("téléchargement: {}", artifact.url);
    let bytes = mira_lib::downloader::fetch_verified(artifact.url, artifact.sha256)
        .await
        .expect("téléchargement + vérification SHA-256 doivent réussir");
    eprintln!("reçu {} octets (empreinte OK)", bytes.len());

    let dir: PathBuf = std::env::temp_dir().join(format!("mira_ra_e2e_{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);

    let exe_name = if cfg!(windows) { "rust-analyzer.exe" } else { "rust-analyzer" };
    let out = match artifact.archive {
        "gz" => mira_lib::downloader::extract_single_gz(&bytes, &dir, exe_name)
            .expect("extraction gz"),
        "zip" => {
            let files = mira_lib::downloader::extract_zip(&bytes, &dir).expect("extraction zip");
            let f = files
                .iter()
                .find(|p| p.file_name().map(|n| n == artifact.exe_hint).unwrap_or(false))
                .map(|p| dir.join(p))
                .expect("exe attendu présent dans le zip");
            mira_lib::downloader::make_executable(&f);
            f
        }
        other => panic!("archive inconnue: {other}"),
    };

    assert!(out.is_file(), "le binaire doit exister : {}", out.display());
    let size = std::fs::metadata(&out).unwrap().len();
    eprintln!("binaire extrait: {} ({} octets)", out.display(), size);
    assert!(size > 1_000_000, "un binaire rust-analyzer fait plusieurs Mo");

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&out).unwrap().permissions().mode();
        assert_eq!(mode & 0o111, 0o111, "doit être exécutable (chmod +x)");

        // Exécute réellement `rust-analyzer --version` : preuve que le binaire
        // téléchargé est fonctionnel et lanceable sans action manuelle.
        let output = std::process::Command::new(&out)
            .arg("--version")
            .output()
            .expect("exécution du binaire téléchargé");
        let stdout = String::from_utf8_lossy(&output.stdout);
        eprintln!("rust-analyzer --version → {}", stdout.trim());
        assert!(output.status.success(), "le binaire doit s'exécuter");
        assert!(
            stdout.contains("rust-analyzer"),
            "sortie inattendue : {stdout}"
        );
    }

    let _ = std::fs::remove_dir_all(&dir);
}
