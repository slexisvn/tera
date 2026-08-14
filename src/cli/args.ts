import type { CliConfig, EngineFlags, ReplConfig, RunConfig } from "./config.js";
import {
  commandNamed,
  CliUsageError,
  RUN_COMMAND,
  STDIN_TOKEN,
  type CommandSpec,
  type FlagSpec,
} from "./spec.js";

export { CliUsageError } from "./spec.js";

const FLAGS_END = "--";
const HELP_FLAGS = new Set(["--help", "-h"]);
const VERSION_FLAGS = new Set(["--version", "-v"]);

interface FlagToken {
  readonly name: string;
  readonly inline: string | null;
}

function splitFlag(token: string): FlagToken {
  const body = token.startsWith(FLAGS_END) ? token.slice(2) : token.slice(1);
  const equals = body.indexOf("=");
  if (equals < 0) return { name: body, inline: null };
  return { name: body.slice(0, equals), inline: body.slice(equals + 1) };
}

function flagNamed<C>(spec: CommandSpec<C>, token: string, name: string): FlagSpec<C> {
  const flag = spec.flags.find(
    (candidate) => candidate.name === name || candidate.short === name,
  );
  if (flag === undefined) {
    throw new CliUsageError(
      `unknown option '${token}' for '${spec.name}' (see 'tera help ${spec.name}')`,
    );
  }
  return flag;
}

function valueOf<C>(
  flag: FlagSpec<C>,
  parsed: FlagToken,
  argv: readonly string[],
  position: number,
): { readonly value: string; readonly consumed: number } {
  if (flag.value === undefined) {
    if (parsed.inline !== null) {
      throw new CliUsageError(`--${flag.name} does not take a value`);
    }
    return { value: "", consumed: 0 };
  }
  if (parsed.inline !== null) return { value: parsed.inline, consumed: 0 };
  if (flag.valueOptional === true) return { value: "", consumed: 0 };
  const next = argv[position + 1];
  if (next === undefined) {
    throw new CliUsageError(
      `--${flag.name} requires a value (--${flag.name}=<${flag.value}>)`,
    );
  }
  return { value: next, consumed: 1 };
}

function parseWith<C>(spec: CommandSpec<C>, argv: readonly string[]): C {
  const config = spec.defaults();
  let literal = false;

  for (let position = 0; position < argv.length; position++) {
    const token = argv[position]!;
    if (literal) {
      spec.accept(config, token);
      continue;
    }
    if (token === FLAGS_END) {
      literal = true;
      continue;
    }
    if (token === STDIN_TOKEN || !token.startsWith("-")) {
      spec.accept(config, token);
      continue;
    }
    const parsed = splitFlag(token);
    const flag = flagNamed(spec, token, parsed.name);
    const { value, consumed } = valueOf(flag, parsed, argv, position);
    flag.apply(config, value);
    position += consumed;
  }

  return config;
}

function replFrom(config: RunConfig): ReplConfig {
  const { command: _command, files: _files, eval: _eval, readStdin: _stdin, ...engine } =
    config;
  return { command: "repl", ...(engine satisfies EngineFlags) };
}

function hasInput(config: RunConfig): boolean {
  return config.files.length > 0 || config.eval !== null || config.readStdin;
}

function topicOf(argv: readonly string[]): string | null {
  const first = argv[0];
  return first !== undefined && commandNamed(first) !== undefined ? first : null;
}

function askedFor(argv: readonly string[], flags: ReadonlySet<string>): boolean {
  const end = argv.indexOf(FLAGS_END);
  const searched = end < 0 ? argv : argv.slice(0, end);
  return searched.some((token) => flags.has(token));
}

export function parseArgs(argv: readonly string[]): CliConfig {
  if (askedFor(argv, HELP_FLAGS)) return { command: "help", topic: topicOf(argv) };
  if (askedFor(argv, VERSION_FLAGS)) return { command: "version" };

  const named = argv.length > 0 ? commandNamed(argv[0]!) : undefined;
  if (named !== undefined) return parseWith(named, argv.slice(1));

  const config = parseWith(RUN_COMMAND, argv);
  return hasInput(config) ? config : replFrom(config);
}
