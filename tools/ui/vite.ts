import react from "@vitejs/plugin-react";
import { dirname, resolve } from "node:path";
import type { UserConfig } from "vite";

const uiRoot = import.meta.dirname;
const toolsRoot = resolve(uiRoot, "..");
const repoRoot = resolve(toolsRoot, "..");

const posix = (...segments: string[]) => resolve(...segments).replaceAll("\\", "/");

export interface TeraAppConfig {
  readonly root: string;
  readonly base: string;
  readonly outDir?: string;
}

export function teraAliases() {
  return [
    { find: /^@notebook\/(.*)$/, replacement: `${posix(toolsRoot, "notebook/src")}/$1` },
    { find: /^@visualizer\/(.*)$/, replacement: `${posix(toolsRoot, "visualizer/src")}/$1` },
    { find: /^@tera\/ui$/, replacement: posix(uiRoot, "src/index.ts") },
    { find: /^@tera\/ui\/(.*)$/, replacement: `${posix(uiRoot, "src")}/$1` },
    { find: /^@tera\/editor$/, replacement: posix(toolsRoot, "editor/src/index.ts") },
    { find: /^@tera\/editor\/(.*)$/, replacement: `${posix(toolsRoot, "editor/src")}/$1` },
    { find: /^tera$/, replacement: posix(repoRoot, "src/index.browser.ts") },
    { find: /^tera\/(.*)$/, replacement: `${posix(repoRoot, "src")}/$1` },
    { find: /^tera-data\/(.*)$/, replacement: `${posix(repoRoot, "data")}/$1` },
  ];
}

export function teraViteConfig({ root, base, outDir = "dist" }: TeraAppConfig): UserConfig {
  return {
    base,
    root,
    publicDir: false,
    plugins: [react()],
    resolve: {
      alias: teraAliases(),
      dedupe: ["react", "react-dom", "@codemirror/state", "@codemirror/view"],
    },
    build: {
      outDir,
      emptyOutDir: true,
      target: "es2022",
    },
    server: {
      fs: {
        allow: [repoRoot, dirname(repoRoot)],
      },
    },
  };
}
