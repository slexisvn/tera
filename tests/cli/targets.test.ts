import { describe, expect, it } from "vitest";
import { HOST_PLATFORM, hostBackendId } from "../../src/optimizing/backends/host.js";
import {
  aotBackends,
  architectures,
  emitsOf,
  hostArchitecture,
  targetsReport,
} from "../../src/cli/targets.js";

const architectureNamed = (name: string) =>
  architectures().find((architecture) => architecture.name === name)!;
const backendNamed = (id: string) => aotBackends().find((backend) => backend.id === id)!;
const rowOf = (name: string) =>
  targetsReport()
    .split("\n")
    .find((row) => row.startsWith(`${name} `))!;

describe("tera targets", () => {
  it("lists one row per architecture rather than one per platform pair", () => {
    const report = targetsReport();

    for (const architecture of architectures()) expect(report).toContain(architecture.name);
    expect(report).not.toContain("x64-windows");
    expect(report).not.toContain("x64-linux");
  });

  it("leaves out the backends that only run just in time", () => {
    expect(targetsReport()).not.toContain("wasm");
  });

  it("names every platform an architecture can build for", () => {
    expect(architectureNamed("x64").platforms).toEqual(["linux", "windows"]);
    expect(architectureNamed("riscv64").platforms).toEqual(["linux"]);
    expect(architectureNamed("c").platforms).toEqual(["any"]);
  });

  it("reports the artifacts a target can emit", () => {
    expect(emitsOf(backendNamed("x64-linux"))).toEqual(["exe", "obj", "source"]);
    expect(emitsOf(backendNamed("c"))).toEqual(["source"]);
  });

  it("claims only the artifacts a half-finished encoder can really produce", () => {
    expect(emitsOf(backendNamed("riscv64"))).toEqual(["source"]);
  });

  it("says which architectures write an executable without a C compiler", () => {
    expect(rowOf("x64")).toContain("written directly");
    expect(rowOf("c")).toContain("needs a C compiler");
    expect(rowOf("riscv64")).toContain("needs a C compiler");
  });

  it("tells the reader what this machine defaults to", () => {
    const report = targetsReport();

    expect(report).toContain(`${HOST_PLATFORM.os}-${HOST_PLATFORM.arch}`);
    expect(hostArchitecture()).toBe(process.arch);
  });

  it("resolves the host to a registered target", () => {
    const host = hostBackendId();

    expect(host === null || backendNamed(host).platform!.arch).toBeTruthy();
  });
});
