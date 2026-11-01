/**
 * pack-env — lets the browse, design and make-pdf CLIs find a pack render's
 * state root and Chromium without any launch env (docs/pack-mode.md).
 *
 * A host-managed pack render R holds .gstack-pack.json (pack mode), and
 * .gstack-pack-state-root / .gstack-pack-browsers-path (one absolute path
 * each). Inside `bun build --compile` import.meta.dir is `$bunfs`, so
 * lib/state-root.ts cannot see its marker; the binary's own path
 * (R/<tool>/dist/<bin>) still names R. applyPackEnv exports the markers as
 * env vars, which explicit env values always win over, and which the browse
 * daemon inherits.
 * Callers import lib/pack-env-apply.ts as their FIRST import, because some
 * modules resolve the state root at load time.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { STATE_ROOT_VARS, packMarkerRoot } from './state-root';

export const PACK_RENDER_MARKER = '.gstack-pack.json';
export const PACK_STATE_MARKER = '.gstack-pack-state-root';
export const PACK_BROWSERS_MARKER = '.gstack-pack-browsers-path';

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** The pack render root holding the running code, or null outside a render. */
export function packRootFor(metaDir: string = import.meta.dir, execPath: string = process.execPath): string | null {
  const candidates: string[] = [];
  if (!metaDir.includes('$bunfs')) candidates.push(path.resolve(metaDir, '..'), path.resolve(metaDir, '..', '..'));
  candidates.push(path.resolve(path.dirname(execPath), '..', '..'));
  return candidates.find((c) => isFile(path.join(c, PACK_RENDER_MARKER))) ?? null;
}

/**
 * Sets GSTACK_STATE_ROOT, PLAYWRIGHT_BROWSERS_PATH and
 * BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 when unset and the markers exist.
 * GSTACK_STATE_ROOT is left alone when any state-root variable is set, so an
 * explicit GSTACK_HOME still wins. Returns the root or null.
 */
export function applyPackEnv(env: Record<string, string | undefined> = process.env, root: string | null = packRootFor()): string | null {
  if (!root) return null;
  const stateRoot = packMarkerRoot(path.join(root, PACK_STATE_MARKER));
  if (stateRoot && !STATE_ROOT_VARS.some((name) => env[name])) env.GSTACK_STATE_ROOT = stateRoot;
  const browsers = packMarkerRoot(path.join(root, PACK_BROWSERS_MARKER));
  if (browsers && !env.PLAYWRIGHT_BROWSERS_PATH) env.PLAYWRIGHT_BROWSERS_PATH = browsers;
  if (!env.BUN_RUNTIME_TRANSPILER_CACHE_PATH) env.BUN_RUNTIME_TRANSPILER_CACHE_PATH = '0';
  return root;
}
