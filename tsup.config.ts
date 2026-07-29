import { defineConfig, type Options } from "tsup";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const root = import.meta.dirname;
const dist = resolve(root, "dist");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const dependencyNames = Object.keys(pkg.dependencies ?? {});

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const shared: Options = {
  bundle: true,
  format: ["esm"],
  target: ["es2022"],
  keepNames: true,
  sourcemap: false,
  silent: false,
  clean: true,
  splitting: false,
  treeshake: false,
  minify: true
};

export default defineConfig([
  {
    ...shared,
    platform: "node",
    entry: ["src/index.ts"],
    outDir: dist,
    dts: true,
    outExtension: () => ({ js: ".node.js" }),
    external: [...dependencyNames, "*.node"],
  },
  {
    ...shared,
    platform: "neutral",
    entry: ["src/frontend/index.ts"],
    outDir: dist,
    outExtension: () => ({ js: ".frontend.js" }),
    external: [...dependencyNames, "*.node"],
  },
  {
    ...shared,
    platform: "browser",
    entry: ["src/index.ts"],
    outDir: dist,
    outExtension: () => ({ js: ".browser.js" }),
    define: { "process.env.NODE_ENV": '"production"' },
    noExternal: dependencyNames,
    external: ["*.node"],
  },
  {
    ...shared,
    platform: "node",
    entry: { cli: "src/cli/index.ts" },
    outDir: dist,
    outExtension: () => ({ js: ".js" }),
    external: [...dependencyNames, "*.node"],
  },
]);
