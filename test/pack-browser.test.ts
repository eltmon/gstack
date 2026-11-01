/**
 * Pack browser (docs/pack-mode.md): `setup --pack-browser R
 * --pack-browser-cache C` runs only the pinned commands, in order, with bun's
 * cache and Chromium in C, writes only R and C, and on failure leaves R a
 * ready plain render.
 *
 * R is a real render (`setup --pack-root`, real bun, offline). The browser
 * step then runs with a stub `bun` first on PATH that logs every call with
 * its env and cwd and fakes each output, and a stub `node` that answers the
 * gstack-browser-ensure probe with RENDER_OK. Nothing is downloaded.
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
const BUN_DIR = path.dirname(Bun.which('bun') ?? process.execPath);
const BINARIES = ['browse/dist/browse', 'browse/dist/find-browse', 'design/dist/design', 'make-pdf/dist/pdf', 'bin/gstack-global-discover'];
const COMPILE = 'build --compile --no-compile-autoload-dotenv --no-compile-autoload-bunfig';

let tmp: string, home: string, work: string, stubs: string, netStubs: string;
let caseNo = 0;

function stub(dir: string, name: string, body: string): void {
  fs.writeFileSync(path.join(dir, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
}

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-pack-browser-')));
  home = path.join(tmp, 'home');
  work = path.join(tmp, 'work');
  stubs = path.join(tmp, 'stubs');
  netStubs = path.join(tmp, 'net-stubs');
  for (const d of [home, work, stubs, netStubs, path.join(tmp, 'tmpdir')]) fs.mkdirSync(d, { recursive: true });
  stub(netStubs, 'curl', 'exit 1');
  stub(netStubs, 'wget', 'exit 1');
  // One log line per call: argv, then the env and cwd it ran with.
  stub(stubs, 'bun', [
    'printf "%s\\tCACHE=%s\\tPW=%s\\tTC=%s\\tPWD=%s\\n" "$*" "${BUN_INSTALL_CACHE_DIR:-}" "${PLAYWRIGHT_BROWSERS_PATH:-}" "${BUN_RUNTIME_TRANSPILER_CACHE_PATH:-}" "$PWD" >> "$STUB_LOG"',
    'case "$*" in *"${STUB_FAIL_ON:-<none>}"*) exit 3 ;; esac',
    'case "$1" in',
    '  --version) echo "${STUB_BUN_VERSION:-1.4.2}" ;;',
    '  install) mkdir -p node_modules/playwright && echo \'{"name":"playwright"}\' > node_modules/playwright/package.json ;;',
    '  run) [ "$2" = vendor:xterm ] && mkdir -p extension/lib && echo xterm > extension/lib/xterm.js ;;',
    '  build) out=""; prev=""; for a in "$@"; do [ "$prev" = --outfile ] && out="$a"; prev="$a"; done; mkdir -p "$(dirname "$out")"; echo bin > "$out" ;;',
    '  x) [ "$2 $3" = "playwright install" ] && mkdir -p "$PLAYWRIGHT_BROWSERS_PATH/chromium-1" ;;',
    'esac',
    'exit 0',
  ].join('\n'));
  stub(stubs, 'node', 'echo "RENDER_OK 1.0"');
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** A fresh ready render R (real bun, offline), plus the cache path C and a log file. */
function fixture() {
  const dir = path.join(tmp, `case-${++caseNo}`);
  const R = path.join(dir, 'render');
  const S = path.join(dir, 'state');
  const C = path.join(dir, 'browser');
  const log = path.join(dir, 'bun.log');
  const r = spawnSync(BASH, [SETUP, '--pack-root', R, '--pack-state-root', S], {
    cwd: work,
    env: { HOME: home, PATH: `${netStubs}:${BUN_DIR}:/usr/bin:/bin`, TMPDIR: path.join(tmp, 'tmpdir') },
    encoding: 'utf-8',
    timeout: 120_000,
  });
  expect(r.status).toBe(0);
  const run = (args: string[], extra: Record<string, string> = {}) => spawnSync(BASH, [SETUP, ...args], {
    cwd: work,
    env: { HOME: home, PATH: `${stubs}:/usr/bin:/bin`, TMPDIR: path.join(tmp, 'tmpdir'), STUB_LOG: log, ...extra },
    encoding: 'utf-8',
    timeout: 120_000,
  });
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf-8').trim().split('\n').filter(Boolean) : []);
  return { R, S, C, run, calls };
}

const argv = (line: string) => line.split('\t')[0];
const field = (line: string, name: string) => line.split('\t').find((f) => f.startsWith(`${name}=`))!.slice(name.length + 1);

describe('setup --pack-browser', () => {
  test('runs only the pinned commands in order, with the cache in C, and writes only R and C', () => {
    const f = fixture();
    const r = f.run(['--pack-browser', f.R, '--pack-browser-cache', f.C]);
    expect(r.stderr).not.toContain('pack browser:');
    expect(r.status).toBe(0);

    const calls = f.calls().filter((l) => argv(l) !== '--version');
    expect(calls.map(argv)).toEqual([
      'install --production --frozen-lockfile',
      'run vendor:xterm',
      `${COMPILE} browse/src/cli.ts --outfile browse/dist/browse`,
      `${COMPILE} browse/src/find-browse.ts --outfile browse/dist/find-browse`,
      `${COMPILE} design/src/cli.ts --outfile design/dist/design`,
      `${COMPILE} make-pdf/src/cli.ts --outfile make-pdf/dist/pdf`,
      `${COMPILE} bin/gstack-global-discover.ts --outfile bin/gstack-global-discover`,
      'x playwright install chromium',
    ]);
    const all = f.calls().map(argv).join('\n');
    expect(all).not.toContain('--lockfile-only');
    expect(all).not.toContain('run build');
    for (const line of calls) {
      expect(field(line, 'CACHE')).toBe(path.join(f.C, 'bun-cache'));
      expect(field(line, 'TC')).toBe('0');
      expect(field(line, 'PWD')).toBe(f.R);
    }
    expect(field(calls.at(-1)!, 'PW')).toBe(path.join(f.C, 'playwright'));

    const version = fs.readFileSync(path.join(f.R, 'VERSION'), 'utf-8').trim();
    for (const v of ['browse/dist/.version', 'design/dist/.version', 'make-pdf/dist/.version']) {
      expect(fs.readFileSync(path.join(f.R, v), 'utf-8').trim()).toBe(version);
    }
    for (const bin of BINARIES) expect(fs.statSync(path.join(f.R, bin)).mode & 0o111).not.toBe(0);
    expect(fs.readFileSync(path.join(f.R, '.gstack-pack-browsers-path'), 'utf-8').trim()).toBe(path.join(f.C, 'playwright'));
    const marker = JSON.parse(fs.readFileSync(path.join(f.R, '.gstack-pack-browser.json'), 'utf-8'));
    expect(marker).toEqual({ packBrowser: 1, browsersPath: path.join(f.C, 'playwright'), version });
    expect(tree(home)).toEqual({});
    // No skill re-render: the docs still name R, never ~/.claude.
    expect(fs.readFileSync(path.join(f.R, 'test-audit', 'SKILL.md'), 'utf-8')).toContain(`${f.R}/bin/gstack-skill-start --skill "test-audit"`);
  }, 180_000);

  test('bun below the security floor exits 1 before any write', () => {
    const f = fixture();
    const r = f.run(['--pack-browser', f.R, '--pack-browser-cache', f.C], { STUB_BUN_VERSION: '1.3.2' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("pack browser: bun 1.3.2 is below gstack's security floor");
    expect(f.calls().map(argv)).toEqual(['--version']);
    expect(fs.existsSync(path.join(f.R, 'node_modules'))).toBe(false);
    expect(fs.existsSync(path.join(f.R, '.gstack-pack-browser.json'))).toBe(false);
    expect(fs.existsSync(path.join(f.R, '.gstack-pack-browsers-path'))).toBe(false);
    expect(fs.existsSync(f.C)).toBe(false);
  }, 180_000);

  test('a failed Chromium download removes everything the step added and leaves a ready plain render', () => {
    const f = fixture();
    const r = f.run(['--pack-browser', f.R, '--pack-browser-cache', f.C], { STUB_FAIL_ON: 'x playwright' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('pack browser: bun x playwright install chromium failed');
    expect(fs.existsSync(path.join(f.R, 'node_modules'))).toBe(false);
    for (const bin of BINARIES) expect(fs.existsSync(path.join(f.R, bin))).toBe(false);
    expect(fs.existsSync(path.join(f.R, 'extension', 'lib', 'xterm.js'))).toBe(false);
    expect(fs.existsSync(path.join(f.R, '.gstack-pack-browser.json'))).toBe(false);
    expect(fs.existsSync(path.join(f.R, '.gstack-pack-browsers-path'))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(f.R, '.gstack-pack.json'), 'utf-8')).packMode).toBe(1);
  }, 180_000);

  test('an R that is not a ready render, or a relative cache, exits 2 and writes nothing', () => {
    const f = fixture();
    const notRender = path.join(tmp, 'not-a-render');
    fs.mkdirSync(notRender, { recursive: true });
    const r = f.run(['--pack-browser', notRender, '--pack-browser-cache', f.C]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(`pack browser: ${notRender} is not a ready pack render`);
    expect(fs.readdirSync(notRender)).toEqual([]);
    expect(fs.existsSync(f.C)).toBe(false);

    const rel = f.run(['--pack-browser', f.R, '--pack-browser-cache', 'relative/cache']);
    expect(rel.status).toBe(2);
    expect(rel.stderr).toContain('must be plain absolute paths');
    expect(fs.existsSync(path.join(work, 'relative'))).toBe(false);
    expect(f.calls()).toEqual([]);
  }, 180_000);
});
