import type { Stage } from "../types/stage";

export type AnalysisUse = {
  readonly name: string;
  readonly invalidatedBy: string | null;
  readonly passesAgo: number | null;
  readonly recomputed: boolean;
};

function earlierPasses(stages: readonly Stage[], stage: Stage): readonly Stage[] {
  return stages.filter(
    (candidate) =>
      candidate.owner === stage.owner &&
      candidate.kind === "ir" &&
      candidate.ordinal < stage.ordinal,
  );
}

export function analysisHistory(
  stages: readonly Stage[],
  stage: Stage,
): readonly AnalysisUse[] {
  const before = earlierPasses(stages, stage);
  return stage.requires.map((name) => {
    for (let at = before.length - 1; at >= 0; at--) {
      const candidate = before[at]!;
      if (!candidate.invalidated.includes(name)) continue;
      return {
        name,
        invalidatedBy: candidate.title,
        passesAgo: before.length - at,
        recomputed: true,
      };
    }
    return {
      name,
      invalidatedBy: null,
      passesAgo: before.length === 0 ? null : before.length,
      recomputed: before.length === 0,
    };
  });
}
