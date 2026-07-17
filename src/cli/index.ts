#!/usr/bin/env node
import { Engine } from "../api/engine.js";
import fs from "fs";
import path from "path";

const args = process.argv.slice(2);
const file = args[0];

function printHelp(): void {
  console.log("Usage: tera [file]");
  console.log("       tera -e <source>");
  console.log("       tera --help");
}

if (file === "--help" || file === "-h") {
  printHelp();
} else if (file === "-e" || file === "--eval") {
  const source = args.slice(1).join(" ");
  const engine = new Engine();
  try {
    const result = engine.run(source);
    const { toDisplayString } = await import("../core/value/index.js");
    console.log(toDisplayString(result));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
} else if (!file) {
  const { startREPL } = await import("./repl.js");
  startREPL(new Engine());
} else {
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved)) {
    console.error(`Error: file not found: ${file}`);
    process.exit(1);
  }
  const source = fs.readFileSync(resolved, "utf8");
  const engine = new Engine();
  try {
    const result = engine.run(source);
    const { toDisplayString } = await import("../core/value/index.js");
    console.log(toDisplayString(result));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
