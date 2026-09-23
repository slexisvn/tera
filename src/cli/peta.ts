#!/usr/bin/env node
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const manifestPath = require.resolve("@slexisvn/peta/package.json");
const cliPath = join(dirname(manifestPath), "dist", "cli.js");

await import(pathToFileURL(cliPath).href);
