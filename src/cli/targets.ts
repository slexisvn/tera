import { createBackendRegistry, HOST_PLATFORM } from "../optimizing/backends/index.js";
import { isAotBackend, type AotBackend } from "../optimizing/target/backend.js";
import type { AotOutputFormat } from "../optimizing/target/artifact.js";
import type { EmitKind } from "./config.js";

const EMITS: readonly (readonly [EmitKind, AotOutputFormat])[] = [
  ["exe", "executable"],
  ["obj", "object"],
  ["source", "assembly"],
];

const COLUMN_GAP = 2;
const PORTABLE = "any";

export interface Architecture {
  readonly name: string;
  readonly platforms: readonly string[];
  readonly backends: readonly AotBackend[];
}

export function aotBackends(): readonly AotBackend[] {
  return [...createBackendRegistry().list()].filter(isAotBackend);
}

export function architectureOf(backend: AotBackend): string {
  return backend.platform === null ? backend.id : backend.platform.arch;
}

export function architectures(): readonly Architecture[] {
  const grouped = new Map<string, AotBackend[]>();
  for (const backend of aotBackends()) {
    const name = architectureOf(backend);
    const bucket = grouped.get(name);
    if (bucket === undefined) grouped.set(name, [backend]);
    else bucket.push(backend);
  }
  return [...grouped].map(([name, backends]) => ({
    name,
    platforms: backends.map((backend) => backend.platform?.os ?? PORTABLE),
    backends,
  }));
}

export function emitsOf(backend: AotBackend): readonly EmitKind[] {
  return EMITS.filter(([, format]) => backend.outputs.includes(format)).map(([kind]) => kind);
}

export function linksItself(backend: AotBackend): boolean {
  return backend.outputs.includes("executable");
}

export function hostArchitecture(): string {
  return HOST_PLATFORM.arch;
}

function rowsOf(): readonly (readonly string[])[] {
  return [
    ["target", "platforms", "emits", "exe"],
    ...architectures().map((architecture) => [
      architecture.name,
      architecture.platforms.join(" "),
      [...new Set(architecture.backends.flatMap((backend) => emitsOf(backend)))].join(" "),
      architecture.backends.some(linksItself) ? "written directly" : "needs a C compiler",
    ]),
  ];
}

export function targetsReport(): string {
  const rows = rowsOf();
  const widths = rows[0]!.map((_unused, column) =>
    Math.max(...rows.map((row) => row[column]!.length)),
  );
  const table = rows.map((row) =>
    row
      .map((cell, column) =>
        column === row.length - 1 ? cell : cell.padEnd(widths[column]! + COLUMN_GAP),
      )
      .join("")
      .trimEnd(),
  );
  return [
    ...table,
    "",
    `This machine is ${HOST_PLATFORM.os}-${HOST_PLATFORM.arch}: that is what --target and`,
    "--platform default to. Pass --platform to build for another one.",
  ].join("\n");
}

export function runTargets(): number {
  console.log(targetsReport());
  return 0;
}
