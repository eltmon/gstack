#!/usr/bin/env bash
# Pack mode (docs/pack-mode.md): render every skill and its runtime into a
# caller-supplied root R and keep all state in S, for hosts such as Overdeck
# that mount skills themselves. Called by `setup --pack-root R --pack-state-root S`.
# Writes only under R and S: no bun install, no build, no Playwright, no
# harness dirs or settings, no network.
set -euo pipefail

R="${1:-}"
S="${2:-}"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
PATH_PATTERN='^/[A-Za-z0-9_.@+/-]*$'

fail() { echo "pack mode: $2" >&2; exit "$1"; }

# Validate everything before the first write, so a bad call writes nothing.
[[ "$R" =~ $PATH_PATTERN && "$S" =~ $PATH_PATTERN ]] \
  || fail 2 "--pack-root and --pack-state-root must be plain absolute paths"
R="${R%/}"; S="${S%/}"
[ -n "$R" ] && [ -n "$S" ] || fail 2 "--pack-root and --pack-state-root must not be /"
case "$R/" in "$SRC"/*) fail 2 "--pack-root must be outside the source tree ($SRC)" ;; esac
case "$S/" in "$SRC"/*) fail 2 "--pack-state-root must be outside the source tree ($SRC)" ;; esac
if [ -e "$R" ]; then
  [ -d "$R" ] && [ -z "$(ls -A "$R")" ] || fail 2 "--pack-root must be absent or empty ($R)"
fi
command -v bun >/dev/null 2>&1 || fail 1 "bun is required on PATH (https://bun.sh)"

mkdir -p "$R" "$S"

# 1. The runtime, without git metadata, tests, deps, CI config or symlinks.
tar -C "$SRC" --exclude=./.git --exclude=./test --exclude=./node_modules --exclude=./.github -cf - . \
  | tar -C "$R" -xpf -
find "$R" -type l -delete

# 2. Skill docs that name R instead of ~/.claude/skills/gstack. cwd R, so the
# generator reads the copy and never the source tree.
(cd "$R" && bun run "$R/scripts/gen-skill-docs.ts" --host claude --out-dir "$R" --install-root "$R" --link-root "$R")
grep -qF "$R/bin/gstack-skill-start --skill" "$R/test-audit/SKILL.md" \
  || fail 1 "render did not rewrite the install root"

# 3. The state-root marker the resolver reads (bin/gstack-state-root.sh).
printf '%s\n' "$S" > "$R/.gstack-pack-state-root"

# 4. Quiet defaults for a host-managed install; an existing config is kept.
if [ ! -e "$S/config.yaml" ]; then
  printf 'telemetry: off\nupdate_check: false\nauto_upgrade: false\n' > "$S/config.yaml"
fi

# 5. The ready marker, last: a render without it is not ready.
VERSION="$(tr -d '[:space:]' < "$R/VERSION")"
printf '{"packMode":1,"stateRoot":"%s","version":"%s"}\n' "$S" "$VERSION" > "$R/.gstack-pack.json"
