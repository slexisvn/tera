export type DiffKind = "same" | "added" | "removed" | "changed" | "moved";

export type DiffRow = {
  readonly kind: DiffKind;
  readonly key: string;
  readonly text: string;
  readonly previous: string | null;
  readonly movedFrom: string | null;
};

export type DiffSummary = {
  readonly added: number;
  readonly removed: number;
  readonly changed: number;
  readonly moved: number;
};

type Entry = {
  readonly text: string;
  readonly block: string | null;
};

const VALUE = /^\s*(v\d+)\s*=/;
const BLOCK = /^\s*(B\d+)\b/;
const MACHINE_BLOCK = /^\s*(\S+):(?:\s|$)/;
const MACHINE_HEADER = /^\s*machine\s/;
const GRAPH = /^\s*graph\s/;
const HEADER = /^\s*fn\s/;

function blockOpenedBy(line: string): string | null {
  const block = BLOCK.exec(line);
  if (block !== null) return block[1]!;
  if (MACHINE_HEADER.test(line) || GRAPH.test(line) || HEADER.test(line)) return null;
  const machine = MACHINE_BLOCK.exec(line);
  return machine === null ? null : machine[1]!;
}

function index(text: string): Map<string, Entry> {
  const entries = new Map<string, Entry>();
  let block: string | null = null;
  let within = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const opened = blockOpenedBy(line);
    if (opened !== null) {
      block = opened;
      within = 0;
      entries.set(opened, { text: line, block: null });
      continue;
    }
    const value = VALUE.exec(line);
    if (value !== null) {
      entries.set(value[1]!, { text: line, block });
      continue;
    }
    if (GRAPH.test(line)) entries.set("graph", { text: line, block: null });
    else if (HEADER.test(line)) entries.set("fn", { text: line, block: null });
    else if (MACHINE_HEADER.test(line)) entries.set("machine", { text: line, block: null });
    else if (line.trim() === "}") entries.set("}", { text: line, block: null });
    else entries.set(`${block ?? "~"}#${within++}`, { text: line, block });
  }
  return entries;
}

function rowFor(key: string, now: Entry, before: Entry): DiffRow {
  if (now.text !== before.text) {
    return { kind: "changed", key, text: now.text, previous: before.text, movedFrom: null };
  }
  if (now.block !== before.block) {
    return { kind: "moved", key, text: now.text, previous: null, movedFrom: before.block };
  }
  return { kind: "same", key, text: now.text, previous: before.text, movedFrom: null };
}

export function diffIR(before: string, after: string): readonly DiffRow[] {
  const older = index(before);
  const newer = index(after);
  const rows: DiffRow[] = [];
  const emitted = new Set<string>();
  const beforeOrder = [...older.keys()];
  const positionOf = new Map(beforeOrder.map((key, at) => [key, at]));
  let cursor = 0;

  const dropUntil = (limit: number): void => {
    while (cursor < limit) {
      const dropped = beforeOrder[cursor++]!;
      if (newer.has(dropped) || emitted.has(dropped)) continue;
      emitted.add(dropped);
      rows.push({
        kind: "removed",
        key: dropped,
        text: older.get(dropped)!.text,
        previous: null,
        movedFrom: null,
      });
    }
  };

  for (const [key, entry] of newer) {
    const previous = older.get(key);
    if (previous !== undefined) {
      const at = positionOf.get(key)!;
      dropUntil(at);
      cursor = Math.max(cursor, at + 1);
    }
    emitted.add(key);
    rows.push(
      previous === undefined
        ? { kind: "added", key, text: entry.text, previous: null, movedFrom: null }
        : rowFor(key, entry, previous),
    );
  }
  dropUntil(beforeOrder.length);

  return rows;
}

export function summarize(rows: readonly DiffRow[]): DiffSummary {
  const totals = { added: 0, removed: 0, changed: 0, moved: 0 };
  for (const row of rows) {
    if (row.kind !== "same") totals[row.kind]++;
  }
  return totals;
}
