#requires -Version 5.1
<#
.SYNOPSIS
  Empaquette la sortie de `tauri build` (installateur NSIS) en un paquet MSIX
  prêt à soumettre au Microsoft Store.

.DESCRIPTION
  Tauri ne sait pas produire de MSIX nativement. Ce script :
    1. lit la version depuis src-tauri/Cargo.toml (convertie en X.Y.Z.0) ;
    2. copie l'installeur NSIS + les assets Store dans une arborescence de package ;
    3. substitue __VERSION__ dans AppxManifest.xml ;
    4. construit le MSIX avec MakeAppx.exe.

  IMPORTANT (Store) :
    - Identity/Name et Identity/Publisher doivent être renseignés dans
      src-tauri/msix/AppxManifest.xml AVANT de lancer ce script. Ils proviennent
      du Partner Center et ne peuvent pas être devinés.
    - Le MSIX construit ici n'a PAS besoin d'être signé : le Store signe le
      paquet lors de la soumission (volet « Packages »). Pour un test LOCAL
      (installation hors Store), la signature est obligatoire → voir le
      paramètre -SelfSign et les notes en fin de script.

.PARAMETER SelfSign
  Signer le MSIX avec un certificat auto-signé de test (installation locale
  uniquement). Sans ce flag, le paquet n'est pas signé (cas soumission Store).

.PARAMETER CertPath
  Chemin d'un certificat PFX de test. Requis avec -SelfSign si aucun certificat
  n'est fourni dans le magasin utilisateur.

.EXAMPLE
  # Paquet pour le Store (non signé) :
  ./build-msix.ps1

.EXAMPLE
  # Paquet pour test local, signé avec un PFX de test :
  ./build-msix.ps1 -SelfSign -CertPath ./test-cert.pfx
#>
param(
  [switch]$SelfSign,
  [string]$CertPath
)

$ErrorActionPreference = 'Stop'

# --- Résolution des chemins (le script vit dans src-tauri/msix/) -------------
$scriptDir    = Split-Path -Parent $MyInvocation.MyCommand.Definition
$tauriDir     = Split-Path -Parent $scriptDir            # src-tauri
$repoRoot     = Split-Path -Parent $tauriDir             # racine du projet mira
$iconsDir     = Join-Path $tauriDir 'icons'
$manifestSrc  = Join-Path $scriptDir 'AppxManifest.xml'
$cargoToml    = Join-Path $tauriDir 'Cargo.toml'

# Sortie du build Tauri (NSIS). Adapter le chemin selon le profil/target.
$releaseDir   = Join-Path $tauriDir 'target\release'
$nsisDir      = Join-Path $releaseDir 'bundle\nsis'

# Dossier de travail du package.
$pkgDir       = Join-Path $releaseDir 'msix\package'
$assetsDir    = Join-Path $pkgDir 'Assets'

function Fail($msg) { Write-Error $msg; exit 1 }

# --- 1. Version quadripartite ------------------------------------------------
if (-not (Test-Path $cargoToml)) { Fail "Cargo.toml introuvable: $cargoToml" }
$versionLine = Select-String -Path $cargoToml -Pattern '^\s*version\s*=\s*"([^"]+)"' |
               Select-Object -First 1
if (-not $versionLine) { Fail "Impossible de lire la version dans Cargo.toml" }
$semver  = $versionLine.Matches[0].Groups[1].Value
# MSIX exige 4 composants ; on ajoute un '.0' de révision.
$msixVer = if ($semver.Split('.').Count -ge 4) { $semver } else { "$semver.0" }
Write-Host "Version semver : $semver  ->  MSIX : $msixVer"

# --- 2. Arborescence du package ---------------------------------------------
Write-Host "Préparation du dossier de package..."
if (Test-Path $pkgDir) { Remove-Item -Recurse -Force $pkgDir }
New-Item -ItemType Directory -Force -Path $pkgDir, $assetsDir | Out-Null

# 2a. Installeur NSIS : le Store exige un installeur OFFLINE (WebView2 embarqué,
#     cf. tauri.microsoftstore.conf.json). On prend le premier .exe présent.
$installer = Get-ChildItem -Path $nsisDir -Filter '*setup.exe' -ErrorAction SilentlyContinue |
             Select-Object -First 1
if (-not $installer) {
  Fail "Installeur NSIS introuvable dans $nsisDir. Lance d'abord :`n  npm run tauri build -- --config src-tauri/tauri.microsoftstore.conf.json"
}
Copy-Item $installer.FullName (Join-Path $pkgDir 'MiraSetup.exe')
Write-Host "  + Installeur : $($installer.Name)"

# 2b. Assets Store : on mappe les icônes Tauri existantes vers les noms exigés
#     par AppxManifest.xml. Noms Store requis :
#       StoreLogo.png, Square44x44Logo.png, Square150x150Logo.png,
#       Square310x310Logo.png, Square71x71Logo.png,
#       Wide310x150Logo.png, SplashScreen.png
$assetMap = @{
  'StoreLogo.png'         = 'StoreLogo.png'
  'Square44x44Logo.png'   = 'Square44x44Logo.png'
  'Square71x71Logo.png'   = 'Square71x71Logo.png'
  'Square150x150Logo.png' = 'Square150x150Logo.png'
  'Square310x310Logo.png' = 'Square310x310Logo.png'
}
foreach ($k in $assetMap.Keys) {
  $src = Join-Path $iconsDir $assetMap[$k]
  if (Test-Path $src) {
    Copy-Item $src (Join-Path $assetsDir $k)
  } else {
    Fail "Icône manquante : $src"
  }
}

# Wide310x150Logo et SplashScreen n'ont pas d'équivalent 1:1 dans les icônes
# Tauri : on les dérive du Square310x310 via System.Drawing (disponible partout
# sur Windows). Rectangles aux dimensions exactes exigées par le Store.
Add-Type -AssemblyName System.Drawing

function Resize-Image([string]$srcPath, [string]$dstPath, [int]$width, [int]$height) {
  $img = [System.Drawing.Image]::FromFile($srcPath)
  try {
    $bmp = New-Object System.Drawing.Bitmap($width, $height)
    $g   = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.Clear([System.Drawing.Color]::Transparent)
    $g.DrawImage($img, 0, 0, $width, $height)
    $g.Dispose()
    $bmp.Save($dstPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
  } finally { $img.Dispose() }
}

$src310 = Join-Path $iconsDir 'Square310x310Logo.png'
Resize-Image $src310 (Join-Path $assetsDir 'Wide310x150Logo.png') 310 150
Resize-Image $src310 (Join-Path $assetsDir 'SplashScreen.png')    620 300
Write-Host "  + Assets Store générés (5 + Wide + Splash)"

# --- 3. Manifeste (substitution de version) ---------------------------------
$manifest = Get-Content $manifestSrc -Raw
if ($manifest -match 'REPLACE_WITH_PARTNER_CENTER_IDENTITY_NAME') {
  Fail "AppxManifest.xml : Identity/@Name n'est pas renseigné (placeholder Partner Center)."
}
if ($manifest -match 'REPLACE_WITH_PARTNER_CENTER_PUBLISHER_CN') {
  Fail "AppxManifest.xml : Identity/@Publisher n'est pas renseigné (placeholder Partner Center)."
}
$manifest = $manifest -replace '__VERSION__', $msixVer
$utf8 = New-Object System.Text.UTF8Encoding($false) # pas de BOM (exigé)
[System.IO.File]::WriteAllText((Join-Path $pkgDir 'AppxManifest.xml'), $manifest, $utf8)
Write-Host "  + AppxManifest.xml (v$msixVer)"

# --- 4. Construction du MSIX ------------------------------------------------
# Localisation de MakeAppx.exe (Windows SDK).
$makeappx = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\bin' -Recurse `
              -Filter 'makeappx.exe' -ErrorAction SilentlyContinue |
              Where-Object { $_.FullName -match '\\x64\\' } |
              Sort-Object FullName -Descending | Select-Object -First 1
if (-not $makeappx) {
  Fail "MakeAppx.exe introuvable. Installe le 'Windows SDK Signing Tools for Desktop Apps'."
}

$outMsix = Join-Path $releaseDir "msix\Mira_${msixVer}_x64.msix"
Write-Host "Construction du MSIX -> $outMsix"
& $makeappx.FullName pack /d $pkgDir /p $outMsix /o
if ($LASTEXITCODE -ne 0) { Fail "makeappx a échoué." }

# --- 5. (Optionnel) signature de TEST ---------------------------------------
# Non requise pour le Store (le Store signe). Requise pour une installation
# LOCALE du MSIX. Le certificat DOIT être placé dans « Autorités de
# certification racines de confiance » de la machine de test, sinon Windows
# refuse l'installation.
if ($SelfSign) {
  if (-not (Test-Path $CertPath)) { Fail "-SelfSign nécessite -CertPath vers un .pfx valide." }
  $signtool = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\bin' -Recurse `
                -Filter 'signtool.exe' -ErrorAction SilentlyContinue |
                Where-Object { $_.FullName -match '\\x64\\' } |
                Sort-Object FullName -Descending | Select-Object -First 1
  if (-not $signtool) { Fail "signtool.exe introuvable (Windows SDK requis)." }
  Write-Host "Signature de test avec $CertPath"
  & $signtool.FullName sign /fd SHA256 /f $CertPath $outMsix
  if ($LASTEXITCODE -ne 0) { Fail "signtool a échoué." }
}

Write-Host ""
Write-Host "OK : $outMsix" -ForegroundColor Green
Write-Host "Soumission : Partner Center > Apps and Games > (ton app) > Packages > uploader ce .msix"
