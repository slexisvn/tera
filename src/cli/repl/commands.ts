import fs from "fs";
import path from "path";
import { tracer } from "../../core/tracing/index.js";
import { resolveMemberReceiverType } from "../../frontend/index.js";
import { COMMAND_PREFIX } from "./config.js";
import { suggestNames } from "./suggest.js";
import type { Analyzer, ReplEngine } from "./types.js";
import type { Printer } from "./display.js";
import type { Language } from "./language.js";

export type CommandResult = "exit" | "handled";

export type CommandContext = {
  engine: ReplEngine;
  printer: Printer;
  language: Language;
  analyzer: Analyzer;
  session: { source(): string; reset(): void };
  evaluate(code: string): void;
  clearScreen(): void;
};

export type Command = {
  names: string[];
  desc: string;
  usage: string;
  run(args: string, ctx: CommandContext): CommandResult;
};

export type CommandRegistry = {
  names(): string[];
  dispatch(input: string, ctx: CommandContext): CommandResult | null;
};

function setTrace(args: string, printer: Printer): CommandResult {
  const value = args.trim();
  if (value === "" ) {
    if (tracer.enabled) tracer.disable();
    else tracer.enable();
  } else if (value === "on") {
    tracer.enable();
  } else if (value === "off") {
    tracer.disable();
  } else {
    tracer.enable();
    tracer.setCategories(value.split(",").map((category) => category.trim()).filter(Boolean));
    printer.line("meta", `trace categories: ${value}`);
    return "handled";
  }
  printer.line("meta", `tracing ${tracer.enabled ? "enabled" : "disabled"}`);
  return "handled";
}

function inferType(expr: string, ctx: CommandContext): string {
  const probe = `${expr}.`;
  const analysis = ctx.analyzer.analyze(ctx.session.source(), probe);
  const position = analysis.positionOf(probe.length);
  const typeName = resolveMemberReceiverType(analysis.source, position, analysis.symbols, ctx.language.globalNamespaces);
  return typeName ?? "unknown";
}

const COMMANDS: Command[] = [
  { names: ["exit", "quit"], desc: "leave the REPL", usage: ".exit", run: () => "exit" },
  {
    names: ["help"],
    desc: "list REPL commands",
    usage: ".help",
    run: (_args, ctx) => {
      for (const command of COMMANDS) {
        ctx.printer.line("meta", `${command.usage.padEnd(18)} ${command.desc}`);
      }
      ctx.printer.line("muted", `${"?<name>".padEnd(18)} show documentation for a builtin`);
      return "handled";
    },
  },
  {
    names: ["reset"],
    desc: "reset engine state and session",
    usage: ".reset",
    run: (_args, ctx) => {
      ctx.engine.reset();
      ctx.session.reset();
      ctx.printer.line("meta", "engine reset");
      return "handled";
    },
  },
  {
    names: ["clear"],
    desc: "clear the screen",
    usage: ".clear",
    run: (_args, ctx) => {
      ctx.clearScreen();
      return "handled";
    },
  },
  {
    names: ["stats"],
    desc: "print engine statistics",
    usage: ".stats",
    run: (_args, ctx) => {
      ctx.printer.raw(JSON.stringify(ctx.engine.getStats(), null, 2));
      tracer.dumpStats();
      return "handled";
    },
  },
  { names: ["trace"], desc: "toggle tracing (.trace on|off|<cats>)", usage: ".trace [on|off|cats]", run: (args, ctx) => setTrace(args, ctx.printer) },
  {
    names: ["dis"],
    desc: "disassemble source",
    usage: ".dis <code>",
    run: (args, ctx) => {
      if (!args.trim()) {
        ctx.printer.line("warning", "usage: .dis <code>");
        return "handled";
      }
      try {
        ctx.printer.result(ctx.engine.runWithDisassembly(args));
      } catch (error) {
        ctx.printer.error(error);
      }
      return "handled";
    },
  },
  {
    names: ["type"],
    desc: "show the inferred type of an expression",
    usage: ".type <expr>",
    run: (args, ctx) => {
      if (!args.trim()) {
        ctx.printer.line("warning", "usage: .type <expr>");
        return "handled";
      }
      ctx.printer.line("meta", `${args.trim()} : ${inferType(args.trim(), ctx)}`);
      return "handled";
    },
  },
  {
    names: ["load"],
    desc: "run a .tera file into the session",
    usage: ".load <file>",
    run: (args, ctx) => {
      const file = args.trim();
      if (!file) {
        ctx.printer.line("warning", "usage: .load <file>");
        return "handled";
      }
      const resolved = path.resolve(file);
      if (!fs.existsSync(resolved)) {
        ctx.printer.error(new Error(`file not found: ${file}`));
        return "handled";
      }
      ctx.evaluate(fs.readFileSync(resolved, "utf8"));
      return "handled";
    },
  },
];

export function createCommandRegistry(): CommandRegistry {
  const byName = new Map<string, Command>();
  for (const command of COMMANDS) {
    for (const name of command.names) byName.set(name, command);
  }
  const allNames = [...byName.keys()];
  return {
    names: () => allNames,
    dispatch(input, ctx) {
      if (!input.startsWith(COMMAND_PREFIX)) return null;
      const trimmed = input.slice(COMMAND_PREFIX.length);
      const space = trimmed.search(/\s/);
      const name = space < 0 ? trimmed : trimmed.slice(0, space);
      const args = space < 0 ? "" : trimmed.slice(space + 1);
      const command = byName.get(name);
      if (!command) {
        ctx.printer.error(new Error(`unknown command: ${COMMAND_PREFIX}${name}`));
        const suggestions = suggestNames(name, allNames);
        if (suggestions.length) {
          ctx.printer.line("muted", `did you mean: ${suggestions.map((entry) => COMMAND_PREFIX + entry).join(", ")}?`);
        }
        return "handled";
      }
      return command.run(args, ctx);
    },
  };
}

export function showDocumentation(name: string, ctx: CommandContext): void {
  const trimmed = name.trim();
  if (!trimmed) return;
  const signature = ctx.language.signatureOf(trimmed);
  const description = ctx.language.describe(trimmed);
  if (!signature && !description) {
    ctx.printer.line("muted", `no documentation for '${trimmed}'`);
    return;
  }
  if (signature) ctx.printer.line("signature", signature);
  if (description) ctx.printer.raw(description);
}
