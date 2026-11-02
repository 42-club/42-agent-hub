import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const repositories = { hub: process.cwd(), service: resolve(process.env.HUB_SERVICE_SOURCE || '../42-agent-service'), agent: resolve(process.env.HUB_AGENT_SOURCE || '../42-agent') };
const result = { generatedAt: new Date().toISOString(), protocol: 2, repositories: {}, vendor: JSON.parse(await readFile('vendor/42-agent.provenance.json', 'utf8')) };
for (const [name, cwd] of Object.entries(repositories)) {
  const git = (args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  const files = git(['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean).sort();
  const hash = createHash('sha256');
  for (const file of files) {
    // Never inspect environment/secrets, including accidentally tracked env files.
    if (file.split('/').some((part) => part.startsWith('.env') || part === '.vercel')) continue;
    try { hash.update(file); hash.update('\0'); hash.update(createHash('sha256').update(await readFile(join(cwd, file))).digest()); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  result.repositories[name] = { commit: git(['rev-parse', 'HEAD']), branch: git(['branch', '--show-current']), dirty: Boolean(git(['status', '--porcelain'])), contentSha256: hash.digest('hex') };
}
console.log(JSON.stringify(result, null, 2));
