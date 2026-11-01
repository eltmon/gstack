/**
 * Pack env (lib/pack-env.ts): a pack render's markers reach the browse,
 * design and make-pdf CLIs and their children with no launch env.
 *
 * The compiled case builds a real `bun build --compile` probe into
 * <R>/browse/dist/, whose second import resolves the state root at load time
 * (as browse/src/security-classifier.ts does), and runs it with a bare env and
 * an empty HOME: it must print S, hand the browsers path to a child spawned
 * the way the daemons are, and leave HOME empty. Temp dirs only.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { applyPackEnv, packRootFor, PACK_RENDER_MARKER, PACK_STATE_MARKER, PACK_BROWSERS_MARKER } from '../lib/pack-env';
import { tree } from './helpers/install-fixture';

const ROOT = path.resolve(import.meta.dir, '..');
const BUN = Bun.which('bun') ?? process.execPath;

let tmp: string, r: string, s: string, browsers: string;

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-pack-env-')));
  r = path.join(tmp, 'render');
  s = path.join(tmp, 'state');
  browsers = path.join(tmp, 'browser', 'playwright');
  for (const d of [path.join(r, 'lib'), path.join(r, 'browse', 'dist'), s]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(r, PACK_RENDER_MARKER), '{"packMode":1}\n');
  fs.writeFileSync(path.join(r, PACK_STATE_MARKER), `${s}\n`);
  fs.writeFileSync(path.join(r, PACK_BROWSERS_MARKER), `${browsers}\n`);
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('packRootFor', () => {
  test('finds the render from source (lib/) and from a compiled binary under <R>/<tool>/dist/', () => {
    expect(packRootFor(path.join(r, 'lib'), '/usr/bin/bun')).toBe(r);
    expect(packRootFor('/$bunfs/root', path.join(r, 'browse', 'dist', 'browse'))).toBe(r);
  });

  test('returns null outside a render', () => {
    const plain = path.join(tmp, 'plain');
    fs.mkdirSync(path.join(plain, 'lib'), { recursive: true });
    expect(packRootFor(path.join(plain, 'lib'), path.join(plain, 'browse', 'dist', 'browse'))).toBeNull();
  });
});

describe('applyPackEnv', () => {
  test('sets the state root, the browsers path and the transpiler cache from the markers', () => {
    const env: Record<string, string | undefined> = {};
    expect(applyPackEnv(env, r)).toBe(r);
    expect(env).toEqual({
      GSTACK_STATE_ROOT: s,
      PLAYWRIGHT_BROWSERS_PATH: browsers,
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0',
    });
  });

  test('explicit env values win', () => {
    const env: Record<string, string | undefined> = { GSTACK_STATE_ROOT: '/preset', PLAYWRIGHT_BROWSERS_PATH: '/pw', BUN_RUNTIME_TRANSPILER_CACHE_PATH: '/cache' };
    applyPackEnv(env, r);
    expect(env).toEqual({ GSTACK_STATE_ROOT: '/preset', PLAYWRIGHT_BROWSERS_PATH: '/pw', BUN_RUNTIME_TRANSPILER_CACHE_PATH: '/cache' });
    const home: Record<string, string | undefined> = { GSTACK_HOME: '/gh' };
    applyPackEnv(home, r);
    expect(home.GSTACK_STATE_ROOT).toBeUndefined();
  });

  test('outside a render sets nothing', () => {
    const env: Record<string, string | undefined> = {};
    expect(applyPackEnv(env, null)).toBeNull();
    expect(env).toEqual({});
  });

  test('a render without the browser step sets no browsers path', () => {
    const bare = path.join(tmp, 'bare');
    fs.mkdirSync(bare, { recursive: true });
    fs.writeFileSync(path.join(bare, PACK_RENDER_MARKER), '{"packMode":1}\n');
    fs.writeFileSync(path.join(bare, PACK_STATE_MARKER), `${s}\n`);
    const env: Record<string, string | undefined> = {};
    applyPackEnv(env, bare);
    expect(env.GSTACK_STATE_ROOT).toBe(s);
    expect(env.PLAYWRIGHT_BROWSERS_PATH).toBeUndefined();
  });
});

describe('compiled binary', () => {
  test('a load-time state-root read in a compiled binary sees S, and children inherit the env; HOME stays empty', () => {
    const src = path.join(tmp, 'probe-src');
    const buildHome = path.join(tmp, 'build-home');
    const runHome = path.join(tmp, 'run-home');
    for (const d of [src, buildHome, runHome]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(src, 'root.ts'),
      `import { resolveStateRoot } from ${JSON.stringify(path.join(ROOT, 'lib', 'state-root'))};\nexport const STATE = resolveStateRoot();\n`);
    fs.writeFileSync(path.join(src, 'entry.ts'), [
      `import ${JSON.stringify(path.join(ROOT, 'lib', 'pack-env-apply'))};`,
      `import { STATE } from './root';`,
      `import { spawnSync } from 'child_process';`,
      // Bun hands a child its startup env unless env is passed, so the daemons
      // (browse/src/cli.ts, design/src/daemon-client.ts) spawn with
      // { ...process.env }; the probe does the same.
      `const child = spawnSync('sh', ['-c', 'printf "%s|%s" "$PLAYWRIGHT_BROWSERS_PATH" "$BUN_RUNTIME_TRANSPILER_CACHE_PATH"'], { encoding: 'utf-8', env: { ...process.env } });`,
      `console.log(STATE);`,
      `console.log(child.stdout);`,
      '',
    ].join('\n'));
    const probe = path.join(r, 'browse', 'dist', 'probe');
    const build = spawnSync(BUN, ['build', '--compile', '--no-compile-autoload-dotenv', '--no-compile-autoload-bunfig', path.join(src, 'entry.ts'), '--outfile', probe], {
      cwd: src,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: buildHome, BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0', TMPDIR: tmp },
      encoding: 'utf-8',
      timeout: 120_000,
    });
    expect(build.stderr + build.stdout).not.toContain('error');
    expect(build.status).toBe(0);

    const run = spawnSync(probe, [], { cwd: tmp, env: { PATH: '/usr/bin:/bin', HOME: runHome }, encoding: 'utf-8', timeout: 30_000 });
    expect(run.status).toBe(0);
    expect(run.stdout.split('\n').slice(0, 2)).toEqual([s, `${browsers}|0`]);
    expect(tree(runHome)).toEqual({});

    const preset = spawnSync(probe, [], { cwd: tmp, env: { PATH: '/usr/bin:/bin', HOME: runHome, GSTACK_STATE_ROOT: '/preset' }, encoding: 'utf-8', timeout: 30_000 });
    expect(preset.stdout.split('\n')[0]).toBe('/preset');
  }, 180_000);
});
