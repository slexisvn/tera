import { defineConfig } from "vitest/config";
import { teraTestConfig } from "./vite.ts";

export default defineConfig({
  test: teraTestConfig(),
});
