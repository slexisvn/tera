import { COMMANDS, FLAG_GROUPS, commandNamed, type CommandSpec, type FlagSpec } from "./spec.js";
import type { CliConfig } from "./config.js";

const INDENT = "  ";
const LABEL_WIDTH = 30;

function row(label: string, summary: string): string {
  return `${INDENT}${label.padEnd(LABEL_WIDTH)}${summary}`;
}

function flagLabel(flag: FlagSpec<CliConfig>): string {
  const short = flag.short === undefined ? "" : `-${flag.short}, `;
  const value =
    flag.value === undefined
      ? ""
      : flag.valueOptional === true
        ? `[=${flag.value}]`
        : ` <${flag.value}>`;
  return `${short}--${flag.name}${value}`;
}

function usageOf(spec: CommandSpec<CliConfig>): string {
  const parts = ["tera", spec.name, spec.arguments, "[options]"].filter(
    (part) => part.length > 0,
  );
  return `Usage: ${parts.join(" ")}`;
}

export function commandHelp(spec: CommandSpec<CliConfig>): string {
  const lines = [usageOf(spec), "", `${INDENT}${spec.summary}`];
  for (const group of FLAG_GROUPS) {
    const flags = spec.flags.filter((flag) => flag.group === group);
    if (flags.length === 0) continue;
    lines.push("", `${group}:`);
    for (const flag of flags) lines.push(row(flagLabel(flag), flag.summary));
  }
  return lines.join("\n");
}

export function generalHelp(): string {
  const lines = [
    "Usage: tera [command] [options] [args]",
    "",
    "Commands:",
    ...COMMANDS.map((command) => row(command.name, command.summary)),
    "",
    "Input:",
    row("-", "read a program from stdin"),
    row("--", "treat every later argument as a path"),
    "",
    `${INDENT}Without a command, tera runs the files it is given, or starts the repl.`,
    `${INDENT}Run 'tera help <command>' to see the options of one command.`,
  ];
  return lines.join("\n");
}

export function helpFor(topic: string | null): string {
  if (topic === null) return generalHelp();
  const spec = commandNamed(topic);
  if (spec === undefined) return generalHelp();
  return commandHelp(spec);
}
