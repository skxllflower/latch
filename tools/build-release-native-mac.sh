#!/usr/bin/env bash
# build-release-native-mac.sh - the native Latch on macOS (the vpf GUI in native/, replacing the Tauri bundle that
# tools/build-release-mac.sh makes): a universal Latch.app and Vacant Systems Manager's package of it.
#
#   tools/build-release-native-mac.sh                  # full build: core + GUI, universal, signed, zipped
#   SKIP_CPP=1 tools/build-release-native-mac.sh       # reuse the core and GUI builds in native/build-release
#   tools/build-release-native-mac.sh --skip-notarize  # Developer ID signed, not notarized
#
# Steps:
#   1. the core CLI (cmake ., --target latch, arm64 + x86_64)   -> native/build-release/core/latch
#   2. the GUI (native/, its own build tree, arm64 + x86_64)      -> native/build-release/build/bin/Latch.app, the core
#      copied into Contents/MacOS/coredist/latch (native/app/bundle_core.cmake), where the Tauri bundle had it
#   3. checks: every Mach-O universal, at or under the macOS floor (12.0), no Homebrew library linked
#   4. signed inside out (the core, then the app; never --deep)
#   5. with a Developer ID only: notarized and stapled
#   6. the manager's package (vacant-labs apps/manager/docs/app-contract.md, 8):
#      native/build-release/manager/Latch-<version>-mac.zip holding Latch.app/ (ditto -c -k --keepParent)
#
# Signing modes (as tools/build-release-mac.sh and vacant-labs' tools/build-release-mac.sh):
#   - APPLE_SIGNING_IDENTITY unset: ad hoc. Runs on THIS mac only; the manager's `catalog.py pack` re-signs it inside out
#     with the Developer ID, notarizes and staples it (the contract's "ad hoc signed by its build").
#   - APPLE_SIGNING_IDENTITY="Developer ID Application: Name (TEAMID)": hardened runtime + secure timestamp on each
#     piece, then notarized (keychain profile NOTARY_PROFILE, default wavdesk-notary) and stapled.
#
# The GUI builds on the pinned vpf and WAVdesk commits (native/CMakeLists.txt GIT_TAG), never a local checkout's working
# tree. WAVDESK_SRC / VACANTLABS_SRC point FetchContent at a checkout instead (a pin not pushed yet): the script says so.
set -euo pipefail

SKIP_NOTARIZE="${SKIP_NOTARIZE:-0}"
for arg in "$@"; do
  case "$arg" in
    --skip-notarize) SKIP_NOTARIZE=1 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$REPO/native/build-release"
CORE_BUILD="$OUT/core"
GUI_BUILD="$OUT/build"
MGR="$OUT/manager"
ARCHS="arm64;x86_64"
MACOS_MIN="12.0"
IDENTITY="${APPLE_SIGNING_IDENTITY:-}"
PROFILE="${NOTARY_PROFILE:-wavdesk-notary}"
VERSION="$(/usr/bin/python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$REPO/gui/src-tauri/tauri.conf.json")"

step() { printf '\n\033[36m[%s] %s\033[0m\n' "$1" "$2"; }
die() { echo "RELEASE ABORTED: $*" >&2; exit 1; }

# notarize <file>: submit, wait, and fail with Apple's log unless it is Accepted
notarize() {
  local file="$1" json id status
  json="$(xcrun notarytool submit "$file" --keychain-profile "$PROFILE" --wait --output-format json)" || die "notarytool submit failed for $file"
  id="$(printf '%s' "$json" | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin).get("id",""))')"
  status="$(printf '%s' "$json" | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin).get("status",""))')"
  echo "  notarization $id: $status"
  if [ "$status" != "Accepted" ]; then
    xcrun notarytool log "$id" --keychain-profile "$PROFILE" >&2 || true
    die "notarization of $(basename "$file") was $status"
  fi
}

# the minos of a Mach-O (LC_BUILD_VERSION, or the older LC_VERSION_MIN_MACOSX), its first slice's
minos_of() {
  otool -l "$1" | awk '
    /LC_BUILD_VERSION|LC_VERSION_MIN_MACOSX/ { b = 1 }
    b && $1 == "minos"   { print $2; exit }
    b && $1 == "version" { print $2; exit }'
}
version_le() { [ "$(printf '%s\n%s\n' "$1" "$2" | sort -t. -k1,1n -k2,2n -k3,3n | head -1)" = "$1" ]; }

if [ -n "$IDENTITY" ]; then
  security find-identity -v -p codesigning | grep -qF "$IDENTITY" || die "signing identity not in the keychain: $IDENTITY"
fi
pgrep -x Latch >/dev/null 2>&1 && echo "warning: Latch is running (quit it before installing this build)"

# ---- 1: the core ----
step 1 "the core CLI $VERSION ($ARCHS)"
if [ "${SKIP_CPP:-0}" = "1" ]; then
  echo "  SKIP_CPP=1: reusing $CORE_BUILD"
else
  cmake -S "$REPO" -B "$CORE_BUILD" -DCMAKE_BUILD_TYPE=Release "-DCMAKE_OSX_ARCHITECTURES=$ARCHS" \
        "-DCMAKE_OSX_DEPLOYMENT_TARGET=$MACOS_MIN" >/dev/null
  cmake --build "$CORE_BUILD" --target latch -j "$(sysctl -n hw.ncpu)"
fi
CORE="$CORE_BUILD/latch"
[ -f "$CORE" ] || die "core binary not found: $CORE (run without SKIP_CPP?)"

# ---- 2: the GUI ----
step 2 "the GUI ($ARCHS)"
SRC_ARGS=()
if [ -n "${WAVDESK_SRC:-}" ]; then
  echo "  WAVDESK_SRC: WAVdesk from $WAVDESK_SRC, not the pinned commit"
  SRC_ARGS+=("-DFETCHCONTENT_SOURCE_DIR_WAVDESK=$WAVDESK_SRC")
fi
if [ -n "${VACANTLABS_SRC:-}" ]; then
  echo "  VACANTLABS_SRC: vacant-labs from $VACANTLABS_SRC, not the pinned commit"
  SRC_ARGS+=("-DFETCHCONTENT_SOURCE_DIR_VACANTLABS=$VACANTLABS_SRC")
fi
if [ "${SKIP_CPP:-0}" != "1" ] || [ ! -d "$GUI_BUILD/bin/Latch.app" ]; then
  cmake -S "$REPO/native" -B "$GUI_BUILD" -DCMAKE_BUILD_TYPE=Release "-DCMAKE_OSX_ARCHITECTURES=$ARCHS" \
        "-DLATCH_CORE_BINARY=$CORE" "-DVPF_CODESIGN_IDENTITY=-" -Wno-dev ${SRC_ARGS[@]+"${SRC_ARGS[@]}"} >/dev/null
  cmake --build "$GUI_BUILD" -j "$(sysctl -n hw.ncpu)"
fi
BUILT="$GUI_BUILD/bin/Latch.app"
[ -d "$BUILT" ] || die "no Latch.app under $GUI_BUILD/bin"
# a staged copy: what is signed and zipped (the build tree's own stays as the build left it)
APP="$OUT/stage/Latch.app"
rm -rf "$OUT/stage"
mkdir -p "$OUT/stage"
/usr/bin/ditto "$BUILT" "$APP"
[ -f "$APP/Contents/MacOS/coredist/latch" ] || die "Latch.app carries no core (Contents/MacOS/coredist/latch)"
# (not byte-compared with $CORE: the build signed its copy, which rewrites it; it must be no older than the core built)
[ ! "$CORE" -nt "$APP/Contents/MacOS/coredist/latch" ] || die "Latch.app's core is older than the one just built"
"$APP/Contents/MacOS/coredist/latch" --help >/dev/null 2>&1 || die "Latch.app's core does not run"

# ---- 3: checks ----
step 3 "universal, macOS $MACOS_MIN floor, no Homebrew"
BAD=0
EXE="$APP/Contents/MacOS/$(defaults read "$APP/Contents/Info" CFBundleExecutable)"
[ "$(basename "$EXE")" = "Latch" ] || { echo "  CFBundleExecutable is not Latch"; BAD=1; }
PLIST_VER="$(defaults read "$APP/Contents/Info" CFBundleShortVersionString)"
[ "$PLIST_VER" = "$VERSION" ] || { echo "  CFBundleShortVersionString $PLIST_VER, tauri.conf.json $VERSION"; BAD=1; }
while IFS= read -r -d '' bin; do
  file -b "$bin" | grep -q 'Mach-O' || continue
  archs="$(lipo -archs "$bin")"
  min="$(minos_of "$bin")"
  echo "  ${bin#"$APP"/}: $archs, macOS $min"
  case " $archs " in *" arm64 "*) ;; *) BAD=1 ;; esac
  case " $archs " in *" x86_64 "*) ;; *) BAD=1 ;; esac
  if [ -z "$min" ] || ! version_le "$min" "$MACOS_MIN"; then BAD=1; fi
  if otool -L "$bin" | tail -n +2 | grep -qE '/opt/homebrew/|/usr/local/'; then echo "    ^ links a Homebrew library"; BAD=1; fi
done < <(find "$APP" -type f -print0)
[ "$BAD" = "0" ] || die "a check above failed"

# ---- 4: sign, inside out ----
step 4 "codesign"
if [ -z "$IDENTITY" ]; then
  codesign --force --sign - "$APP/Contents/MacOS/coredist/latch"
  codesign --force --sign - "$APP"
  echo "  ad hoc: this mac only (the manager's catalog.py pack re-signs it with the Developer ID)"
else
  codesign --force --options runtime --timestamp --sign "$IDENTITY" "$APP/Contents/MacOS/coredist/latch"
  codesign --force --options runtime --timestamp --sign "$IDENTITY" "$APP"
  echo "  Developer ID signed, hardened runtime, timestamped"
fi
codesign --verify --strict --deep "$APP" || die "codesign verification failed: $APP"

# ---- 5: notarize ----
step 5 "notarize + staple"
if [ -z "$IDENTITY" ]; then
  echo "  skipped: an ad hoc build has nothing to notarize"
elif [ "$SKIP_NOTARIZE" = "1" ]; then
  echo "  --skip-notarize: signed but NOT notarized"
else
  SUB="$OUT/Latch-notarize.zip"
  rm -f "$SUB"
  /usr/bin/ditto -c -k --keepParent "$APP" "$SUB"
  notarize "$SUB"
  rm -f "$SUB"
  xcrun stapler staple -q "$APP" || die "stapling failed"
  xcrun stapler validate -q "$APP" || die "staple validation failed"
  echo "  notarized and stapled"
fi

# ---- 6: the manager's package ----
step 6 "the manager's zip"
mkdir -p "$MGR"
ZIP="$MGR/Latch-$VERSION-mac.zip"
rm -f "$ZIP"
/usr/bin/ditto -c -k --keepParent "$APP" "$ZIP"

printf '\n\033[32mLatch %s (native, macOS):\033[0m\n' "$VERSION"
printf '  app      %s\n' "$APP"
printf '  manager  %s (%s)\n' "$ZIP" "$(du -h "$ZIP" | cut -f1)"
