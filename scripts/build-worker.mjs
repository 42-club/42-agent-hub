import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const outfile = '.runtime/agent-worker.mjs';
await build({
  entryPoints: ['server/agent-worker.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  outfile,
  define: { 'process.env.HUB_TEST_FIXTURES': '"disabled"' },
  minifySyntax: true,
  external: ['pg-native'],
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
});
assert.doesNotMatch(await readFile(outfile, 'utf8'), /DemoModelClient|tests\/fixtures|【离线示例】/, 'Deployment worker must not contain offline fixtures');
