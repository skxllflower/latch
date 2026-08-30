#!/usr/bin/env bash
# build-release-mac.sh - one command to produce a shippable Latch .app + .dmg on macOS.
#
# The macOS counterpart of tools/build-release.ps1. Latch's Tauri GUI spawns its
# C++ core (the `latch` CLI) as a subprocess but does NOT declare it a sidecar,
# so this stages the freshly-built core into gui/src-tauri/coredist/, which
# tauri.conf bundles as a resource. tools.rs then resolves it next to the GUI
# binary inside the .app. ffmpeg + yt-dlp are NOT bundled: the core self-
# provisions them at runtime (bootstrap.cpp: evermeet ffmpeg/ffprobe + yt-dlp_macos).
#
# The Windows bundle config is untouched: we pass --bundles app,dmg on the CLI
# (tauri.conf still says nsis) so Windows builds stay byte-identical.
#
#   tools/build-release-mac.sh            # full release build
#   SKIP_CPP=1 tools/build-release-mac.sh # reuse existing build/
#   tools/build-release-mac.sh --skip-notarize  # sign, but skip step 6
#
# Signing modes (mirror of wavdesk/tools/build-release-mac.sh):
#   - APPLE_SIGNING_IDENTITY unset: ad-hoc sign. Runs on THIS mac only; every
#     other machine's Gatekeeper refuses an ad-hoc bundle outright, quarantine
#     stripped or not.
#   - APPLE_SIGNING_IDENTITY="Developer ID Application: Name (TEAMID)": the
#     distributable path. Sign INSIDE-OUT, per nested Mach-O, hardened runtime
#     + secure timestamp, main bundle sealed last, then sign the dmg container
#     and notarize + staple it. Never --deep: it signs nested code with the
#     wrong flags and the notary service rejects the result.
#     Notarization credentials come from a keychain profile (one-time setup):
#       xcrun notarytool store-credentials wavdesk-notary \
#         --apple-id <you@example.com> --team-id <TEAMID> \
#         --password <app-specific password from account.apple.com>
#     Override the profile name with NOTARY_PROFILE (default: wavdesk-notary).
set -euo pipefail

SKIP_NOTARIZE="${SKIP_NOTARIZE:-0}"
for arg in "$@"; do
  case "$arg" in
    --skip-notarize) SKIP_NOTARIZE=1 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

export PATH="/opt/homebrew/opt/rustup/bin:/opt/homebrew/bin:$HOME/.cargo/bin:/usr/local/bin:$PATH"

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD="$REPO/build"
GUI="$REPO/gui"
TAURI="$GUI/src-tauri"
COREDIST="$TAURI/coredist"
CORE="latch"
PRODUCT="Latch"
BUNDLE="$TAURI/target/release/bundle"

step() { printf '\n\033[36m[%s] %s\033[0m\n' "$1" "$2"; }

# ---- Step 0: kill running dev/release instances (tolerant) ----------------
step 0 "Kill running $PRODUCT instances"
pkill -x "$PRODUCT" 2>/dev/null || true      # the GUI process
pkill -x "$CORE" 2>/dev/null || true         # any lingering CLI core
sleep 1 || true

# ---- Step 1: build the C++ core (Release) ---------------------------------
step 1 "C++ core (Release)"
if [ "${SKIP_CPP:-0}" = "1" ]; then
  echo "  SKIP_CPP=1: reusing existing build/"
else
  cmake -B "$BUILD" -S "$REPO" -DCMAKE_BUILD_TYPE=Release
  cmake --build "$BUILD" -j6
fi
CORE_SRC="$BUILD/$CORE"
[ -f "$CORE_SRC" ] || { echo "core binary not found: $CORE_SRC" >&2; exit 1; }

# ---- Step 2: stage the core into coredist ---------------------------------
step 2 "Stage core -> coredist"
mkdir -p "$COREDIST"
find "$COREDIST" -mindepth 1 ! -name '.gitkeep' -exec rm -rf {} + 2>/dev/null || true
cp -f "$CORE_SRC" "$COREDIST/$CORE"
chmod 0755 "$COREDIST/$CORE"
echo "  staged $CORE -> $COREDIST"
echo "  otool -L (core, expect only system libs):"
otool -L "$COREDIST/$CORE" | sed -n '2,20p'

# ---- Step 3: bundle the .app ----------------------------------------------
# Only the `app` bundle: Tauri's own dmg step drives Finder via AppleScript to
# lay out the disk-image window, which fails without an interactive GUI session
# (headless build agents, ssh). We build the .app here and package the .dmg
# ourselves with hdiutil in Step 5 (no Finder dependency). The Windows bundle
# config (nsis) is untouched — targets are passed on the CLI.
step 3 "pnpm tauri build (app)"
command -v pnpm >/dev/null 2>&1 || { echo "pnpm not found on PATH" >&2; exit 1; }
( cd "$GUI" && pnpm install && pnpm tauri build --bundles app )

APP="$(find "$BUNDLE/macos" -maxdepth 1 -name '*.app' 2>/dev/null | head -1)"
[ -n "$APP" ] || { echo "no .app produced under $BUNDLE/macos" >&2; exit 1; }

# Self-resolution belt-and-suspenders: tools.rs looks for the core at
# <dir-of-GUI-binary>/coredist/latch (i.e. Contents/MacOS/coredist). Tauri
# resources land in Contents/Resources/. If the MacOS-side coredist is absent,
# mirror it there so the installed tier finds the core.
MACOS_DIR="$APP/Contents/MacOS"
if [ ! -e "$MACOS_DIR/coredist/$CORE" ]; then
  echo "  mirroring coredist next to the GUI binary (Contents/MacOS/coredist)"
  mkdir -p "$MACOS_DIR/coredist"
  cp -f "$COREDIST/$CORE" "$MACOS_DIR/coredist/$CORE"
  chmod 0755 "$MACOS_DIR/coredist/$CORE"
fi

# ---- Step 4: codesign (Developer ID when available, else ad-hoc) ----------
# Ad-hoc still buys local translocation behaviour and a stable code identity
# (without one, Launch Services stops deduping launches and the Dock grows
# ghost tiles). Developer ID is the shippable path: sign inside-out so every
# nested Mach-O carries its own hardened-runtime, timestamped signature, then
# seal the bundle by signing the .app last. --deep is deliberately NOT used on
# this path: it re-signs nested code with the outer flags, and the notary
# service rejects what it produces.
step 4 "Codesign"
if [ -z "${APPLE_SIGNING_IDENTITY:-}" ]; then
  codesign --force --deep -s - "$APP"
  codesign --verify --verbose=1 "$APP" || echo "  (codesign verify warned; ad-hoc is expected to be shallow)"
  echo "  ad-hoc signed: local machine only, NOT distributable"
else
  MAIN_EXE="$APP/Contents/MacOS/$(defaults read "$APP/Contents/Info" CFBundleExecutable)"
  while IFS= read -r -d '' bin; do
    [ "$bin" = "$MAIN_EXE" ] && continue
    file -b "$bin" | grep -q 'Mach-O' || continue
    codesign --force --options runtime --timestamp -s "$APPLE_SIGNING_IDENTITY" "$bin"
    echo "  signed: ${bin#"$APP"/}"
  done < <(find "$APP" -type f \( -perm -111 -o -name '*.dylib' -o -name '*.so' \) -print0)
  codesign --force --options runtime --timestamp -s "$APPLE_SIGNING_IDENTITY" "$APP"
  echo "  signed: $(basename "$APP") (main bundle, sealed last)"
  codesign --verify --deep --strict "$APP" || {
    echo "RELEASE ABORTED: codesign verification failed on $APP" >&2; exit 1; }
  echo "  ok: codesign verifies"
fi

# ---- Step 5: package a dmg carrying the SIGNED app (hdiutil, no Finder) ----
step 5 "Package signed .dmg"
VER="$(node -p "require('$TAURI/tauri.conf.json').version" 2>/dev/null || echo 0.0.0)"
ARCH="$(uname -m)"
DMG="$BUNDLE/dmg/${PRODUCT}_${VER}_${ARCH}.dmg"
mkdir -p "$BUNDLE/dmg"
STAGE="$(mktemp -d)"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
rm -f "$DMG"
hdiutil create -volname "$PRODUCT" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null
rm -rf "$STAGE"

# Sign the dmg CONTAINER too, not just the app inside it. Gatekeeper assesses
# the container the user actually double-clicks, and notarytool wants a signed
# submission.
if [ -n "${APPLE_SIGNING_IDENTITY:-}" ]; then
  codesign --force --timestamp -s "$APPLE_SIGNING_IDENTITY" "$DMG"
  echo "  signed dmg container"
fi

# ---- Step 6: notarize + staple -------------------------------------------
# Stapling matters: without the ticket the first launch needs a live round trip
# to Apple, so a tester who is offline (or behind a captive portal) still gets
# the scary dialog on a perfectly notarized build.
step 6 "Notarize + staple"
if [ -z "${APPLE_SIGNING_IDENTITY:-}" ]; then
  echo "  skipped: ad-hoc build has nothing to notarize"
elif [ "$SKIP_NOTARIZE" = "1" ]; then
  echo "  --skip-notarize: dmg is Developer ID signed but NOT notarized (Gatekeeper will warn)"
else
  xcrun notarytool submit "$DMG" --keychain-profile "${NOTARY_PROFILE:-wavdesk-notary}" --wait
  xcrun stapler staple "$DMG"
  xcrun stapler validate "$DMG"
  echo "  notarized + stapled"
fi

# ---- Done -----------------------------------------------------------------
printf '\n\033[32mArtifacts:\033[0m\n'
printf '  app: %s  (%s)\n' "$APP" "$(du -sh "$APP" | cut -f1)"
printf '  dmg: %s  (%s)\n' "$DMG" "$(du -sh "$DMG" | cut -f1)"
if [ -z "${APPLE_SIGNING_IDENTITY:-}" ]; then
cat <<EOF

Tester install note:
  1. Open the .dmg and drag $PRODUCT to Applications (or run it in place).
  2. First launch: right-click $PRODUCT.app -> Open (unsigned app), OR run:
       xattr -dr com.apple.quarantine "/Applications/$PRODUCT.app"
  This build is ad-hoc signed and NOT notarized: it will not open on any mac
  but this one. Set APPLE_SIGNING_IDENTITY for a distributable build.
EOF
elif [ "$SKIP_NOTARIZE" = "1" ]; then
cat <<EOF

Tester install note:
  Developer ID signed but NOT notarized: the first open on another mac still
  shows a Gatekeeper warning. Re-run without --skip-notarize to ship it.
EOF
else
cat <<EOF

Tester install note:
  Open the .dmg and drag $PRODUCT to Applications. Notarized and stapled, so
  it opens on a clean mac with no right-click Open and no xattr dance.
EOF
fi
