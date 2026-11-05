import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';
import assert from 'node:assert/strict';

const archive = 'vendor/42-agent-0.1.0.tgz';
const sha256 = createHash('sha256').update(await readFile(archive)).digest('hex');
const sourceAt = process.argv.indexOf('--source');
if (sourceAt === -1) {
  const manifest = JSON.parse(await readFile('vendor/42-agent.provenance.json', 'utf8'));
  assert.equal(sha256, manifest.sha256, 'Agent archive changed: verify source and update provenance before building');
  console.log(`Verified ${archive} (${sha256.slice(0, 12)}), source ${manifest.sourceCommit}`);
} else {
  const source = resolve(process.argv[sourceAt + 1]);
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: source, encoding: 'utf8' }).trim(), '', 'Agent source must be clean');
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim();
  const directory = await mkdtemp(join(tmpdir(), 'hub-vendor-'));
  try {
    const entries = execFileSync('tar', ['-tf', archive], { encoding: 'utf8' }).trim().split(/\r?\n/);
    assert.ok(entries.every((name) => name.startsWith('package/') && !name.split('/').includes('..')), 'Unsafe archive path');
    execFileSync('tar', ['-xf', resolve(archive), '-C', directory]);
    const built = join(directory, 'built');
    execFileSync(process.execPath, [join(source, 'node_modules/typescript/bin/tsc'), '-p', join(source, 'tsconfig.json'), '--outDir', built], { stdio: 'pipe' });
    async function files(root, base = root) {
      const result = [];
      for (const entry of await readdir(root, { withFileTypes: true })) {
        const path = join(root, entry.name);
        if (entry.isDirectory()) result.push(...await files(path, base));
        else result.push(relative(base, path).replaceAll('\\', '/'));
      }
      return result.sort();
    }
    const packedRoot = join(directory, 'package/dist/src'), builtRoot = join(built, 'src');
    const packed = await files(packedRoot), compiled = await files(builtRoot);
    assert.deepEqual(packed, compiled, 'Packed runtime file list differs from the declared source');
    for (const file of packed) {
      const normalize = (value) => value.replaceAll('\r\n', '\n');
      const actual = normalize(await readFile(join(packedRoot, file), 'utf8'));
      const expected = normalize(await readFile(join(builtRoot, file), 'utf8'));
      assert.equal(createHash('sha256').update(actual).digest('hex'), createHash('sha256').update(expected).digest('hex'), `Runtime artifact differs: ${file}`);
    }
    console.log(JSON.stringify({ archive, sha256, sourceRepository: 'https://github.com/42-club/42-agent.git', sourceCommit, verifiedRuntimeFiles: packed.length, scope: 'All dist/src JavaScript and declarations match a fresh source build after CRLF/LF normalization. Archive docs and package scripts reflect its original packaging.' }, null, 2));
  } finally { await rm(directory, { recursive: true, force: true }); }
}
