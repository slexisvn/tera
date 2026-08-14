import react from "@vitejs/plugin-react";
import { dirname, resolve } from "node:path";
import { defineConfig } from "vitest/config";

const notebookRoot = import.meta.dirname;
const repoRoot = resolve(notebookRoot, "..");

const posix = (...segments: string[]) => resolve(...segments).replaceAll("\\", "/");

const alias = [
  { find: /^@\/(.*)$/, replacement: `${posix(notebookRoot, "src")}/$1` },
  { find: /^tera$/, replacement: posix(repoRoot, "src/index.browser.ts") },
  { find: /^tera\/(.*)$/, replacement: `${posix(repoRoot, "src")}/$1` },
  { find: /^tera-data\/(.*)$/, replacement: `${posix(repoRoot, "data")}/$1` },
];

export default defineConfig({
  base: "/tera/",
  root: notebookRoot,
  publicDir: false,
  plugins: [react()],
  resolve: { alias },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
  },
  server: {
    fs: {
      allow: [repoRoot, dirname(repoRoot)],
    },
  },
  test: {
    environment: "jsdom",
  },
});
