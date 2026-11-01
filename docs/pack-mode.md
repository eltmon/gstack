# Pack mode

Pack mode renders every gstack skill and its runtime into a directory a host
chooses, keeps all gstack state in a second directory the host chooses, and
writes nothing else. It exists for hosts such as Overdeck that mount skills
into an agent themselves and need to turn gstack on per project, or remove it,
without touching the user's own install.

A normal `./setup` is unchanged. Pack mode runs only when you pass
`--pack-root`.

## Run it

From a gstack checkout (or any extracted copy of one), with `bun` on `PATH`:

```bash
bash setup --pack-root /home/you/.overdeck/packs/gstack/render/<commit> \
           --pack-state-root /home/you/.overdeck/packs/gstack/state
```

Both paths must be absolute and use only letters, digits and `. _ - + @ /`,
because skills splice the render root into shell lines unquoted. Otherwise
setup exits 2 and writes nothing. The render root (`R`) must be absent or
empty. The state root (`S`) may already exist and is shared across renders.
Neither may sit inside the source tree.

`pack-mode.json` at the repo root holds `{"packMode": 1, "packBrowser": 1}`. A
host reads it to check that a commit supports this contract (`packMode`) and the
browser step below (`packBrowser`) before it runs anything.

## What it writes

In order:

1. A copy of the source tree in `R`, without `.git/`, `test/`,
   `node_modules/`, `.github/` or any symlink.
2. The Claude skill docs, regenerated in `R` with
   `bun run R/scripts/gen-skill-docs.ts --host claude --out-dir R --install-root R --link-root R`
   (run with `cwd` = `R`, so the source tree is only read). Every `SKILL.md` and
   `sections/*.md` names `R` where it named `~/.claude/skills/gstack`,
   `$HOME/.claude/skills/gstack` or `${HOME}/.claude/skills/gstack`. Then every
   `~/.gstack/`, `$HOME/.gstack/` or `${HOME}/.gstack/` in those files is
   rewritten to `S/`, so state paths the skill prose names land in `S`.
3. `R/.gstack-pack-state-root`: one line holding `S`. The state-root resolver
   reads it (see [state-root.md](state-root.md)), so every `R/bin/...` script
   keeps its state in `S` with no environment variable, from any harness, and
   `gstack-paths` puts the plan dir at `S/plans`.
4. `S/config.yaml` with `telemetry: off`, `update_check: false` and
   `auto_upgrade: false`, only when the file does not exist. An existing config
   is left byte for byte.
5. `R/.gstack-pack.json` =
   `{"packMode":1,"stateRoot":"<S>","version":"<VERSION>"}`, last. A render
   without this file is not ready; a host should delete it and render again.

Skills keep their bare names (no `gstack-` prefix). The host adds its own
namespace when it mounts them.

## What it never does

- No `bun install`, no `bun run build`, no Playwright or font download, no
  `brew`. The `browse`, `design` and `make-pdf` binaries are not built, so
  skills that call `$B`, `$D` or `$P` do not work from a pack render until the
  host runs the separate [pack browser](#pack-browser) step.
- No writes to `~/.claude`, `~/.codex`, any other harness directory, harness
  settings or hooks, and no `~/.gstack`.
- No network calls.
- No install registry entry, so `./setup --status` and `gstack-upgrade` do not
  see a pack render. The host owns its lifecycle: it renders a new `R` per
  commit and deletes `R` and `S` to remove gstack.

Skills still write their own output when you invoke them, for example
`.gstack/` reports inside the project they run in.

## Pack browser

A second, separate step builds the browse, design and make-pdf runtime into a
ready render, so skills that call `$B`, `$D` or `$P` work. It downloads, so a
host should ask the user first. From the same extraction, with `bun` on `PATH`:

```bash
bash setup --pack-browser /home/you/.overdeck/packs/gstack/render/<commit> \
           --pack-browser-cache /home/you/.overdeck/packs/gstack/browser
```

Both paths must be absolute and plain, as above. `--pack-browser` (`R`) must be
a ready render (`R/.gstack-pack.json` with `packMode: 1`); the cache (`C`) may
be shared across commits and must sit outside the source tree. Bun below
gstack's security floor (`bin/gstack-bun-version.sh`) exits 1. These checks
run before any write. `--pack-root` and `--pack-browser` cannot be combined.

`scripts/pack-browser.sh` runs, with `cwd` = `R`,
`BUN_INSTALL_CACHE_DIR=C/bun-cache`, `BUN_RUNTIME_TRANSPILER_CACHE_PATH=0` and
`PLAYWRIGHT_BROWSERS_PATH=C/playwright`:

1. `bun install --production --frozen-lockfile` (npm registry packages from
   `bun.lock` into `R/node_modules`).
2. `bun run vendor:xterm` (copies xterm into `R/extension/lib/`).
3. The five `bun build --compile` lines from `scripts/build.sh`:
   `R/browse/dist/browse`, `R/browse/dist/find-browse`, `R/design/dist/design`,
   `R/make-pdf/dist/pdf`, `R/bin/gstack-global-discover`. On macOS Apple
   Silicon they are re-signed ad hoc, as `setup` does.
4. The three `dist/.version` files, from `R/VERSION`.
5. `bun x playwright install chromium` into `C/playwright` (the Playwright CDN,
   about 115 MiB), bounded by `GSTACK_PLAYWRIGHT_INSTALL_TIMEOUT` (default
   600 s).
6. `R/.gstack-pack-browsers-path`: one line holding `C/playwright`. Then
   `R/bin/gstack-browser-ensure --check --quiet` must print `BROWSER_OK`.
7. `R/.gstack-pack-browser.json` =
   `{"packBrowser":1,"browsersPath":"<C>/playwright","version":"<VERSION>"}`,
   last. A render without it has no browser runtime.

On any failure after the checks it removes `R/node_modules`, the five
binaries, the vendored xterm files, the `.version` files and both browser
markers, so `R` is again a ready plain render.

It never runs `scripts/build.sh` (which re-renders every skill with the
`~/.claude` install root), CSO, `browse/scripts/build-node-server.sh`, a font
install, `--with-deps` or any system package install, and never rewrites the
lockfile (`--lockfile-only`).

### Markers instead of environment

A host sets no gstack environment at launch. `lib/pack-env.ts`, the first
import of the `browse`, `design` and `make-pdf` CLIs, finds the render from
the running code (`import.meta.dir`, or the compiled binary's own path) and
exports `GSTACK_STATE_ROOT` (from `.gstack-pack-state-root`),
`PLAYWRIGHT_BROWSERS_PATH` (from `.gstack-pack-browsers-path`) and
`BUN_RUNTIME_TRANSPILER_CACHE_PATH=0` when they are unset. The browse and
design daemons inherit them. `bin/gstack-browser-ensure` reads the same
browsers-path marker.

### Renders never install themselves

Inside a render, `bin/gstack-browser-ensure` never runs `bun install` or
`playwright install`; when the runtime is missing it prints
`BROWSER_UNAVAILABLE pack browser runtime not built` with the host's fix. A
plain `./setup` (no `--pack-*` flag) inside a render exits 2 before any write:
`setup: this is a host-managed pack render (<R>); the host installs it`.

## Test

`test/pack-mode.test.ts` runs pack mode under a temp `HOME` with network
commands stubbed to fail, and checks that `HOME` is unchanged, nothing reached
the network, the markers and config are right, no install-root token is left,
and `R/bin/gstack-skill-start` reports `S` as its state root.
