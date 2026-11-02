// The old script depended on a plaintext credential fixture and obsolete controls.
// Reuse the isolated game-worker regression rather than modifying an existing room.
import { spawnSync } from 'node:child_process';
const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', 'tests/games-integration.test.ts'], { stdio: 'inherit', windowsHide: true });
process.exitCode = result.status ?? 1;
