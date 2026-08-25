import type { Theme } from "@tera/ui";
import type { Mode } from "../config/panes";
import { SAMPLES, type Sample } from "../content/samples";
import type { OptLevelId, TargetInfo } from "../types/stage";

const OPT_LEVELS: readonly { id: OptLevelId; label: string }[] = [
  { id: "none", label: "-O none · no passes" },
  { id: "baseline", label: "-O baseline" },
  { id: "speed", label: "-O speed" },
  { id: "max", label: "-O max" },
];

type SetupControlsProps = {
  mode: Mode;
  targets: readonly TargetInfo[];
  targetId: string;
  optLevel: OptLevelId;
  theme: Theme;
  onSample: (sample: Sample) => void;
  onTarget: (id: string) => void;
  onOptLevel: (level: OptLevelId) => void;
  onToggleTheme: () => void;
};

export function SetupControls({
  mode,
  targets,
  targetId,
  optLevel,
  theme,
  onSample,
  onTarget,
  onOptLevel,
  onToggleTheme,
}: SetupControlsProps) {
  return (
    <>
      {mode !== "lab" && (
        <label className="field">
          <span>Sample</span>
          <select
            value=""
            aria-label="Load a sample program"
            onChange={(event) => {
              const sample = SAMPLES.find((item) => item.id === event.target.value);
              if (sample) onSample(sample);
              event.currentTarget.value = "";
            }}
          >
            <option value="">load…</option>
            {SAMPLES.map((sample) => (
              <option key={sample.id} value={sample.id}>
                {sample.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {mode === "pipeline" && (
        <label className="field">
          <span>Compile for</span>
          <select
            value={targetId}
            aria-label="Pipeline and target to compile for"
            onChange={(event) => onTarget(event.target.value)}
          >
            {targets.map((target) => (
              <option key={target.id} value={target.id}>
                {target.label}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="field">
        <span>Passes</span>
        <select
          value={optLevel}
          aria-label="Optimisation level to compile at"
          onChange={(event) => onOptLevel(event.target.value as OptLevelId)}
        >
          {OPT_LEVELS.map((level) => (
            <option key={level.id} value={level.id}>
              {level.label}
            </option>
          ))}
        </select>
      </label>
      <button type="button" className="theme-toggle" onClick={onToggleTheme}>
        {theme === "dark" ? "Light" : "Dark"}
      </button>
    </>
  );
}
