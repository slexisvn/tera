import { build } from 'esbuild';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const extRoot = resolve(here, '..');
const root = resolve(extRoot, '..');
const outdir = resolve(extRoot, 'media');
const stub = resolve(here, 'native-stub.js');

const nodeBundle = resolve(root, 'dist/index.node.js');
if (!existsSync(nodeBundle)) {
  throw new Error(`Missing ${nodeBundle}. Run "npm run build" at repo root first.`);
}

await Promise.all([
  build({
    entryPoints: [resolve(root, 'notebook/src/workers/kernel-server.ts')],
    outfile: resolve(outdir, 'kernel-server.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: ['node18'],
    minify: true,
    logLevel: 'info',
    alias: { webgpu: stub },
    external: ['koffi'],
  }),
  build({
    entryPoints: [resolve(root, 'notebook/src/vscode/chart-renderer.ts')],
    outfile: resolve(outdir, 'chart-renderer.mjs'),
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: ['es2022'],
    minify: true,
    logLevel: 'info',
    loader: { '.css': 'text' },
  }),
]);

console.log('VSCode notebook kernel server + renderer written to vscode-ext/media/');
