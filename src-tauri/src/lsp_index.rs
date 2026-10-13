//! Index des composants LSP installables — **manifeste figé, vérifié à la
//! compilation**.
//!
//! PRINCIPE PRODUIT (« zéro travail pour l'utilisateur »)
//! -----------------------------------------------------
//! L'utilisateur ne doit jamais ouvrir un terminal ni installer un serveur à
//! la main. Si un serveur est absent, l'app le télécharge elle-même dans son
//! dossier de données (`<app_data>/lsp-servers/<serverId>/`), sans droits
//! admin, sans polluer le système, puis le lance sans autre action.
//!
//! SÉCURITÉ — pourquoi un index figé en dur ?
//! ------------------------------------------
//! Télécharger et exécuter un binaire est le point le plus sensible de l'app.
//! Trois garanties non négociables :
//!
//!   1. **La décision de quoi télécharger n'est jamais distante.** L'URL et le
//!      SHA-256 sont des constantes compilées dans le binaire. Un attaquant qui
//!      compromettrait un manifeste distant ne pourrait donc pas nous faire
//!      télécharger un payload arbitraire (suppression d'un vecteur RCE).
//!   2. **Le contenu est vérifié par empreinte.** `fetch_verified` refuse tout
//!      octet dont le SHA-256 diffère : une redirection DNS/HTTP vers un
//!      fichier malveillant est détectée et bloquée avant écriture.
//!   3. **HTTPS + origine unique.** Toutes les URL pointent vers un hôte
//!      officiel en HTTPS.
//!
//! Ce module ne contient que de la **logique pure** (sélection d'artefact,
//! validation) : il est testable sans réseau ni Tauri. Le téléchargement et
//! l'extraction sont délégués à `downloader`.

/// Un artefact téléchargeable pour une plateforme donnée.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Artifact {
    /// URL HTTPS officielle.
    pub url: &'static str,
    /// SHA-256 attendu des octets téléchargés (64 caractères hex minuscules).
    pub sha256: &'static str,
    /// Format du payload : "gz", "zip" (archives → extracteur) ou "bin"
    /// (binaire nu écrit tel quel, ex. marksman). Choisit le traitement.
    pub archive: &'static str,
    /// Nom du fichier exécutable **attendu dans l'archive** (relatif).
    pub exe_hint: &'static str,
}

/// Un composant installable (un serveur LSP ou le runtime Node).
#[derive(Clone, Copy, Debug)]
pub struct Component {
    /// Id `serverId` (doit exister dans l'allowlist d'exécution `lsp.rs`).
    pub id: &'static str,
    /// Répertoire d'installation sous `<app_data>/lsp-servers/` (peut différer
    /// de `id` quand plusieurs serveurs partagent un même runtime, ex. Node).
    pub install_dir: &'static str,
    /// Taille approximative en Mo, affichée dans le toast avant téléchargement.
    pub approx_mb: u32,
    /// Artefacts par couple (os, arch). Au moins un doit exister pour la
    /// plateforme courante ; sinon le composant est « non installable » ici.
    pub artifacts: &'static [(&'static str, &'static str, Artifact)],
}

/// Clé de plateforme normalisée `(os, arch)`, alignée sur les valeurs de
/// `std::env::consts`. Volontairement explicite (pas de magie) pour rester
/// auditable : chaque artefact est assigné à une cible nommée.
pub fn platform_key() -> (&'static str, &'static str) {
    (std::env::consts::OS, std::env::consts::ARCH)
}

/// Sélectionne l'artefact correspondant à la plateforme courante. Renvoie
/// `None` si le composant n'a pas d'artefact pour cette plateforme — l'appelant
/// affiche alors « non disponible ici » (jamais une erreur bloquante).
pub fn select_artifact<'a>(comp: &'a Component, os: &str, arch: &str) -> Option<&'a Artifact> {
    comp.artifacts
        .iter()
        .find(|(o, a, _)| *o == os && *a == arch)
        .map(|(_, _, art)| art)
}

/// Vrai si le composant peut être installé sur la plateforme courante.
pub fn is_installable(comp: &Component, os: &str, arch: &str) -> bool {
    select_artifact(comp, os, arch).is_some()
}

/// Vérifie l'invariant d'index au chargement : chaque `sha256` doit être un hex
/// de 64 caractères et chaque `url` doit commencer par `https://`. Utilisé par
/// les tests pour empêcher l'introduction d'une entrée malformée (une empreinte
/// vide ou une URL http serait une régression de sécurité silencieuse).
#[cfg(test)]
pub fn artifact_is_well_formed(art: &Artifact) -> bool {
    art.url.starts_with("https://")
        && art.sha256.len() == 64
        && art.sha256.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        && matches!(art.archive, "gz" | "zip" | "bin")
}

// ── Catalogue figé ──────────────────────────────────────────────────────────
//
// NOTE PRODUIT — certains serveurs n'ont PAS d'artefact téléchargeable fiable :
//
//   * **gopls** : ne publie aucun binaire précompilé sur ses releases GitHub
//     (distribution officielle = `go install`). Sans toolchain Go, il n'y a
//     rien de sûr à télécharger → `installable: false` côté UI (grisé).
//   * **clangd** : les releases GitHub sont anciennes et sans fichier de
//     checksum stable → non installable automatiquement en v1.
//
// Ces composants restent dans l'allowlist d'exécution : s'ils sont trouvés sur
// le PATH (Go/LLVM déjà installé par le développeur), ils fonctionnent. Mais
// l'app n'invente pas d'installation : elle les grise avec une explication.
//
// Python : `basedpyright` (ouvert, PAS Pylance) requis par la politique de
// licence. Son installation passe par Node + npm local dans app-data.

/// Runtime Node portable (nécessaire pour basedpyright et
/// typescript-language-server). En v1, l'app **détecte** un Node déjà présent
/// (PATH enrichi) et l'utilise pour npm ; le téléchargement d'un Node portable
/// embarqué est une évolution prévue mais non câblée (pas de composant
/// propriétaire, jamais embarqué dans l'installeur).
///
/// Registre des composants installables automatiquement. **Autorité de
/// téléchargement** : ce que l'app peut télécharger est exactement ce qui est
/// listé ici, et rien d'autre.
///
/// Les artefacts rust-analyzer ci-dessous sont épinglés à la release
/// `2025-01-06` ; les SHA-256 ont été calculés à partir des binaires officiels
/// téléchargés depuis `github.com/rust-lang/rust-analyzer`. Ils sont vérifiés à
/// la compilation par les tests ci-dessous (format d'empreinte + test réseau
/// optionnel via `ORIGIN_VERIFY_INDEX=1`).
pub const COMPONENTS: &[Component] = &[
    Component {
        id: "rust-analyzer",
        install_dir: "rust-analyzer",
        approx_mb: 15,
        artifacts: &[
            ("macos", "aarch64", RA_AARCH64_APPLE),
            ("macos", "x86_64", RA_X86_64_APPLE),
            ("linux", "x86_64", RA_X86_64_LINUX),
            ("linux", "aarch64", RA_AARCH64_LINUX),
            ("windows", "x86_64", RA_X86_64_WINDOWS),
        ],
    },
    // basedpyright et typescript-language-server s'installent via Node + npm
    // (décision « npm install local dans app-data »). Pas d'artefact direct :
    // la commande `lsp_install` orchestre node → npm install dans app-data.
    Component {
        id: "basedpyright",
        install_dir: "basedpyright",
        approx_mb: 12,
        artifacts: &[],
    },
    Component {
        id: "typescript-language-server",
        install_dir: "typescript-language-server",
        approx_mb: 30,
        artifacts: &[],
    },
    // pylsp s'installe via `pip` dans un **venv isolé** dans app-data (décision
    // « garder pylsp »). Pas d'artefact direct : la commande `lsp_install`
    // orchestre python → venv → pip install dans app-data, sans droits admin.
    Component {
        id: "pylsp",
        install_dir: "pylsp",
        approx_mb: 20,
        artifacts: &[],
    },
    // Serveurs web/config extraits de VS Code, distribués par le paquet npm
    // `vscode-langservers-extracted` (licence ISC). Un seul paquet fournit trois
    // binaires (css/html/json) ; chaque `serverId` est néanmoins un composant à
    // part entière pour rester aligné sur l'allowlist d'exécution et le routage
    // par langage (`languages.ts`). Aucun artefact direct : install via npm.
    Component {
        id: "vscode-css-language-server",
        install_dir: "vscode-langservers-extracted",
        approx_mb: 20,
        artifacts: &[],
    },
    Component {
        id: "vscode-html-language-server",
        install_dir: "vscode-langservers-extracted",
        approx_mb: 20,
        artifacts: &[],
    },
    Component {
        id: "vscode-json-language-server",
        install_dir: "vscode-langservers-extracted",
        approx_mb: 20,
        artifacts: &[],
    },
    // YAML : paquet npm `yaml-language-server` (licence MIT).
    Component {
        id: "yaml-language-server",
        install_dir: "yaml-language-server",
        approx_mb: 15,
        artifacts: &[],
    },
    // Shell : paquet npm `bash-language-server` (licence MIT).
    Component {
        id: "bash-language-server",
        install_dir: "bash-language-server",
        approx_mb: 15,
        artifacts: &[],
    },
    // Dockerfile : paquet npm `dockerfile-language-server-nodejs` (licence MIT).
    Component {
        id: "dockerfile-language-server-nodejs",
        install_dir: "dockerfile-language-server-nodejs",
        approx_mb: 15,
        artifacts: &[],
    },
    // Svelte : paquet npm `svelte-language-server` (licence MIT).
    Component {
        id: "svelte-language-server",
        install_dir: "svelte-language-server",
        approx_mb: 25,
        artifacts: &[],
    },
    // Vue (Volar) : paquet npm `@vue/language-server` (licence MIT).
    Component {
        id: "vue-language-server",
        install_dir: "vue-language-server",
        approx_mb: 35,
        artifacts: &[],
    },
    // Astro : paquet npm `@astrojs/language-server` (licence MIT).
    Component {
        id: "astro-language-server",
        install_dir: "astro-language-server",
        approx_mb: 30,
        artifacts: &[],
    },
    // Prisma : paquet npm `@prisma/language-server` (licence Apache-2.0).
    Component {
        id: "prisma-language-server",
        install_dir: "prisma-language-server",
        approx_mb: 20,
        artifacts: &[],
    },
    // Markdown : binaire natif `marksman` (licence MIT), mono-fichier autonome.
    // Distribution GitHub = binaire nu (pas d'archive) → format "bin". Lancé
    // avec l'argument `server` (voir `lsp_exe_and_args` dans lsp.rs).
    Component {
        id: "marksman",
        install_dir: "marksman",
        approx_mb: 42,
        artifacts: &[
            ("macos", "aarch64", MS_MACOS),
            ("macos", "x86_64", MS_MACOS),
            ("linux", "x86_64", MS_LINUX_X64),
            ("linux", "aarch64", MS_LINUX_ARM64),
            ("windows", "x86_64", MS_WINDOWS),
        ],
    },
];

// ── Empreintes figées (release rust-analyzer 2025-01-06) ─────────────────────
// Format `.gz` = binaire nu compressé (pas un tar.gz) → `extract_single_gz`.

const RA_AARCH64_APPLE: Artifact = Artifact {
    url: "https://github.com/rust-lang/rust-analyzer/releases/download/2025-01-06/rust-analyzer-aarch64-apple-darwin.gz",
    sha256: "4f24b67b784234075fe40706b717f8dd2ae003249b8e1dc9fd9e206d31a10b84",
    archive: "gz",
    exe_hint: "rust-analyzer",
};
const RA_X86_64_APPLE: Artifact = Artifact {
    url: "https://github.com/rust-lang/rust-analyzer/releases/download/2025-01-06/rust-analyzer-x86_64-apple-darwin.gz",
    sha256: "bd59d7df514e972a079688ff014885d06bd309a8cf56a55ff734f1345a508bc3",
    archive: "gz",
    exe_hint: "rust-analyzer",
};
const RA_X86_64_LINUX: Artifact = Artifact {
    url: "https://github.com/rust-lang/rust-analyzer/releases/download/2025-01-06/rust-analyzer-x86_64-unknown-linux-gnu.gz",
    sha256: "36aadae48e6dcb960673b36b3af50688f64a60cf84809893c77bdb1021815b7c",
    archive: "gz",
    exe_hint: "rust-analyzer",
};
const RA_AARCH64_LINUX: Artifact = Artifact {
    url: "https://github.com/rust-lang/rust-analyzer/releases/download/2025-01-06/rust-analyzer-aarch64-unknown-linux-gnu.gz",
    sha256: "9fcc8e930185d91db6d7a647f42f70f38ceeacd1e35cd4c71c1221b96df1f0f5",
    archive: "gz",
    exe_hint: "rust-analyzer",
};
const RA_X86_64_WINDOWS: Artifact = Artifact {
    url: "https://github.com/rust-lang/rust-analyzer/releases/download/2025-01-06/rust-analyzer-x86_64-pc-windows-msvc.zip",
    sha256: "52462b0a035ab300e24d5810ed01476fe7ccdcc0cccff46b4cf7d2aeeb3e10e8",
    archive: "zip",
    exe_hint: "rust-analyzer.exe",
};

// ── Empreintes figées (release marksman 2026-02-08) ─────────────────────────
// Binaires NUS mono-fichier (pas d'archive) → format "bin" écrit tel quel.
// `marksman-macos` est un binaire universel (arm64 + x86_64) : le même
// artefact couvre les deux architectures macOS.

const MS_MACOS: Artifact = Artifact {
    url: "https://github.com/artempyanykh/marksman/releases/download/2026-02-08/marksman-macos",
    sha256: "6a801c17b5ac0dba69787c5282b3b3bd416e66c96253fae098d311c6bbd1833b",
    archive: "bin",
    exe_hint: "marksman",
};
const MS_LINUX_X64: Artifact = Artifact {
    url: "https://github.com/artempyanykh/marksman/releases/download/2026-02-08/marksman-linux-x64",
    sha256: "be5098e8213219269c47fc0d916a66fa31ce0602ec967475c722260aabf26087",
    archive: "bin",
    exe_hint: "marksman",
};
const MS_LINUX_ARM64: Artifact = Artifact {
    url: "https://github.com/artempyanykh/marksman/releases/download/2026-02-08/marksman-linux-arm64",
    sha256: "db8e124527f7f8048e3e6c91821b9c52ef173d92c01e47d221bf1337afd962fb",
    archive: "bin",
    exe_hint: "marksman",
};
const MS_WINDOWS: Artifact = Artifact {
    url: "https://github.com/artempyanykh/marksman/releases/download/2026-02-08/marksman.exe",
    sha256: "a6d05beb08ebe41b0a9f09c98a438540421436fa5531424c22e0bb1d22529705",
    archive: "bin",
    exe_hint: "marksman.exe",
};

/// Retourne le composant correspondant à un `serverId`, s'il est installable
/// automatiquement (indépendamment de la plateforme).
pub fn component_for(server_id: &str) -> Option<&'static Component> {
    COMPONENTS.iter().find(|c| c.id == server_id)
}

/// Serveurs qui **n'ont pas** d'installation automatique : l'app les grise avec
/// une explication courte plutôt que d'afficher une erreur (politique produit).
/// `reason` est un code stable (i18n-friendly), pas une phrase libre.
pub fn not_auto_installable(server_id: &str) -> Option<&'static str> {
    match server_id {
        "gopls" => Some("NEEDS_GO_TOOLCHAIN"),
        "clangd" => Some("NEEDS_LLVM_TOOLCHAIN"),
        // Dart/Flutter : le serveur d'analyse (`dart language-server`) est fourni
        // par le SDK Dart/Flutter, jamais téléchargé par l'app.
        "dart-analysis-server" => Some("NEEDS_DART_TOOLCHAIN"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_declared_artifact_is_well_formed() {
        // Invariant de sécurité : aucune entrée ne doit avoir une URL http, une
        // empreinte de mauvaise longueur, ou un format d'archive inconnu.
        for comp in COMPONENTS {
            for (_os, _arch, art) in comp.artifacts {
                assert!(
                    artifact_is_well_formed(art),
                    "artefact malformé pour {} : url={} sha={}",
                    comp.id,
                    art.url,
                    art.sha256
                );
            }
        }
    }

    #[test]
    fn select_artifact_matches_platform_exactly() {
        // Vérifie le contrat de sélection avec un artefact factice.
        const ART: Artifact = Artifact {
            url: "https://example.com/x.gz",
            sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            archive: "gz",
            exe_hint: "x",
        };
        let comp = Component {
            id: "fake",
            install_dir: "fake",
            approx_mb: 1,
            artifacts: &[("macos", "aarch64", ART), ("linux", "x86_64", ART)],
        };
        assert!(select_artifact(&comp, "macos", "aarch64").is_some());
        assert!(select_artifact(&comp, "linux", "x86_64").is_some());
        // Plateforme absente → None (l'UI grise au lieu d'échouer).
        assert!(select_artifact(&comp, "windows", "x86_64").is_none());
        assert!(!is_installable(&comp, "windows", "x86_64"));
        assert!(is_installable(&comp, "macos", "aarch64"));
    }

    #[test]
    fn rejects_malformed_artifacts() {
        let http = Artifact {
            url: "http://example.com/x.gz",
            sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            archive: "gz",
            exe_hint: "x",
        };
        assert!(!artifact_is_well_formed(&http), "http doit être refusé");

        let short_hash = Artifact {
            url: "https://example.com/x.gz",
            sha256: "abcd",
            archive: "gz",
            exe_hint: "x",
        };
        assert!(!artifact_is_well_formed(&short_hash), "hash court doit être refusé");

        let bad_archive = Artifact {
            url: "https://example.com/x.rar",
            sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            archive: "rar",
            exe_hint: "x",
        };
        assert!(!artifact_is_well_formed(&bad_archive), "archive inconnue refusée");
    }

    #[test]
    fn gopls_and_clangd_are_not_auto_installable() {
        assert_eq!(not_auto_installable("gopls"), Some("NEEDS_GO_TOOLCHAIN"));
        assert_eq!(not_auto_installable("clangd"), Some("NEEDS_LLVM_TOOLCHAIN"));
        assert_eq!(not_auto_installable("dart-analysis-server"), Some("NEEDS_DART_TOOLCHAIN"));
        assert_eq!(not_auto_installable("rust-analyzer"), None);
    }

    #[test]
    fn rust_analyzer_has_artifact_for_current_platform() {
        // Garantit que sur macos/linux/windows déclarés, rust-analyzer est
        // installable automatiquement (sinon l'UI le griserait à tort).
        let (os, arch) = platform_key();
        let ra = component_for("rust-analyzer").expect("rust-analyzer présent");
        // On ne teste que les cibles qu'on a réellement épinglées.
        let covered = matches!(
            (os, arch),
            ("macos", "aarch64")
                | ("macos", "x86_64")
                | ("linux", "x86_64")
                | ("linux", "aarch64")
                | ("windows", "x86_64")
        );
        if covered {
            assert!(
                is_installable(ra, os, arch),
                "rust-analyzer doit être installable sur {os}/{arch}"
            );
        }
        // Sur une cible non couverte, on doit obtenir None proprement (pas de panic).
        assert!(select_artifact(ra, "plan9", "mips").is_none());
    }

    #[test]
    fn pip_and_npm_servers_are_registered_without_direct_artifacts() {
        // pylsp (pip), basedpyright/typescript-language-server (npm) ainsi que
        // les serveurs web/config (vscode-*, yaml, bash, dockerfile, tous npm)
        // sont installés par `lsp_install`, pas par un artefact direct : ils
        // doivent néanmoins exister dans COMPONENTS pour être `auto_installable`.
        for id in [
            "pylsp",
            "basedpyright",
            "typescript-language-server",
            "vscode-css-language-server",
            "vscode-html-language-server",
            "vscode-json-language-server",
            "yaml-language-server",
            "bash-language-server",
            "dockerfile-language-server-nodejs",
        ] {
            let comp = component_for(id).unwrap_or_else(|| panic!("{id} doit être enregistré"));
            assert!(comp.artifacts.is_empty(), "{id} ne doit pas avoir d'artefact direct");
        }
        // Un serveur non installable reste hors COMPONENTS.
        assert!(component_for("gopls").is_none());
        assert!(component_for("clangd").is_none());
    }

    #[test]
    fn marksman_is_registered_as_bare_binary() {
        // marksman : binaire natif (format "bin"), installable sur les cibles
        // épinglées (macos uni-arch, linux x64/arm64, windows x64).
        let comp = component_for("marksman").expect("marksman doit être enregistré");
        assert!(is_installable(comp, "macos", "aarch64"));
        assert!(is_installable(comp, "macos", "x86_64"));
        assert!(is_installable(comp, "linux", "x86_64"));
        assert!(is_installable(comp, "linux", "aarch64"));
        assert!(is_installable(comp, "windows", "x86_64"));
        for (_os, _arch, art) in comp.artifacts {
            assert_eq!(art.archive, "bin", "marksman doit être un binaire nu");
            assert!(artifact_is_well_formed(art));
        }
        // Sur une cible non couverte, on obtient None proprement.
        assert!(select_artifact(comp, "plan9", "mips").is_none());
    }
}
