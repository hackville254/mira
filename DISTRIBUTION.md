# Distribution de Mira

Ce document décrit **comment Mira est distribué** et **ce que l'utilisateur doit
faire pour ouvrir l'application** malgré les avertissements de sécurité des OS.

> Politique de signature (décision arrêtée) : **aucun certificat payant, aucun
> compte Apple Developer, aucune notarisation, aucun code-signing Windows.**
> Les builds sont publiés tels quels. La **seule** signature conservée est celle
> de l'**updater Tauri** (minisign) — indispensable à l'auto-update.

---

## 1. Canaux de distribution

| Canal | Plateformes | Artefacts | Mises à jour |
|---|---|---|---|
| **GitHub Releases** (principal) | macOS (Apple Silicon + Intel), Windows (hors Store), Linux | `.dmg`, `.app.tar.gz`, `*-setup.exe`/`.msi`, `.AppImage`/`.deb`/`.rpm` | **Auto-update Tauri** (`tauri-plugin-updater`) |
| **Microsoft Store** (séparé) | Windows | `.msix` | Géré par le **Store** (updater Tauri **désactivé** via la feature Rust `msstore`) |

Le canal Store n'utilise **pas** le manifeste `latest.json` ni les secrets
d'updater. Voir `.github/workflows/windows-msix.yml`.

macOS est buildé en **deux paquets distincts** : Apple Silicon (`aarch64`) et
Intel (`x86_64`). Chacun a son `.dmg` et son archive de MAJ
(`Mira_<version>_<arch>.app.tar.gz`) — l'utilisateur choisit selon son Mac
(voir la page Téléchargement du site, qui détecte le système).

---

## 2. Ouvrir l'application malgré les avertissements

### macOS — Gatekeeper

Le `.app` est **signé « ad-hoc »** (`APPLE_SIGNING_IDENTITY="-"`), ce qui suffit
à éviter l'erreur *« application endommagée »* mais **pas** l'avertissement
*« développeur non identifié »*, car l'app **n'est pas notariée**. Téléchargez le
`.dmg` correspondant à votre Mac (Apple Silicon ou Intel).

**Méthode 1 — Clic droit (recommandée) :**
1. Glisser `Mira.app` dans `/Applications`.
2. **Clic droit** (ou Ctrl + clic) sur l'icône → **Ouvrir**.
3. Dans la boîte de dialogue, cliquer de nouveau sur **Ouvrir**.
   (Après la 1ʳᵉ fois, l'app s'ouvre normalement par double-clic.)

**Méthode 2 — Retirer la quarantaine (Terminal) :**

```bash
xattr -dr com.apple.quarantine /Applications/Mira.app
```

### Windows — SmartScreen

Les installeurs Windows (`.exe` NSIS, `.msi`) ne sont **pas signés** (aucun
certificat). Windows Defender SmartScreen affiche donc un avertissement
*« Windows a protégé votre PC »*.

1. Lancer l'installeur `Mira_<version>_x64-setup.exe` (ou le `.msi`).
2. Cliquer sur **Informations supplémentaires**.
3. Cliquer sur **Exécuter quand même**.

C'est une conséquence directe et acceptée de la politique « zéro certificat ».

### Linux

Aucun avertissement de ce type. AppImage : rendre le fichier exécutable
(`chmod +x Mira*.AppImage`) puis le lancer.

---

## 3. Auto-update (canal GitHub Releases)

- L'app interroge :
  `https://github.com/hackville254/mira/releases/latest/download/latest.json`
- Le manifeste `latest.json` (généré par `scripts/gen-latest-json.py`, voir
  `.github/workflows/release.yml`) déclare une entrée par plateforme au format
  `OS-ARCH` :
  `darwin-aarch64`, `darwin-x86_64`, `windows-x86_64`, `linux-x86_64`.
- Chaque entrée porte le **contenu de la signature minisign** (`.sig`) et l'URL
  de l'archive de MAJ. Tauri **valide tout le fichier** avant de comparer les
  versions ; un manifeste incomplet est ignoré silencieusement (l'app se croit
  « à jour »). Le script de génération échoue donc explicitement si une
  plateforme manque.

> ⚠️ Une release en **`draft`** n'est **pas** « latest » : l'updater ne la voit
> jamais. Le workflow publie donc en **non-draft** (`draft: false`).

**Signature de l'updater** (obligatoire) : deux secrets GitHub à définir :

| Secret | Rôle |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | Clé privée minisign (contenu ou chemin) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Mot de passe de la clé |

Le `pubkey` public correspondant est déjà dans `src-tauri/tauri.conf.json`.
**Il doit rester synchronisé avec `TAURI_SIGNING_PRIVATE_KEY`** : si l'un des
deux est régénéré sans l'autre, toutes les installations existantes cessent de
recevoir les mises à jour (la signature du manifeste ne correspond plus).

> ⚠️ **Perte de clé = fin de l'auto-update** pour les installations existantes.
> La clé privée **doit** être sauvegardée hors CI (gestionnaire de secrets /
> coffre d'équipe). Une copie locale existe dans `~/.tauri/mira_updater.key`
> (+ `.key.pub`) — jamais committée (exclue par `.gitignore`). Si elle est
> réellement perdue, il faut **régénérer la paire, mettre à jour `pubkey` et
> republier** : les anciennes installations devront alors être réinstallées
> manuellement (elles ne pourront pas se mettre à jour seules vers la nouvelle
> clé).

---

## 4. Basculer un jour vers une vraie signature Apple / Windows

> **À lire en préparation future — NON implémenté aujourd'hui.** Quand les
> comptes seront disponibles, voici les étapes (aucune n'est active tant que les
> secrets correspondants ne sont pas créés).

### 4.1 macOS — signature Developer ID + notarisation

1. Obtenir un compte **Apple Developer** ($99/an) et le certificat
   **« Developer ID Application »**.
2. Créer un **App-Specific Password** (Apple ID) ou une **API key** App Store
   Connect pour la notarisation.
3. Ajouter les secrets GitHub :
   - `APPLE_CERTIFICATE` (`.p12` encodé base64)
   - `APPLE_CERTIFICATE_PASSWORD`
   - `APPLE_SIGNING_IDENTITY` (remplacer `"-"` par le nom du certificat)
   - `APPLE_ID`, `APPLE_PASSWORD` (ou `APPLE_API_KEY` / `APPLE_API_ISSUER`)
4. Dans `release.yml`, retirer `APPLE_SIGNING_IDENTITY: "-"` et laisser Tauri
   détecter le certificat ; Tauri **notarise et staple automatiquement** dès que
   `APPLE_ID`/`APPLE_PASSWORD` (ou API key) sont présents.

### 4.2 Windows — code-signing Authenticode

1. Obtenir un certificat **EV/OV Code Signing** (CA commerciale).
2. Ajouter les secrets GitHub (ex.) :
   - `WINDOWS_CERTIFICATE` (`.pfx` base64)
   - `WINDOWS_CERTIFICATE_PASSWORD`
3. Dans `release.yml`, renseigner `bundle.windows.certificateThumbprint` (ou
   `signCommand`) et `digestAlgorithm`/`timestampUrl` dans `tauri.conf.json`.
   Tauri signera alors `.exe`/`.msi` ; SmartScreen cessera d'avertir après
   capitalisation de réputation.

> Ces bascules ne touchent **pas** le `pubkey` de l'updater : la signature
> minisign reste la même.
