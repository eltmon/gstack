/**
 * Pack renders never install themselves (docs/pack-mode.md). In a
 * host-managed render (.gstack-pack.json next to bin/), gstack-browser-ensure
 * never runs `bun install` or `playwright install`: it reads the Chromium
 * cache from .gstack-pack-browsers-path and fails with the host's fix line.
 * A plain ./setup inside a render exits 2 before any write. Outside a render
 * both behave as before.
 *
 * Stub `bun` and `node` log their argv to calls.log and exit 1, so any install
 * attempt shows up there. The setup case renders with real bun under an empty
 * temp HOME, with curl/wget/git network stubs, as test/pack-mode.test.ts does.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { tree } from './helpers/install-fixture';

const ROOT = path.resolve(import.meta.dir, '..');
const BASH = Bun.which('bash') ?? '/bin/bash';
const REAL_GIT = Bun.which('git') ?? '/usr/bin/git';
const BUN_DIR = path.dirname(Bun.which('bun') ?? process.execPath);
const FIX = 'fix: pan skills pack browser gstack on';

let tmp: string;

function stub(dir: string, name: string, body: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
}

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-pack-guards-')));
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** A gstack root holding a copy of gstack-browser-ensure; `pack` adds .gstack-pack.json. */
function ensureFixture(name: string, opts: { pack: boolean; playwright?: boolean; browsersPath?: string }) {
  const base = path.join(tmp, name);
  const root = path.join(base, 'gstack');
  const stubs = path.join(base, 'stubs');
  const calls = path.join(base, 'calls.log');
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'bin/gstack-browser-ensure'), path.join(root, 'bin/gstack-browser-ensure'));
  fs.chmodSync(path.join(root, 'bin/gstack-browser-ensure'), 0o755);
  if (opts.pack) fs.writeFileSync(path.join(root, '.gstack-pack.json'), '{"packMode":1}\n');
  if (opts.browsersPath) fs.writeFileSync(path.join(root, '.gstack-pack-browsers-path'), `${opts.browsersPath}\n`);
  if (opts.playwright) {
    fs.mkdirSync(path.join(root, 'node_modules/playwright'), { recursive: true });
    fs.writeFileSync(path.join(root, 'node_modules/playwright/package.json'), '{"name":"playwright"}\n');
  }
  // Every call is logged with the browsers path it saw; nothing succeeds.
  for (const tool of ['bun', 'node']) stub(stubs, tool, `echo "${tool} $* PLAYWRIGHT_BROWSERS_PATH=\${PLAYWRIGHT_BROWSERS_PATH:-}" >> "${calls}"; exit 1`);
  const home = path.join(base, 'home');
  fs.mkdirSync(home, { recursive: true });
  const run = (args: string[] = []) => spawnSync(BASH, [path.join(root, 'bin/gstack-browser-ensure'), ...args], {
    encoding: 'utf-8',
    env: { PATH: `${stubs}:/usr/bin:/bin`, HOME: home, TMPDIR: base, GSTACK_PLAYWRIGHT_INSTALL_TIMEOUT: '5' },
    timeout: 60_000,
  });
  const log = () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf-8') : '');
  return { root, home, run, log };
}

const lastLine = (s: string) => s.trim().split('\n').at(-1);

describe('gstack-browser-ensure in a pack render', () => {
  test('missing playwright fails with the host fix and never installs', () => {
    const f = ensureFixture('no-modules', { pack: true });
    const r = f.run();
    expect(r.status).toBe(1);
    expect(lastLine(r.stdout)).toBe('BROWSER_UNAVAILABLE pack browser runtime not built');
    expect(r.stderr).toContain(FIX);
    expect(f.log()).not.toContain('install');
    expect(tree(f.home)).toEqual({});
  });

  test('a failed probe fails with the host fix, never installs, and probes with the marker\'s browsers path', () => {
    const browsers = path.join(tmp, 'cache', 'playwright');
    const f = ensureFixture('probe-fails', { pack: true, playwright: true, browsersPath: browsers });
    const r = f.run();
    expect(r.status).toBe(1);
    expect(lastLine(r.stdout)).toMatch(/^BROWSER_UNAVAILABLE pack browser runtime not built, or Chromium did not launch via node/);
    expect(r.stderr).toContain(FIX);
    expect(f.log()).toContain(`node -e`);
    expect(f.log()).toContain(`PLAYWRIGHT_BROWSERS_PATH=${browsers}`);
    expect(f.log()).not.toContain('install');
  });

  test('outside a render --check keeps today\'s message', () => {
    const f = ensureFixture('plain', { pack: false });
    const r = f.run(['--check']);
    expect(r.status).toBe(1);
    expect(lastLine(r.stdout)).toBe(`BROWSER_UNAVAILABLE playwright is not installed under ${f.root}/node_modules`);
    expect(r.stderr).toContain(`fix: cd ${f.root} && ./setup`);
    expect(f.log()).toBe('');
  });
});

describe('setup in a pack render', () => {
  test('a plain ./setup inside a render exits 2 before any write', () => {
    const home = path.join(tmp, 'setup-home');
    const work = path.join(tmp, 'setup-work');
    const stubs = path.join(tmp, 'setup-stubs');
    const netLog = path.join(tmp, 'net.log');
    for (const d of [home, work, path.join(tmp, 'setup-tmpdir')]) fs.mkdirSync(d, { recursive: true });
    stub(stubs, 'curl', `echo "curl $*" >> "${netLog}"; exit 1`);
    stub(stubs, 'wget', `echo "wget $*" >> "${netLog}"; exit 1`);
    stub(stubs, 'git', [
      'for a in "$@"; do case "$a" in fetch|pull|clone|ls-remote|push) echo "git $*" >> "' + netLog + '"; exit 1 ;; esac; done',
      `exec "${REAL_GIT}" "$@"`,
    ].join('\n'));
    const env = { HOME: home, PATH: `${stubs}:${BUN_DIR}:/usr/bin:/bin`, TMPDIR: path.join(tmp, 'setup-tmpdir') };
    const R = path.join(tmp, 'pack', 'render');
    const S = path.join(tmp, 'pack', 'state');

    const render = spawnSync(BASH, [path.join(ROOT, 'setup'), '--pack-root', R, '--pack-state-root', S], { cwd: work, env, encoding: 'utf-8', timeout: 120_000 });
    expect(render.status).toBe(0);
    expect(fs.existsSync(path.join(R, '.gstack-pack.json'))).toBe(true);
    const before = tree(R);

    const plain = spawnSync(BASH, [path.join(R, 'setup')], { cwd: work, env, encoding: 'utf-8', timeout: 60_000 });
    expect(plain.status).toBe(2);
    expect(plain.stderr.trim()).toBe(`setup: this is a host-managed pack render (${R}); the host installs it`);
    expect(tree(home)).toEqual({});
    expect(tree(R)).toEqual(before);
    expect(fs.existsSync(netLog)).toBe(false);
  }, 180_000);
});
