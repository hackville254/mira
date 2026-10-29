#!/usr/bin/env bash
# Signature self-signed (gratuite) de Mira.app pour macOS.
# - Génère un certificat de signature de code "Mira Developer" dans le keychain local si absent.
# - Signe le .app (hardened runtime + entitlements) avec ce certificat.
#
# Limites documentées (à lire avant distribution publique) :
#   * Ce certificat n'est PAS approuvé par Apple. Gatekeeper refusera toujours
#     un .app quarantainé ; l'utilisateur doit faire "Clic droit > Ouvrir"
#     (ou xattr -dr com.apple.quarantine). Voir DISTRIBUTION.md.
#   * Intérêt principal vs adhoc : signature stable et identifiable
#     (Authority=Mira Developer), pas de message "application endommagée"
#     après mise à jour/re-signature, et updatable sans invalider les droits.
set -euo pipefail

CERT_NAME="${MIRA_SIGN_CERT:-Mira Developer}"
KEYCHAIN="${MIRA_KEYCHAIN:-$HOME/Library/Keychains/login.keychain-db}"
APP_PATH="${1:-}"

# Répertoires de Travail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENTITLEMENTS="$SCRIPT_DIR/../src-tauri/entitlements.plist"

print_usage() {
  echo "Usage: ./scripts/macos-sign.sh [path/to/Mira.app]"
  echo "  Certificat utilisé : \$MIRA_SIGN_CERT (défaut: '$CERT_NAME')"
  echo "  Optionnel : MIRA_KEYCHAIN (défaut: keychain de login)"
}

[ -z "$APP_PATH" ] && { print_usage; exit 1; }
[ -d "$APP_PATH" ] || { echo "ERREUR: '$APP_PATH' n'existe pas ou n'est pas un .app"; exit 1; }

# --- 1. Vérifier / créer le certificat ---
if ! security find-identity -v -p codesigning 2>/dev/null | grep -q "$CERT_NAME"; then
  echo "INFO: certificat '$CERT_NAME' introuvable. Création en cours..."

  WORKDIR=$(mktemp -d)
  trap 'rm -rf "$WORKDIR"' EXIT

  KEY="$WORKDIR/mira.key"
  CSR="$WORKDIR/mira.csr"
  CERT="$WORKDIR/mira.cer"
  P12="$WORKDIR/mira.p12"

  # RSA 4096 valable 10 ans — EKU Code Signing OBLIGATOIRE (policy Apple),
  # sinon find-identity -p codesigning renverra 0 identités valides.
  openssl req -x509 -newkey rsa:4096 -sha256 -days 3650 \
    -nodes -keyout "$KEY" -out "$CERT" \
    -subj "/CN=Mira Developer/O=Mira/OU=Mira Code Signing/C=FR" \
    -addext "keyUsage=digitalSignature,keyEncipherment" \
    -addext "extendedKeyUsage=1.3.6.1.5.5.7.3.3"

  # Chiffrement legacy + mot de passe non vide (MAC PKCS12 d'OpenSSL 3.6 incompat. avec `security` sinon)
  P12_PASS="mira-local"
  openssl pkcs12 -export -legacy -out "$P12" \
    -inkey "$KEY" -in "$CERT" -passout "pass:$P12_PASS"

  # Importer dans le keychain utilisateur
  security import "$P12" -k "$KEYCHAIN" -P "$P12_PASS" -T /usr/bin/codesign
  # Approuver codesign sans popup à chaque signature
  security set-key-partition-list -S apple-tool:,apple: -k "" "$KEYCHAIN" >/dev/null 2>&1 || true
  # Marquer comme "trusted" pour la signature de code (local, non Apple)
  security add-trusted-cert -r trustRoot -p codeSign -k "$KEYCHAIN" "$CERT"

  echo "OK: certificat '$CERT_NAME' créé dans $KEYCHAIN (valable 10 ans)."
fi

# Récupérer le hash exact pour éviter les collisions de noms de certificat
CERT_SHA1=$(security find-identity -v -p codesigning 2>/dev/null | grep "$CERT_NAME" | awk '{print $2}' | head -n1)
[ -n "$CERT_SHA1" ] || { echo "ERREUR: impossible de retrouver l'identité '$CERT_NAME'."; exit 1; }

echo "INFO: signature de '$APP_PATH' avec l'identité SHA-1 $CERT_SHA1"

codesign --force --deep --options runtime \
  --entitlements "$ENTITLEMENTS" \
  --sign "$CERT_SHA1" \
  --timestamp \
  "$APP_PATH"

# --- 2. Vérification ---
echo "=== Vérification signature ==="
codesign --verify --deep --strict "$APP_PATH" && echo "Signature valide."
codesign -dv --verbose=4 "$APP_PATH" 2>&1 | grep -i authority

echo "=== Gatekeeper (attendu: rejected sans notarisation Apple) ==="
spctl -a -vv "$APP_PATH" || true

# --- 3. Optionnel : regénérer le DMG depuis cette app SIGNÉE ---
# Important : le bundler Tauri (`--bundles dmg`) RECRÉE l'app (signée adhoc) ;
# il faut donc construire le DMG après la signature, ici, manuellement.
VERSION=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$APP_PATH/Contents/Info.plist" 2>/dev/null || echo "")
DMG_OUT="${MIRA_DMG_OUT:-$(dirname "$APP_PATH")/../dmg/Mira_${VERSION}_$(uname -m).dmg}"
if [ "${MIRA_BUILD_DMG:-0}" = "1" ]; then
  STAGE=$(mktemp -d)
  cp -a "$APP_PATH" "$STAGE/"
  codesign --verify --deep --strict "$STAGE/$(basename "$APP_PATH")" # l'app signée survit à la copie
  mkdir -p "$(dirname "$DMG_OUT")"
  rm -f "$DMG_OUT"
  hdiutil create -volname Mira -srcfolder "$STAGE" -format UDZO -fs APFS -o "$DMG_OUT"
  rm -rf "$STAGE"
  # Somme SHA-512 base64 attendue par l'updater Tauri (latest.json)
  openssl dgst -sha512 -binary "$DMG_OUT" | openssl base64 > "$DMG_OUT.sha512.b64"
  echo "OK: DMG régénéré → $DMG_OUT"
fi

echo "Terminé."
