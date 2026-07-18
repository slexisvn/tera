import { build, type BuildOptions } from "esbuild";
import { existsSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generate } from "./generate.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = resolve(HERE, "..");
const ROOT = resolve(EXT_ROOT, "..");
const DIST = resolve(EXT_ROOT, "dist");

const RUNTIME_BUNDLE = resolve(ROOT, "dist/index.node.js");
const NATIVE_STUB = resolve(HERE, "native-stub.ts");

const watch = process.argv.includes("--watch");

const shared: BuildOptions = {
  bundle: true,
  minify: !watch,
  sourcemap: watch,
  logLevel: "info",
  legalComments: "none",
};

const NODE_ESM_BANNER = {
  js: [
    "import { createRequire as __createRequire } from 'node:module';",
    "import { fileURLToPath as __fileURLToPath } from 'node:url';",
    "import { dirname as __dirname_of } from 'node:path';",
    "const require = __createRequire(import.meta.url);",
    "const __filename = __fileURLToPath(import.meta.url);",
    "const __dirname = __dirname_of(__filename);",
  ].join("\n"),
};

const targets: BuildOptions[] = [
  {
    ...shared,
    entryPoints: [resolve(EXT_ROOT, "src/client/extension.ts")],
    outfile: resolve(DIST, "extension.cjs"),
    platform: "node",
    format: "cjs",
    target: ["node20"],
    external: ["vscode"],
  },
  {
    ...shared,
    entryPoints: [resolve(EXT_ROOT, "src/server/index.ts")],
    outfile: resolve(DIST, "server.mjs"),
    platform: "node",
    format: "esm",
    target: ["node20"],
    banner: NODE_ESM_BANNER,
    alias: { webgpu: NATIVE_STUB },
    external: ["vscode", "koffi"],
  },
  {
    ...shared,
    entryPoints: [resolve(EXT_ROOT, "src/notebook/kernel-server.ts")],
    outfile: resolve(DIST, "kernel-server.mjs"),
    platform: "node",
    format: "esm",
    target: ["node20"],
    banner: NODE_ESM_BANNER,
    alias: { webgpu: NATIVE_STUB },
    external: ["koffi"],
  },
  {
    ...shared,
    entryPoints: [resolve(EXT_ROOT, "src/notebook/chart-renderer.ts")],
    outfile: resolve(DIST, "chart-renderer.mjs"),
    platform: "browser",
    format: "esm",
    target: ["es2022"],
    loader: { ".css": "text" },
  },
];

if (!existsSync(RUNTIME_BUNDLE)) {
  throw new Error(`Missing ${RUNTIME_BUNDLE}. Run "npm run build" at the repo root first.`);
}

rmSync(DIST, { recursive: true, force: true });

const generated = await generate();
console.log(
  `Generated ${generated.keywords.length} keywords, ${generated.builtins.length} builtins, ` +
  `${generated.pseudoTypes.length} pseudo-types.`,
);

await Promise.all(targets.map((target) => build(target)));
console.log(`Built ${targets.length} bundles to vscode-ext/dist/`);
