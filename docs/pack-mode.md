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

`pack-mode.json` at the repo root holds `{"packMode": 1}`. A host reads it to
check that a commit supports this contract before it runs anything.

## What it writes

In order:

1. A copy of the source tree in `R`, without `.git/`, `test/`,
   `node_modules/`, `.github/` or any symlink.
2. The Claude skill docs, regenerated in `R` with
   `bun run R/scripts/gen-skill-docs.ts --host claude --out-dir R --install-root R --link-root R`
   (run with `cwd` = `R`, so the source tree is only read). Every `SKILL.md` and
   `sections/*.md` names `R` where it named `~/.claude/skills/gstack`,
   `$HOME/.claude/skills/gstack` or `${HOME}/.claude/skills/gstack`.
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
  skills that call `$B`, `$D` or `$P` do not work from a pack render.
- No writes to `~/.claude`, `~/.codex`, any other harness directory, harness
  settings or hooks, and no `~/.gstack`.
- No network calls.
- No install registry entry, so `./setup --status` and `gstack-upgrade` do not
  see a pack render. The host owns its lifecycle: it renders a new `R` per
  commit and deletes `R` and `S` to remove gstack.

Skills still write their own output when you invoke them, for example
`.gstack/` reports inside the project they run in.

## Test

`test/pack-mode.test.ts` runs pack mode under a temp `HOME` with network
commands stubbed to fail, and checks that `HOME` is unchanged, nothing reached
the network, the markers and config are right, no install-root token is left,
and `R/bin/gstack-skill-start` reports `S` as its state root.
