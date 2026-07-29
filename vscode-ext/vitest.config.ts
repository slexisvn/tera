import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const stub = (name: string) => resolve(import.meta.dirname, `tests/stubs/${name}.ts`);

export default defineConfig({
  resolve: {
    alias: {
      vscode: stub("vscode"),
      "vscode-languageclient/node.js": stub("vscode-languageclient"),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
