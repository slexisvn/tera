import type { Stage } from "../types/stage";

export function notable(stage: Stage): boolean {
  return stage.changed || stage.failed || stage.remarks.length > 0;
}

export function notableOnly(stages: readonly Stage[]): readonly Stage[] {
  return stages.filter(notable);
}

export function quietCount(stages: readonly Stage[]): number {
  return stages.length - stages.filter(notable).length;
}
