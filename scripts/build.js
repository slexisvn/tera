import { build } from 'esbuild';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const dist = resolve(root, 'dist');
const notebookDist = resolve(root, 'notebook/dist');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const dependencyNames = Object.keys(pkg.dependencies ?? {});

rmSync(dist, { recursive: true, force: true });
rmSync(resolve(root, 'notebook/dist'), { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
mkdirSync(notebookDist, { recursive: true });

const shared = {
  bundle: true,
  format: 'esm',
  target: ['es2022'],
  minify: true,
  keepNames: true,
  sourcemap: false,
  logLevel: 'info',
};

const optionalDistributedPlugin = {
  name: 'optional-distributed-query-engine',
  setup(build) {
    build.onResolve({ filter: /distributed\/.*\.js$/ }, (args) => ({
      path: args.path,
      external: true,
    }));
  },
};

await Promise.all([
  build({
    ...shared,
    platform: 'node',
    entryPoints: [resolve(root, 'src/index.js')],
    outfile: resolve(dist, 'index.node.js'),
    external: [...dependencyNames, '*.node'],
  }),
  build({
    ...shared,
    platform: 'browser',
    entryPoints: [resolve(root, 'src/notebook/index.js')],
    outfile: resolve(dist, 'index.browser.js'),
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [optionalDistributedPlugin],
    external: ['*.node'],
  }),
  build({
    ...shared,
    platform: 'browser',
    entryPoints: [resolve(root, 'src/notebook/csv-worker.js')],
    outfile: resolve(notebookDist, 'csv-worker.js'),
  }),
]);

console.log('Build written to dist/index.node.js, dist/index.browser.js, and notebook/dist/csv-worker.js.');
