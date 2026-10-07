import { build } from 'esbuild';
await build({entryPoints:['server/agent-worker.ts'],bundle:true,platform:'node',format:'esm',target:'node24',outfile:'.runtime/agent-worker.mjs',external:['pg-native'],banner:{js:'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);'}});
