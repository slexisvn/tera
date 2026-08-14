import { PROJECT_MANIFEST, projectRootFor } from "./modules/index.js";
import type { ModuleFileSystem } from "./modules/index.js";

export const PACKAGES_DIRECTORY = "tera_packages";
export const STATE_DIRECTORY = ".peta";
export const STATE_FILE = "state.json";
export const STATE_VERSION = 1;

export type InstalledPackage = {
  readonly name: string;
  readonly version: string;
  readonly source: string;
  readonly files: number;
};

export type InstalledPackages = {
  readonly directory: string;
  readonly packages: readonly InstalledPackage[];
};

type StateEntry = {
  readonly version: string;
  readonly source: string;
  readonly files: number;
};

function isStateEntry(value: unknown): value is StateEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Partial<StateEntry>;
  return (
    typeof entry.version === "string" &&
    typeof entry.source === "string" &&
    typeof entry.files === "number"
  );
}

function byName(left: InstalledPackage, right: InstalledPackage): number {
  if (left.name < right.name) return -1;
  return left.name > right.name ? 1 : 0;
}

function parseState(text: string): readonly InstalledPackage[] {
  const state = JSON.parse(text) as { stateVersion?: unknown; packages?: unknown };
  if (state.stateVersion !== STATE_VERSION) return [];
  if (typeof state.packages !== "object" || state.packages === null) return [];
  const installed: InstalledPackage[] = [];
  for (const [name, entry] of Object.entries(state.packages)) {
    if (!isStateEntry(entry)) continue;
    installed.push({ name, version: entry.version, source: entry.source, files: entry.files });
  }
  return installed.sort(byName);
}

function projectRootIn(fileSystem: ModuleFileSystem, directory: string): string {
  return projectRootFor(fileSystem, fileSystem.join(directory, PROJECT_MANIFEST));
}

function packagesUnder(fileSystem: ModuleFileSystem, root: string): string | null {
  const target = fileSystem.join(root, PACKAGES_DIRECTORY);
  return fileSystem.isDirectory(target) ? target : null;
}

export function searchPathsUnder(
  fileSystem: ModuleFileSystem,
  root: string,
  modulePaths: readonly string[] = [],
): string[] {
  const packages = packagesUnder(fileSystem, root);
  return packages === null ? [...modulePaths] : [...modulePaths, packages];
}

export function searchPathsIn(
  fileSystem: ModuleFileSystem,
  directory: string,
  modulePaths: readonly string[] = [],
): string[] {
  return searchPathsUnder(fileSystem, projectRootIn(fileSystem, directory), modulePaths);
}

export function searchPathsForEntry(
  fileSystem: ModuleFileSystem,
  entryPath: string,
  modulePaths: readonly string[] = [],
): string[] {
  return searchPathsIn(fileSystem, fileSystem.dirname(fileSystem.resolve(entryPath)), modulePaths);
}

export function installedPackagesIn(
  fileSystem: ModuleFileSystem,
  directory: string,
): InstalledPackages | null {
  const packages = packagesUnder(fileSystem, projectRootIn(fileSystem, directory));
  if (packages === null) return null;
  const state = fileSystem.join(packages, STATE_DIRECTORY, STATE_FILE);
  return {
    directory: packages,
    packages: fileSystem.isFile(state) ? parseState(fileSystem.readFile(state)) : [],
  };
}
