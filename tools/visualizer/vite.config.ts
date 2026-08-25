import { defineConfig } from "vitest/config";
import { teraViteConfig } from "../ui/vite.ts";

export default defineConfig({
  ...teraViteConfig({ root: import.meta.dirname, base: "/tera/visualizer/" }),
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
