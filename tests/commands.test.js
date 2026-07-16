import { describe, expect, it, vi } from 'vitest';
import { CLI_USAGE, runCli } from '../src/commands.js';

describe('Tera CLI commands', () => {
  it('checks source without executing it', async () => {
    const stdout = vi.fn();
    const code = await runCli(['check', 'model.mlfw'], {
      stdout,
      stderr: vi.fn(),
      readFile: () => 'x = tensor([1, 2])',
    });
    expect(code).toBe(0);
    expect(stdout).toHaveBeenCalledWith('model.mlfw: OK');
  });

  it('runs source through explicit and shorthand commands', async () => {
    for (const args of [['run', 'model.mlfw'], ['model.mlfw']]) {
      const stdout = vi.fn();
      expect(await runCli(args, {
        stdout,
        stderr: vi.fn(),
        readFile: () => 'tensor([1, 2])',
      })).toBe(0);
      expect(stdout.mock.calls.at(-1)[0]).toContain('Tensor(shape=[2]');
    }
  });

  it('prints source diagnostics for invalid files', async () => {
    const stderr = vi.fn();
    expect(await runCli(['check', 'bad.mlfw'], {
      stdout: vi.fn(),
      stderr,
      readFile: () => 'x = @',
    })).toBe(1);
    expect(stderr.mock.calls[0][0]).toContain('--> bad.mlfw:1:5');
  });

  it('prints command usage', async () => {
    const stdout = vi.fn();
    expect(await runCli(['--help'], { stdout, stderr: vi.fn() })).toBe(0);
    expect(stdout).toHaveBeenCalledWith(CLI_USAGE);
  });

  it('executes piped stdin instead of starting the interactive terminal', async () => {
    const stdout = vi.fn();
    const repl = vi.fn();
    expect(await runCli(['repl'], {
      stdout,
      stderr: vi.fn(),
      repl,
      stdinIsTTY: false,
      readStdin: async () => 'x = tensor([1, 2])\nx.shape\nexit\n',
    })).toBe(0);
    expect(repl).not.toHaveBeenCalled();
    expect(stdout).toHaveBeenCalledWith('[2]');
  });

  it('prints diagnostics and returns failure for invalid piped stdin', async () => {
    const stderr = vi.fn();
    expect(await runCli([], {
      stdout: vi.fn(),
      stderr,
      stdinIsTTY: false,
      readStdin: async () => 'missing(1)',
    })).toBe(1);
    expect(stderr.mock.calls[0][0]).toContain('--> <stdin>:1:1');
  });
});
