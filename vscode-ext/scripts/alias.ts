import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "esbuild";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = resolve(HERE, "..");
const ROOT = resolve(EXT_ROOT, "..");

const posix = (...segments: string[]) => resolve(...segments).replaceAll("\\", "/");

export type Alias = { find: RegExp; replacement: string };

export const aliases: Alias[] = [
  { find: /^@\/(.*)$/, replacement: `${posix(EXT_ROOT, "src")}/$1` },
  { find: /^@notebook\/(.*)$/, replacement: `${posix(ROOT, "tools/notebook/src")}/$1` },
  { find: /^tera$/, replacement: posix(ROOT, "src/index.ts") },
  { find: /^tera\/(.*)$/, replacement: `${posix(ROOT, "src")}/$1` },
  { find: /^tera-data\/(.*)$/, replacement: `${posix(ROOT, "data")}/$1` },
];

const FILTER = new RegExp(`(${aliases.map((entry) => entry.find.source).join("|")})`);

export function aliasPlugin(): Plugin {
  return {
    name: "repo-alias",
    setup(build) {
      build.onResolve({ filter: FILTER }, async (args) => {
        const match = aliases.find((entry) => entry.find.test(args.path));
        if (match === undefined) return null;
        return build.resolve(args.path.replace(match.find, match.replacement), {
          kind: args.kind,
          importer: args.importer,
          resolveDir: args.resolveDir,
        });
      });
    },
  };
}
