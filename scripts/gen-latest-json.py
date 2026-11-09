#!/usr/bin/env python3
"""Génère le manifeste `latest.json` attendu par tauri-plugin-updater.

POURQUOI CE SCRIPT
------------------
`tauri build` produit les archives de mise à jour et leurs signatures `.sig`,
mais PAS le manifeste statique que l'updater interroge. Sans lui, l'endpoint
`.../releases/latest/download/latest.json` renvoie 404 et l'application conclut
silencieusement « à jour » : l'auto-update ne fonctionne jamais.

FORMAT (référence officielle : https://v2.tauri.app/plugin/updater/)
--------------------------------------------------------------------
    {
      "version": "0.1.4",
      "notes": "",
      "pub_date": "2026-10-29T12:00:00Z",
      "platforms": {
        "darwin-aarch64": { "signature": "<contenu du .sig>", "url": "<url>" },
        ...
      }
    }

Tauri valide TOUT le fichier avant de comparer les versions : chaque entrée de
`platforms` doit donc être complète et son URL doit être téléchargeable. D'où
les vérifications strictes ci-dessous (échec explicite plutôt que manifeste
partiel et silencieusement inopérant).

ARCHIVE DE MAJ WINDOWS (source de vérité : doc updater Tauri v2)
----------------------------------------------------------------
Le nom de l'archive dépend de `bundle.createUpdaterArtifacts` :
  - `true` (v2, valeur ici) : l'installeur NSIS `*-setup.exe` est réutilisé tel
    quel comme archive de MAJ (accompagné de sa signature `*.exe.sig`) ;
  - `"v1Compatible"` : Tauri produit en plus `*-setup.nsis.zip` + `*.nsis.zip.sig`.
Ce script accepte LES DEUX formes (préférence à `.nsis.zip` s'il existe) afin de
rester correct quel que soit le mode de bundling, sans coder en dur un nom.

ARCHIVES DE MAJ macOS (Intel + Apple Silicon séparés)
-----------------------------------------------------
Le workflow construit DEUX apps macOS distinctes (aarch64 et x86_64) au lieu
d'un build universel. Tauri nommerait les deux archives `Mira.app.tar.gz` (nom
sans arch ni version) : le workflow les renomme donc en
`Mira_<version>_<arch>.app.tar.gz` (+ `.sig`). Ce script associe chaque arch à
SON archive pour produire deux entrées `darwin-aarch64` / `darwin-x86_64`
indépendantes. Une seule archive non renommée (build universel hérité) reste
acceptée en repli pour ne pas casser les exécutions locales.

USAGE
-----
    python3 scripts/gen-latest-json.py \
        --repo hackville254/mira --tag v0.1.4 --dist dist

    # Désactiver une plateforme (non buildée) : passer la liste vide.
    python3 scripts/gen-latest-json.py --repo r/n --tag v0.1.4 --dist dist \
        --windows-archs ""
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import NoReturn
from urllib.parse import quote

# `v` initial toléré (accepté par l'updater), pré-release/build autorisés.
SEMVER_RE = re.compile(r"^v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$")
REPO_RE = re.compile(r"^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$")
ALLOWED_ARCHS = {"x86_64", "aarch64", "i686", "armv7"}


def fail(message: str) -> NoReturn:
    print(f"ERREUR: {message}", file=sys.stderr)
    sys.exit(1)


def single(pattern: str, dist: Path, label: str) -> Path:
    """Retourne l'unique fichier correspondant au motif, sinon échoue."""
    found = sorted(p for p in dist.glob(pattern) if p.is_file())
    if not found:
        fail(f"aucune archive {label} trouvée dans {dist} (motif: {pattern})")
    if len(found) > 1:
        names = ", ".join(p.name for p in found)
        fail(f"plusieurs archives {label} dans {dist} ({names}) : ambigu, garder une seule")
    return found[0]


def read_signature(archive: Path) -> str:
    """Lit le `.sig` associé. Le path/URL ne fonctionne pas : il faut le contenu."""
    sig_file = archive.with_name(archive.name + ".sig")
    if not sig_file.is_file():
        fail(f"signature manquante pour {archive.name} (attendu: {sig_file.name})")
    signature = sig_file.read_text(encoding="utf-8").strip()
    if not signature:
        fail(f"signature vide: {sig_file.name}")
    return signature


def windows_updater_archive(dist: Path) -> Path:
    """Localise l'archive de MAJ Windows produite par `tauri build`.

    Selon `bundle.createUpdaterArtifacts` :
      - `true` (v2)      → l'installeur NSIS `*-setup.exe` (réutilisé tel quel) ;
      - `"v1Compatible"` → `*-setup.nsis.zip`.
    On préfère `.nsis.zip` s'il est présent, sinon on retombe sur l'installeur
    `.exe`. Une ambiguïté (plusieurs candidats) est une erreur : mieux vaut
    échouer que publier un manifeste pointant vers la mauvaise archive.
    """
    zips = sorted(p for p in dist.glob("*.nsis.zip") if p.is_file())
    if len(zips) > 1:
        fail(f"plusieurs archives Windows .nsis.zip dans {dist}: {[p.name for p in zips]} : ambigu")
    if zips:
        return zips[0]

    # Installeur NSIS : `*-setup.exe`. On restreint à ce motif pour ne PAS
    # confondre avec un éventuel exécutable annexe (ex. `mira.exe`).
    exes = sorted(p for p in dist.glob("*-setup.exe") if p.is_file())
    if len(exes) > 1:
        fail(f"plusieurs installeurs Windows *-setup.exe dans {dist}: {[p.name for p in exes]} : ambigu")
    if not exes:
        fail(f"aucune archive de MAJ Windows trouvée dans {dist} (attendu: *.nsis.zip ou *-setup.exe)")
    return exes[0]


def macos_archive(dist: Path, arch: str) -> Path:
    """Localise l'archive de MAJ macOS `.app.tar.gz` d'une architecture donnée.

    Depuis la séparation Intel/Silicon, le workflow construit DEUX apps macOS
    distinctes et renomme leurs archives en `Mira_<version>_<arch>.app.tar.gz`
    (Tauri les nommerait toutes deux `Mira.app.tar.gz`, ce qui les ferait
    s'écraser). On cherche donc le fichier par nom d'arch : `aarch64` ou
    `x86_64`. L'échec est explicite (pas de repli ambigu).
    """
    pattern = f"*_{arch}.app.tar.gz"
    found = sorted(p for p in dist.glob(pattern) if p.is_file())
    if not found:
        # Repli : une seule archive .app.tar.gz non renommée (build universel
        # hérité ou exécution locale). On l'accepte uniquement si elle est
        # unique, pour ne jamais servir la mauvaise arch.
        legacy = sorted(p for p in dist.glob("*.app.tar.gz") if p.is_file())
        if len(legacy) == 1:
            return legacy[0]
        fail(f"aucune archive macOS {arch} trouvée dans {dist} (motif: {pattern})")
    if len(found) > 1:
        fail(f"plusieurs archives macOS {arch} dans {dist}: {[p.name for p in found]} : ambigu")
    return found[0]


def parse_archs(raw: str, label: str) -> list[str]:
    archs = [a.strip() for a in raw.split(",") if a.strip()]
    for arch in archs:
        if arch not in ALLOWED_ARCHS:
            fail(f"architecture {label} invalide: {arch} (autorisées: {sorted(ALLOWED_ARCHS)})")
    return archs


def main() -> None:
    parser = argparse.ArgumentParser(description="Génère latest.json pour tauri-plugin-updater")
    parser.add_argument("--repo", required=True, help="owner/nom, ex. hackville254/mira")
    parser.add_argument("--tag", required=True, help="tag de release, ex. v0.1.4")
    parser.add_argument("--dist", default="dist", help="dossier contenant les artefacts (défaut: dist)")
    parser.add_argument(
        "--config",
        default="src-tauri/tauri.conf.json",
        help="config Tauri, source de vérité de la version (défaut: src-tauri/tauri.conf.json)",
    )
    parser.add_argument(
        "--macos-archs",
        default="aarch64,x86_64",
        help="archis macOS : une archive .app.tar.gz DÉDIÉE par arch "
        "(Mira_<version>_<arch>.app.tar.gz). Par défaut les deux (Silicon + Intel).",
    )
    parser.add_argument(
        "--linux-archs",
        default="x86_64",
        help="archis Linux servies par l'AppImage",
    )
    parser.add_argument(
        "--windows-archs",
        default="x86_64",
        help="archis Windows servies par l'archive de MAJ (.nsis.zip ou *-setup.exe) ; "
        "passer une chaîne vide pour désactiver le canal Windows",
    )
    parser.add_argument("--notes", default="", help="notes de version")
    parser.add_argument("--out", default=None, help="sortie (défaut: <dist>/latest.json)")
    args = parser.parse_args()

    dist = Path(args.dist)
    if not dist.is_dir():
        fail(f"dossier introuvable: {dist}")
    if not REPO_RE.match(args.repo):
        fail(f"--repo invalide: {args.repo!r} (attendu owner/nom)")

    match = SEMVER_RE.match(args.tag)
    if not match:
        fail(f"--tag invalide: {args.tag!r} (attendu vX.Y.Z)")
    version = match.group(1)

    # La version publiée DOIT correspondre au binaire réellement construit :
    # sinon l'app se met à jour vers une version qui ne correspond pas au code.
    config_path = Path(args.config)
    if not config_path.is_file():
        fail(f"config introuvable: {config_path}")
    config_version = json.loads(config_path.read_text(encoding="utf-8")).get("version", "")
    config_match = SEMVER_RE.match(str(config_version))
    if not config_match:
        fail(f"version invalide dans {config_path}: {config_version!r}")
    if config_match.group(1) != version:
        fail(
            f"incohérence de version: tag={version} mais {config_path}={config_match.group(1)}. "
            "Incrémenter la version avant de taguer."
        )

    platforms: dict[str, dict[str, str]] = {}

    macos_archs = parse_archs(args.macos_archs, "macOS")
    if macos_archs:
        # Depuis la séparation Intel/Silicon, chaque arch a SA propre archive
        # `.app.tar.gz` + `.sig` (deux builds distincts). On localise l'archive
        # de chaque arch demandée via son nom `Mira_<version>_<arch>.app.tar.gz`.
        for arch in macos_archs:
            archive = macos_archive(dist, arch)
            platforms[f"darwin-{arch}"] = {
                "signature": read_signature(archive),
                "url": f"https://github.com/{args.repo}/releases/download/{quote(args.tag, safe='')}/{quote(archive.name)}",
            }

    linux_archs = parse_archs(args.linux_archs, "Linux")
    if linux_archs:
        # v2 / createUpdaterArtifacts=true : l'AppImage elle-même est l'archive de MAJ.
        archive = single("*.AppImage", dist, "Linux (.AppImage)")
        name = archive.name.lower()
        if "aarch64" in name or "arm64" in name:
            archive_arch = "aarch64"
        elif "amd64" in name or "x86_64" in name:
            archive_arch = "x86_64"
        else:
            fail(f"architecture indéterminable depuis le nom de fichier: {archive.name}")
        if archive_arch not in linux_archs:
            fail(f"AppImage {archive_arch} fournie mais --linux-archs={linux_archs}")
        platforms[f"linux-{archive_arch}"] = {
            "signature": read_signature(archive),
            "url": f"https://github.com/{args.repo}/releases/download/{quote(args.tag, safe='')}/{quote(archive.name)}",
        }

    windows_archs = parse_archs(args.windows_archs, "Windows")
    if windows_archs:
        # Clé Tauri v2 attendue : `windows-x86_64` (OS-ARCH). Vérifié dans la doc
        # officielle : https://v2.tauri.app/plugin/updater/ (§Static JSON File).
        archive = windows_updater_archive(dist)
        name = archive.name.lower()
        if "aarch64" in name or "arm64" in name:
            archive_arch = "aarch64"
        else:
            archive_arch = "x86_64"
        if archive_arch not in windows_archs:
            fail(f"archive Windows {archive_arch} fournie mais --windows-archs={windows_archs}")
        platforms[f"windows-{archive_arch}"] = {
            "signature": read_signature(archive),
            "url": f"https://github.com/{args.repo}/releases/download/{quote(args.tag, safe='')}/{quote(archive.name)}",
        }

    if not platforms:
        fail("aucune plateforme déclarée : repasser --macos-archs / --linux-archs / --windows-archs")

    manifest = {
        "version": version,
        "notes": args.notes,
        "pub_date": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "platforms": dict(sorted(platforms.items())),
    }

    out = Path(args.out) if args.out else dist / "latest.json"
    out.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"OK: {out} ({len(platforms)} plateforme(s): {', '.join(manifest['platforms'])})")


if __name__ == "__main__":
    main()
