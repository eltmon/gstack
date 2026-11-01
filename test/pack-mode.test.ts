/**
 * Pack mode (docs/pack-mode.md): `setup --pack-root R --pack-state-root S`
 * renders every skill and its runtime into R, keeps all state in S, and
 * writes nothing else — no $HOME/.gstack, no $HOME/.claude, no network.
 *
 * Runs real bun under a temp HOME, with bun's own install and cache dirs
 * outside that HOME so bun's first-run cache is not mistaken for a gstack
 * write. curl/wget stubs and a git stub for network subcommands (fetch, pull,
 * clone, ls-remote, push, remote update/show) log to net.log and fail, so any
 * network attempt shows up as that file.
 * Does not use makeFixture(): it seeds home/.gstack/config.yaml.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { tree } from './helpers/install-fixture';

const ROOT = path.resolve(import.meta.dir, '..');
const SETUP = path.join(ROOT, 'setup');
const BASH = Bun.which('bash') ?? '/bin/bash';
const REAL_GIT = Bun.which('git') ?? '/usr/bin/git';
const BUN_DIR = path.dirname(Bun.which('bun') ?? process.execPath);
const OLD_TOKENS = ['~/.claude/skills/gstack', '$HOME/.claude/skills/gstack', '${HOME}/.claude/skills/gstack'];

let tmp: string, home: string, work: string, netLog: string, env: Record<string, string>;

function stub(dir: string, name: string, body: string): void {
  fs.writeFileSync(path.join(dir, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
}

function run(args: string[], extra: Record<string, string> = {}) {
  return spawnSync(BASH, args, { cwd: work, env: { ...env, ...extra }, encoding: 'utf-8', timeout: 120_000 });
}

function renderedDocs(r: string): string[] {
  const out: string[] = [];
  for (const skill of fs.readdirSync(r)) {
    const skillMd = path.join(r, skill, 'SKILL.md');
    if (fs.existsSync(skillMd)) out.push(skillMd);
    const sections = path.join(r, skill, 'sections');
    if (fs.existsSync(sections)) {
      for (const f of fs.readdirSync(sections)) if (f.endsWith('.md')) out.push(path.join(sections, f));
    }
  }
  return out;
}

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-pack-mode-')));
  home = path.join(tmp, 'home');
  work = path.join(tmp, 'work');
  netLog = path.join(tmp, 'net.log');
  const stubs = path.join(tmp, 'stubs');
  for (const d of [home, work, stubs, path.join(tmp, 'bun', 'install'), path.join(tmp, 'bun', 'cache')]) fs.mkdirSync(d, { recursive: true });
  stub(stubs, 'curl', `echo "curl $*" >> "${netLog}"; exit 1`);
  stub(stubs, 'wget', `echo "wget $*" >> "${netLog}"; exit 1`);
  stub(stubs, 'git', [
    'sub=""; next=""; skip=0',
    'for a in "$@"; do',
    '  if [ "$skip" = 1 ]; then skip=0; continue; fi',
    '  if [ -n "$sub" ]; then next="$a"; break; fi',
    '  case "$a" in -C|-c|--git-dir|--work-tree) skip=1 ;; -*) ;; *) sub="$a" ;; esac',
    'done',
    // `git remote get-url` reads local config; only `remote update`/`remote show` reach the network.
    'case "$sub:$next" in',
    `  fetch:*|pull:*|clone:*|ls-remote:*|push:*|remote:update|remote:show) echo "git $*" >> "${netLog}"; exit 1 ;;`,
    'esac',
    `exec "${REAL_GIT}" "$@"`,
  ].join('\n'));
  env = {
    HOME: home,
    PATH: `${stubs}:${BUN_DIR}:/usr/bin:/bin`,
    BUN_INSTALL: path.join(tmp, 'bun', 'install'),
    XDG_CACHE_HOME: path.join(tmp, 'bun', 'cache'),
    TMPDIR: path.join(tmp, 'bun', 'cache'),
  };
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('setup pack mode', () => {
  test('renders into R and S only, rewrites the install root, and runs the rendered runtime from S', () => {
    const R = path.join(tmp, 'pack', 'render');
    const S = path.join(tmp, 'pack', 'state');
    const before = tree(home);

    const r = run([SETUP, '--pack-root', R, '--pack-state-root', S]);
    expect(r.stderr).not.toContain('pack mode:');
    expect(r.status).toBe(0);
    expect(tree(home)).toEqual(before);
    expect(fs.existsSync(path.join(home, '.gstack'))).toBe(false);
    expect(fs.existsSync(path.join(home, '.claude'))).toBe(false);
    expect(fs.existsSync(netLog)).toBe(false);

    expect(JSON.parse(fs.readFileSync(path.join(R, '.gstack-pack.json'), 'utf-8')).packMode).toBe(1);
    expect(fs.readFileSync(path.join(R, '.gstack-pack-state-root'), 'utf-8').trim()).toBe(S);
    const config = fs.readFileSync(path.join(S, 'config.yaml'), 'utf-8');
    expect(config).toContain('telemetry: off');
    expect(config).toContain('update_check: false');

    const stale = renderedDocs(R).filter((f) => OLD_TOKENS.some((t) => fs.readFileSync(f, 'utf-8').includes(t)));
    expect(stale.map((f) => path.relative(R, f))).toEqual([]);
    expect(fs.readFileSync(path.join(R, 'test-audit', 'SKILL.md'), 'utf-8')).toContain(`${R}/bin/gstack-skill-start --skill "test-audit"`);
    const links = spawnSync('find', [R, '-type', 'l'], { encoding: 'utf-8' }).stdout.trim();
    expect(links).toBe('');

    const start = run([path.join(R, 'bin', 'gstack-skill-start'), '--skill', 'test-audit', '--model', 'claude'], { CLAUDECODE: '1' });
    expect(start.status).toBe(0);
    expect(start.stdout).toContain('SKILL_START_PROTO: 1');
    expect(start.stdout).toContain(`STATE_ROOT: ${S}`);
    expect(tree(home)).toEqual(before);
    expect(fs.existsSync(netLog)).toBe(false);
  }, 180_000);

  test('a second render keeps an existing S/config.yaml byte for byte', () => {
    const S = path.join(tmp, 'pack2', 'state');
    fs.mkdirSync(S, { recursive: true });
    fs.writeFileSync(path.join(S, 'config.yaml'), 'telemetry: community\n');
    const r = run([SETUP, '--pack-root', path.join(tmp, 'pack2', 'render'), '--pack-state-root', S]);
    expect(r.status).toBe(0);
    expect(fs.readFileSync(path.join(S, 'config.yaml'), 'utf-8')).toBe('telemetry: community\n');
  }, 180_000);

  test('a relative --pack-root exits 2 and writes nothing', () => {
    const S = path.join(tmp, 'pack3', 'state');
    const r = run([SETUP, '--pack-root', 'relative/path', '--pack-state-root', S]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('must be plain absolute paths');
    expect(fs.existsSync(S)).toBe(false);
    expect(fs.existsSync(path.join(work, 'relative'))).toBe(false);
  });

  test('a non-empty --pack-root exits 2', () => {
    const R = path.join(tmp, 'pack4', 'render');
    fs.mkdirSync(R, { recursive: true });
    fs.writeFileSync(path.join(R, 'keep'), 'x');
    const r = run([SETUP, '--pack-root', R, '--pack-state-root', path.join(tmp, 'pack4', 'state')]);
    expect(r.status).toBe(2);
    expect(fs.readdirSync(R)).toEqual(['keep']);
  });
});
