import { resolve } from "node:path";
import { defineConfig } from "vitest/config";
import { aliases } from "./scripts/alias.ts";

const stub = (name: string) => resolve(import.meta.dirname, `tests/stubs/${name}.ts`);

export default defineConfig({
  resolve: {
    alias: [
      { find: /^vscode$/, replacement: stub("vscode") },
      { find: /^vscode-languageclient\/node\.js$/, replacement: stub("vscode-languageclient") },
      ...aliases,
    ],
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
