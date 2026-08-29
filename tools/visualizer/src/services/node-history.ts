import { locateNode, parseGraphText } from "./ir-graph";
import type { Stage } from "../types/stage";

export type MomentKind = "born" | "rewritten" | "moved" | "held" | "gone";

export type NodeMoment = {
  readonly stageId: string;
  readonly title: string;
  readonly kind: MomentKind;
  readonly block: string | null;
  readonly text: string | null;
};

export type NodeHistory = {
  readonly node: string;
  readonly owner: string;
  readonly moments: readonly NodeMoment[];
  readonly bornIn: NodeMoment | null;
  readonly goneIn: NodeMoment | null;
};

type Site = { readonly text: string; readonly block: string | null };

function siteIn(stage: Stage, node: string): Site | null {
  const model = parseGraphText(stage.text);
  if (model === null) return null;
  const found = locateNode(model, node);
  return found === null ? null : { text: found.node.text, block: found.block };
}

function kindOf(before: Site | null, now: Site | null): MomentKind | null {
  if (now === null) return before === null ? null : "gone";
  if (before === null) return "born";
  if (before.text !== now.text) return "rewritten";
  return before.block === now.block ? "held" : "moved";
}

export function historyOf(
  stages: readonly Stage[],
  owner: string,
  node: string,
): NodeHistory {
  const moments: NodeMoment[] = [];
  let before: Site | null = null;

  for (const stage of stages) {
    if (stage.kind !== "ir" || stage.owner !== owner || stage.group === "executed") continue;
    const now = siteIn(stage, node);
    const kind = kindOf(before, now);
    before = now;
    if (kind === null) continue;
    moments.push({
      stageId: stage.id,
      title: stage.title,
      kind,
      block: now?.block ?? null,
      text: now?.text ?? null,
    });
  }

  return {
    node,
    owner,
    moments,
    bornIn: moments.find((moment) => moment.kind === "born") ?? null,
    goneIn: moments.find((moment) => moment.kind === "gone") ?? null,
  };
}
