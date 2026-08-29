import type { Stage } from "../types/stage";

export type SearchHit = {
  readonly stageId: string;
  readonly title: string;
  readonly owner: string;
  readonly group: Stage["group"];
  readonly line: number;
  readonly text: string;
};

export type SearchReport = {
  readonly hits: readonly SearchHit[];
  readonly stages: number;
  readonly total: number;
  readonly first: SearchHit | null;
  readonly last: SearchHit | null;
  readonly capped: boolean;
  readonly error: string | null;
};

export type SearchOptions = {
  readonly regex: boolean;
  readonly limit?: number;
};

const EMPTY: SearchReport = {
  hits: [],
  stages: 0,
  total: 0,
  first: null,
  last: null,
  capped: false,
  error: null,
};

const HIT_LIMIT = 300;
const LINE_SHOWN = 240;

const LINES = new WeakMap<Stage, readonly string[]>();

function linesOf(stage: Stage): readonly string[] {
  const held = LINES.get(stage);
  if (held !== undefined) return held;
  const split = stage.text.split("\n");
  LINES.set(stage, split);
  return split;
}

function matcher(query: string, regex: boolean): ((line: string) => boolean) | string {
  if (!regex) {
    const needle = query.toLowerCase();
    return (line: string) => line.toLowerCase().includes(needle);
  }
  try {
    const pattern = new RegExp(query, "i");
    return (line: string) => pattern.test(line);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function searchStages(
  stages: readonly Stage[],
  query: string,
  { regex, limit = HIT_LIMIT }: SearchOptions,
): SearchReport {
  if (query.trim() === "") return EMPTY;
  const matches = matcher(query, regex);
  if (typeof matches === "string") return { ...EMPTY, error: matches };

  const hits: SearchHit[] = [];
  let total = 0;
  let stagesHit = 0;
  let last: SearchHit | null = null;

  for (const stage of stages) {
    let hitHere = false;
    const lines = linesOf(stage);
    for (let at = 0; at < lines.length; at++) {
      const line = lines[at]!;
      if (!matches(line)) continue;
      total++;
      hitHere = true;
      const hit: SearchHit = {
        stageId: stage.id,
        title: stage.title,
        owner: stage.owner,
        group: stage.group,
        line: at + 1,
        text: line.trim().slice(0, LINE_SHOWN),
      };
      last = hit;
      if (hits.length < limit) hits.push(hit);
    }
    if (hitHere) stagesHit++;
  }

  return {
    hits,
    stages: stagesHit,
    total,
    first: hits[0] ?? null,
    last,
    capped: total > hits.length,
    error: null,
  };
}
