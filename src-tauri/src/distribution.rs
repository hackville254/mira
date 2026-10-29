//! Canal de distribution et politique de mise à jour.
//!
//! POURQUOI CE MODULE
//! ------------------
//! Mira est distribué par deux canaux qui gèrent les mises à jour de façon
//! INCOMPATIBLE :
//!
//!   1. **Distribution directe** (GitHub Releases) — macOS (.dmg/.app), Linux
//!      (.AppImage/.deb/.rpm) et Windows hors Store (.exe NSIS/.msi). L'app
//!      doit vérifier et installer les mises à jour elle-même via
//!      `tauri-plugin-updater`.
//!
//!   2. **Microsoft Store** (MSIX) — c'est **Windows Store qui possède la mise
//!      à jour**. Si l'app embarque l'updater Tauri en parallèle, deux
//!      mécanismes se disputent les fichiers du paquet (mis à jour par le
//!      Store, réécrits par l'updater), ce qui casse l'installation et viole
//!      la politique Store. L'updater doit donc être **absent**.
//!
//! Le choix est fait **à la compilation** via la feature Cargo `msstore`
//! (voir `Cargo.toml`) : impossible de se tromper au runtime, et le binaire
//! Store n'embarque même pas le code de vérification.
//!
//! Le frontend lit ce canal via la commande `distribution_channel` pour
//! masquer le bouton « Rechercher une mise à jour » quand c'est le Store qui
//! gère tout (sinon on afficherait un bouton qui ne peut rien faire).

/// Canal de distribution compilé dans ce binaire.
///
/// `MicrosoftStore` n'est construit que dans les builds `--features msstore` ;
/// dans les autres il est toléré comme variante « morte » (l'enum reste complet
/// pour que le contrat IPC `distribution_channel` côté frontend soit identique
/// quel que soit le canal).
#[derive(serde::Serialize)]
#[serde(rename_all = "snake_case")]
#[allow(dead_code)]
pub enum DistributionChannel {
    /// Build direct (GitHub Releases) : l'updater Tauri est actif.
    Direct,
    /// Build Microsoft Store (MSIX) : l'updater Tauri est désactivé.
    MicrosoftStore,
}

/// Indique au frontend quel canal gère les mises à jour.
#[tauri::command]
pub fn distribution_channel() -> DistributionChannel {
    #[cfg(feature = "msstore")]
    {
        DistributionChannel::MicrosoftStore
    }
    #[cfg(not(feature = "msstore"))]
    {
        DistributionChannel::Direct
    }
}
