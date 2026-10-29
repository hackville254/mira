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

USAGE
-----
    python3 scripts/gen-latest-json.py \
        --repo hackville254/mira --tag v0.1.4 --dist dist
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
        help="archis macOS servies par l'archive .app.tar.gz (build universel = les deux)",
    )
    parser.add_argument(
        "--linux-archs",
        default="x86_64",
        help="archis Linux servies par l'AppImage",
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
        archive = single("*.app.tar.gz", dist, "macOS (.app.tar.gz)")
        entry = {
            "signature": read_signature(archive),
            "url": f"https://github.com/{args.repo}/releases/download/{quote(args.tag, safe='')}/{quote(archive.name)}",
        }
        for arch in macos_archs:
            platforms[f"darwin-{arch}"] = entry

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

    if not platforms:
        fail("aucune plateforme déclarée : repasser --macos-archs / --linux-archs")

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
