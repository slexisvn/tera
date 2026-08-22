import { expect } from "vitest";
import { nodeEngine } from "./engine.js";
import { cBatch, cSource, type CArgument } from "./c-executor.js";
import { runPe } from "./pe-runner.js";

const UNCHECKED = { typecheck: "off" } as const;

export function interpreted(source: string): string {
  const stream: string[] = [];
  nodeEngine({ ...UNCHECKED, output: (text: string) => stream.push(`${text}\n`) }).run(`${source}\n`);
  return stream.join("");
}

export function image(source: string): Uint8Array {
  const program = nodeEngine(UNCHECKED).compileAot(`${source}\n`, {
    backend: "x64-windows",
    format: "executable",
  });
  expect(program.skipped).toEqual([]);
  return program.files[0]!.contents as Uint8Array;
}

export function cText(source: string): string {
  const program = nodeEngine(UNCHECKED).compileAot(`${source}\n`, {
    backend: "c",
    format: "assembly",
  });
  expect(program.skipped).toEqual([]);
  return cSource(program);
}

export function peAgrees(source: string): void {
  const run = runPe(image(source));

  expect(run.status).toBe(0);
  expect(run.stdout).toBe(interpreted(source));
}

export interface CCallOptions<T> {
  readonly toC: (program: T) => string;
  readonly interpret?: (program: T, call: string) => unknown;
}

export interface CCalls<T> {
  matches(program: T, entry: string, args: readonly number[]): () => void;
  text(program: T, entry: string, args: readonly CArgument[], expected: string): () => void;
  value(program: T, entry: string, args: readonly CArgument[], expected: number): () => void;
  faults(program: T, entry: string, args: readonly CArgument[], reason: string): () => void;
}

export function cCalls<T>({ toC, interpret }: CCallOptions<T>): CCalls<T> {
  const batch = cBatch();
  return {
    matches(program, entry, args) {
      if (interpret === undefined) throw new Error("comparing against the interpreter needs one");
      const run = batch.callNumber(() => toC(program), entry, args);
      return () => {
        expect(run()).toBe(interpret(program, `${entry}(${args.join(", ")})`));
      };
    },
    text(program, entry, args, expected) {
      const run = batch.callText(() => toC(program), entry, args);
      return () => {
        expect(run()).toBe(expected);
      };
    },
    value(program, entry, args, expected) {
      const run = batch.callNumber(() => toC(program), entry, args);
      return () => {
        expect(run()).toBe(expected);
      };
    },
    faults(program, entry, args, reason) {
      const run = batch.callNumber(() => toC(program), entry, args);
      return () => {
        expect(run).toThrow(reason);
      };
    },
  };
}

export interface CAgreement {
  agrees(source: string): () => void;
  faults(source: string): () => void;
}

export function cAgreement(): CAgreement {
  const batch = cBatch();
  return {
    agrees(source) {
      const run = batch.program(() => cText(source));
      return () => {
        expect(run().stdout).toBe(interpreted(source));
      };
    },
    faults(source) {
      const run = batch.program(() => cText(source));
      return () => {
        expect(run().status).not.toBe(0);
      };
    },
  };
}
