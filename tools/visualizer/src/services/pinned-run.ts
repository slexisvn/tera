import type { RunResult, Stage, StageGroup } from "../types/stage";

export type PinnedStage = {
  readonly key: string;
  readonly title: string;
  readonly owner: string;
  readonly group: StageGroup;
  readonly hash: number;
  readonly text: string | null;
};

export type PinnedRun = {
  readonly at: number;
  readonly request: string;
  readonly stages: readonly PinnedStage[];
  readonly withoutText: number;
};

export type CompareKind = "same" | "changed" | "added" | "removed";

export type CompareRow = {
  readonly key: string;
  readonly title: string;
  readonly owner: string;
  readonly kind: CompareKind;
  readonly stageId: string | null;
  readonly before: string | null;
  readonly after: string | null;
};

export type CompareReport = {
  readonly rows: readonly CompareRow[];
  readonly totals: Readonly<Record<CompareKind, number>>;
};

const TEXT_BUDGET = 1_500_000;

export function hashOf(text: string): number {
  let hash = 2166136261;
  for (let at = 0; at < text.length; at++) {
    hash ^= text.charCodeAt(at);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function keysOf(stages: readonly Stage[]): ReadonlyMap<string, Stage> {
  const seen = new Map<string, number>();
  const keyed = new Map<string, Stage>();
  for (const stage of stages) {
    if (stage.group === "executed") continue;
    const base = `${stage.group}/${stage.owner}/${stage.passName ?? stage.title}`;
    const at = seen.get(base) ?? 0;
    seen.set(base, at + 1);
    keyed.set(`${base}#${at}`, stage);
  }
  return keyed;
}

export function pinOf(result: RunResult, request: string): PinnedRun {
  const stages: PinnedStage[] = [];
  let spent = 0;
  let withoutText = 0;
  for (const [key, stage] of keysOf(result.stages)) {
    const room = spent + stage.text.length <= TEXT_BUDGET;
    if (room) spent += stage.text.length;
    else withoutText++;
    stages.push({
      key,
      title: stage.title,
      owner: stage.owner,
      group: stage.group,
      hash: hashOf(stage.text),
      text: room ? stage.text : null,
    });
  }
  return { at: Date.now(), request, stages, withoutText };
}

export function withoutTexts(pin: PinnedRun): PinnedRun {
  return {
    ...pin,
    stages: pin.stages.map((stage) => ({ ...stage, text: null })),
    withoutText: pin.stages.length,
  };
}

function row(
  key: string,
  title: string,
  owner: string,
  kind: CompareKind,
  stageId: string | null,
  before: string | null,
  after: string | null,
): CompareRow {
  return { key, title, owner, kind, stageId, before, after };
}

export function comparePin(pin: PinnedRun, stages: readonly Stage[]): CompareReport {
  const now = keysOf(stages);
  const rows: CompareRow[] = [];
  const totals = { same: 0, changed: 0, added: 0, removed: 0 };

  for (const pinned of pin.stages) {
    const current = now.get(pinned.key);
    if (current === undefined) {
      totals.removed++;
      rows.push(row(pinned.key, pinned.title, pinned.owner, "removed", null, pinned.text, null));
      continue;
    }
    const same = hashOf(current.text) === pinned.hash;
    if (same) {
      totals.same++;
      continue;
    }
    totals.changed++;
    rows.push(
      row(pinned.key, pinned.title, pinned.owner, "changed", current.id, pinned.text, current.text),
    );
  }

  const known = new Set(pin.stages.map((pinned) => pinned.key));
  for (const [key, stage] of now) {
    if (known.has(key)) continue;
    totals.added++;
    rows.push(row(key, stage.title, stage.owner, "added", stage.id, null, stage.text));
  }

  return { rows, totals };
}
