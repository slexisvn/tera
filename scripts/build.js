import { build } from 'esbuild';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const required = [
  resolve(root, 'notebook/dist/mlfw.esm.js'),
  resolve(root, 'notebook/dist/csv.esm.js'),
  resolve(root, 'notebook/dist/language-data.json'),
];

for (const file of required) {
  if (!existsSync(file)) {
    throw new Error(`Missing ${file}. Run npm run build once to generate notebook runtime assets.`);
  }
}

const shared = {
  bundle: true,
  platform: 'browser',
  target: ['es2022'],
  format: 'esm',
  minify: true,
  sourcemap: false,
  logLevel: 'info',
};

await Promise.all([
  build({
    ...shared,
    entryPoints: [resolve(root, 'notebook/notebook.js')],
    outfile: resolve(root, 'notebook/dist/notebook.js'),
  }),
  build({
    ...shared,
    entryPoints: [resolve(root, 'notebook/csv-worker.js')],
    outfile: resolve(root, 'notebook/dist/csv-worker.js'),
  }),
  build({
    ...shared,
    entryPoints: [resolve(root, 'notebook/kernel-worker.js')],
    outfile: resolve(root, 'notebook/dist/kernel-worker.js'),
  }),
]);

console.log('Notebook app bundle written to notebook/dist/');
