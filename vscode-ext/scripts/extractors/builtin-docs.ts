import { existsSync, readFileSync } from "node:fs";
import type { Param } from "../../src/shared/language-data.ts";

const BUILTIN_HEADING = /^##\s+([A-Za-z_][A-Za-z0-9_]*)(?:\(([^)]*)\))?(?:\s*\{([A-Za-z_][A-Za-z0-9_]*)\})?\s*$/;
const METHOD_HEADING = /^###\s+([A-Za-z_][A-Za-z0-9_]*)(?:\(([^)]*)\))?(?:\s*->\s*(.+?))?\s*$/;
const KIND_TEMPLATE_HEADING = /^##\s+@kind\/([A-Za-z_][A-Za-z0-9_]*)\s*$/;
const PSEUDO_TYPE_HEADING = /^##\s+\$([A-Za-z_][A-Za-z0-9_]*)\s*$/;
const FENCE = /^\s*```/;

export type DocMethod = {
  name: string;
  params: Param[];
  returns: string | null;
  isGetter: boolean;
  description: string | null;
};

export type DocBuiltin = {
  name: string;
  kind: string | null;
  params: Param[] | null;
  description: string | null;
  methods: DocMethod[];
};

export type BuiltinDocs = {
  builtins: Map<string, DocBuiltin>;
  kindTemplates: Map<string, DocMethod[]>;
  pseudoTypes: Map<string, DocMethod[]>;
};

type Section =
  | { type: "builtin"; name: string; kind: string | null; params: Param[] | null; methods: DocMethod[]; headerDescription: string | null }
  | { type: "kindTemplate"; name: string; methods: DocMethod[] }
  | { type: "pseudoType"; name: string; methods: DocMethod[] };

export function extractBuiltinDocs(docPath: string): BuiltinDocs {
  const empty: BuiltinDocs = { builtins: new Map(), kindTemplates: new Map(), pseudoTypes: new Map() };
  if (!existsSync(docPath)) return empty;

  const builtins = new Map<string, DocBuiltin>();
  const kindTemplates = new Map<string, DocMethod[]>();
  const pseudoTypes = new Map<string, DocMethod[]>();

  let section: Section | null = null;
  let method: Omit<DocMethod, "description"> | null = null;
  let buffer: string[] = [];
  let inFence = false;

  const takeText = (): string | null => {
    const text = buffer.join("\n").trim();
    buffer = [];
    return text || null;
  };

  const flushMethod = (): void => {
    if (!section || !method) return;
    section.methods.push({ ...method, description: takeText() });
    method = null;
  };

  const flushSection = (): void => {
    flushMethod();
    if (!section) return;

    if (section.type === "builtin") {
      builtins.set(section.name, {
        name: section.name,
        kind: section.kind,
        params: section.params,
        description: section.headerDescription ?? takeText(),
        methods: section.methods,
      });
    } else if (section.type === "kindTemplate") {
      kindTemplates.set(section.name, section.methods);
    } else {
      pseudoTypes.set(section.name, section.methods);
    }

    buffer = [];
    section = null;
  };

  for (const line of readFileSync(docPath, "utf8").split(/\r?\n/)) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      if (section) buffer.push(line);
      continue;
    }
    if (inFence) {
      if (section) buffer.push(line);
      continue;
    }

    const kindTemplate = line.match(KIND_TEMPLATE_HEADING);
    if (kindTemplate) {
      flushSection();
      section = { type: "kindTemplate", name: kindTemplate[1], methods: [] };
      continue;
    }

    const pseudoType = line.match(PSEUDO_TYPE_HEADING);
    if (pseudoType) {
      flushSection();
      section = { type: "pseudoType", name: pseudoType[1], methods: [] };
      continue;
    }

    const builtin = line.match(BUILTIN_HEADING);
    if (builtin) {
      flushSection();
      section = {
        type: "builtin",
        name: builtin[1],
        kind: builtin[3] ?? null,
        params: builtin[2] === undefined ? null : parseParams(builtin[2]),
        methods: [],
        headerDescription: null,
      };
      continue;
    }

    const heading = line.match(METHOD_HEADING);
    if (heading && section) {
      if (!method && section.type === "builtin") section.headerDescription = takeText();
      else flushMethod();
      method = {
        name: heading[1],
        params: heading[2] === undefined ? [] : parseParams(heading[2]),
        returns: heading[3] ?? null,
        isGetter: heading[2] === undefined,
      };
      continue;
    }

    if (section) buffer.push(line);
  }
  flushSection();

  return { builtins, kindTemplates, pseudoTypes };
}

export function parseParams(text: string): Param[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  return splitTopLevel(trimmed).map((part) => part.trim()).filter(Boolean).map(parseParam);
}

function parseParam(text: string): Param {
  if (text.startsWith("...")) {
    const { name, type } = splitType(text.slice(3));
    return { name, type, optional: true, rest: true, defaultValue: null };
  }

  const equals = findTopLevelEquals(text);
  if (equals < 0) {
    const { name, type } = splitType(text);
    const optional = name.endsWith("?");
    return { name: optional ? name.slice(0, -1).trim() : name, type, optional, rest: false, defaultValue: null };
  }

  const { name, type } = splitType(text.slice(0, equals));
  return { name, type, optional: true, rest: false, defaultValue: text.slice(equals + 1).trim() };
}

function splitType(text: string): { name: string; type: string | null } {
  const trimmed = text.trim();
  const colon = trimmed.indexOf(":");
  if (colon < 0) return { name: trimmed, type: null };
  return { name: trimmed.slice(0, colon).trim(), type: trimmed.slice(colon + 1).trim() };
}

function findTopLevelEquals(text: string): number {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === "[" || char === "{" || char === "(") depth++;
    else if (char === "]" || char === "}" || char === ")") depth--;
    else if (char === "=" && depth === 0) return i;
  }
  return -1;
}

function splitTopLevel(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let buffer = "";

  for (const char of text) {
    if (char === "[" || char === "{" || char === "(") depth++;
    else if (char === "]" || char === "}" || char === ")") depth--;

    if (char === "," && depth === 0) {
      out.push(buffer);
      buffer = "";
    } else {
      buffer += char;
    }
  }
  if (buffer) out.push(buffer);
  return out;
}
