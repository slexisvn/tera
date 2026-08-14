import fs from "node:fs";
import path from "node:path";
import type { ModuleFileSystem } from "./file-system.js";

function statOf(target: string): fs.Stats | undefined {
  return fs.statSync(target, { throwIfNoEntry: false });
}

export const nodeModuleFileSystem: ModuleFileSystem = {
  separator: path.sep,
  readFile: (target) => fs.readFileSync(target, "utf8"),
  isFile: (target) => statOf(target)?.isFile() ?? false,
  isDirectory: (target) => statOf(target)?.isDirectory() ?? false,
  canonical: (target) => fs.realpathSync.native(target),
  resolve: (target) => path.resolve(target),
  join: (...segments) => path.join(...segments),
  dirname: (target) => path.dirname(target),
  relative: (from, to) => path.relative(from, to),
  isAbsolute: (target) => path.isAbsolute(target),
};
