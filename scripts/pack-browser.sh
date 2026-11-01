#!/usr/bin/env bash
# Pack browser (docs/pack-mode.md): build the browse, design and make-pdf
# runtime into an existing ready pack render R, with bun's package cache and
# Playwright's Chromium in a host-chosen cache C. Called by
# `setup --pack-browser R --pack-browser-cache C` from the trusted extraction.
# Runs only: bun install --production --frozen-lockfile, bun run vendor:xterm,
# the five bun build --compile lines from scripts/build.sh, and
# bun x playwright install chromium. Never scripts/build.sh (it re-renders
# every skill with the ~/.claude install root), CSO, fonts, system packages
# or a lockfile rewrite. Writes only under R and C.
set -euo pipefail
R="${1:-}"
C="${2:-}"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
PATH_PATTERN='^/[A-Za-z0-9_.@+/-]*$'
fail() { echo "pack browser: $2" >&2; exit "$1"; }
# Validate everything before the first write, so a bad call writes nothing.
[[ "$R" =~ $PATH_PATTERN && "$C" =~ $PATH_PATTERN ]] \
  || fail 2 "--pack-browser and --pack-browser-cache must be plain absolute paths"
R="${R%/}"; C="${C%/}"
[ -n "$R" ] && [ -n "$C" ] || fail 2 "--pack-browser and --pack-browser-cache must not be /"
case "$C/" in "$SRC"/*) fail 2 "--pack-browser-cache must be outside the source tree ($SRC)" ;; esac
[ -f "$R/.gstack-pack.json" ] && tr -d '[:space:]' < "$R/.gstack-pack.json" | grep -qF '"packMode":1' \
  || fail 2 "$R is not a ready pack render"
command -v bun >/dev/null 2>&1 || fail 1 "bun is required on PATH (https://bun.sh)"
BUN_VERSION="$(bun --version)"
# shellcheck source=/dev/null
. "$R/bin/gstack-bun-version.sh"
case "$(gstack_bun_status "$BUN_VERSION")" in
  ok|untested) ;;
  too-old) fail 1 "bun $BUN_VERSION is below gstack's security floor $GSTACK_BUN_FLOOR" ;;
  *) fail 1 "cannot compare bun version '$BUN_VERSION' with gstack's security floor $GSTACK_BUN_FLOOR" ;;
esac

BINARIES="browse/dist/browse browse/dist/find-browse design/dist/design make-pdf/dist/pdf bin/gstack-global-discover"
# On any failure, leave R a ready plain render: remove everything this step adds.
cleanup() {
  rm -rf "$R/node_modules"
  for _bin in $BINARIES; do rm -f "$R/$_bin"; done
  rm -f "$R"/extension/lib/xterm* "$R/browse/dist/.version" "$R/design/dist/.version" "$R/make-pdf/dist/.version"
  rm -f "$R/.gstack-pack-browser.json" "$R/.gstack-pack-browsers-path"
}
rm -f "$R/.gstack-pack-browser.json" "$R/.gstack-pack-browsers-path"
mkdir -p "$C/bun-cache" "$C/playwright"
trap 'rc=$?; [ "$rc" -eq 0 ] || cleanup; exit "$rc"' EXIT

export BUN_INSTALL_CACHE_DIR="$C/bun-cache" BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 PLAYWRIGHT_BROWSERS_PATH="$C/playwright"
cd "$R"

# 1. Production dependencies, exactly as locked (no --lockfile-only fallback).
bun install --production --frozen-lockfile
# 2. The vendored terminal assets the browse extension serves.
bun run vendor:xterm
# 3. The five binaries, with scripts/build.sh's flags.
bun build --compile --no-compile-autoload-dotenv --no-compile-autoload-bunfig browse/src/cli.ts --outfile browse/dist/browse
bun build --compile --no-compile-autoload-dotenv --no-compile-autoload-bunfig browse/src/find-browse.ts --outfile browse/dist/find-browse
bun build --compile --no-compile-autoload-dotenv --no-compile-autoload-bunfig design/src/cli.ts --outfile design/dist/design
bun build --compile --no-compile-autoload-dotenv --no-compile-autoload-bunfig make-pdf/src/cli.ts --outfile make-pdf/dist/pdf
bun build --compile --no-compile-autoload-dotenv --no-compile-autoload-bunfig bin/gstack-global-discover.ts --outfile bin/gstack-global-discover
for _bin in $BINARIES; do chmod +x "$_bin"; done
rm -f .*.bun-build

# 4. macOS Apple Silicon: ad-hoc re-sign, as setup does (#997, #1254): strip
# trailing padding past LC_CODE_SIGNATURE, remove and re-sign, and restore the
# binary as built when re-signing fails.
if [ "$(uname -s)" = "Darwin" ] && [ "$(uname -m)" = "arm64" ]; then
  for _bin in $BINARIES; do
    _bin_path="$R/$_bin"
    [ -f "$_bin_path" ] && [ -x "$_bin_path" ] || continue
    _bin_bak="$_bin_path.gstack-presign.$$"
    if ! cp -p "$_bin_path" "$_bin_bak" 2>/dev/null; then
      rm -f "$_bin_bak"
      echo "pack browser: could not back up $_bin before re-signing; left it as built" >&2
      continue
    fi
    _sig_end=$(otool -l "$_bin_path" 2>/dev/null | awk '/LC_CODE_SIGNATURE/{f=1} f&&/dataoff/{o=$2} f&&/datasize/{print o+$2; exit}') || _sig_end=""
    _fsize=$(stat -f%z "$_bin_path" 2>/dev/null) || _fsize=""
    if [ -n "$_sig_end" ] && [ -n "$_fsize" ] && [ "$_sig_end" -gt 0 ] 2>/dev/null && [ "$_sig_end" -lt "$_fsize" ] 2>/dev/null; then
      _trunc_tmp=$(mktemp 2>/dev/null) || _trunc_tmp=""
      if [ -n "$_trunc_tmp" ] && head -c "$_sig_end" "$_bin_path" > "$_trunc_tmp" 2>/dev/null; then
        cat "$_trunc_tmp" > "$_bin_path" && chmod +x "$_bin_path"
      fi
      [ -n "$_trunc_tmp" ] && rm -f "$_trunc_tmp"
    fi
    codesign --remove-signature "$_bin_path" 2>/dev/null || true
    if codesign -s - -f "$_bin_path" 2>/dev/null; then
      rm -f "$_bin_bak"
    else
      mv -f "$_bin_bak" "$_bin_path"
      echo "pack browser: codesign could not re-sign $_bin; restored it as built" >&2
    fi
  done
fi

# 5. Version files from R/VERSION (R has no .git).
VERSION="$(tr -d '[:space:]' < "$R/VERSION")"
for _f in browse/dist/.version design/dist/.version make-pdf/dist/.version; do
  printf '%s\n' "$VERSION" > "$_f"
done

# 6. Chromium into C/playwright, bounded like bin/gstack-browser-ensure. No
# --with-deps: no system packages, no fonts.
TIMEOUT="${GSTACK_PLAYWRIGHT_INSTALL_TIMEOUT:-600}"
case "$TIMEOUT" in ''|*[!0-9]*) TIMEOUT=600 ;; esac
[ "$TIMEOUT" -gt 0 ] || TIMEOUT=600
OVERRIDE=""
if [ -f /etc/os-release ] && grep -q '^ID=ubuntu' /etc/os-release && grep -q '^VERSION_ID="26.04"' /etc/os-release; then
  case "$(uname -m)" in x86_64) OVERRIDE="ubuntu24.04-x64" ;; aarch64|arm64) OVERRIDE="ubuntu24.04-arm64" ;; esac
fi
(
  if [ -n "$OVERRIDE" ]; then PLAYWRIGHT_HOST_PLATFORM_OVERRIDE="$OVERRIDE" bun x playwright install chromium
  else bun x playwright install chromium; fi
) </dev/null &
pid=$!
waited=0
while kill -0 "$pid" 2>/dev/null; do
  if [ "$waited" -ge "$TIMEOUT" ]; then
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
    fail 1 "bun x playwright install chromium exceeded ${TIMEOUT}s (raise GSTACK_PLAYWRIGHT_INSTALL_TIMEOUT)"
  fi
  sleep 1; waited=$((waited + 1))
done
wait "$pid" || fail 1 "bun x playwright install chromium failed (offline, proxy, or blocked download?)"

# 7. The browsers-path marker, then the same probe every browser skill runs.
printf '%s\n' "$C/playwright" > "$R/.gstack-pack-browsers-path"
PROBE="$("$R/bin/gstack-browser-ensure" --check --quiet)" || fail 1 "Chromium did not launch: ${PROBE:-no output}"
case "$PROBE" in BROWSER_OK*) ;; *) fail 1 "Chromium did not launch: $PROBE" ;; esac

# 8. The ready marker, last: a render without it has no browser runtime.
printf '{"packBrowser":1,"browsersPath":"%s","version":"%s"}\n' "$C/playwright" "$VERSION" > "$R/.gstack-pack-browser.json"
trap - EXIT
