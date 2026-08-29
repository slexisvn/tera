import type { Theme } from "@tera/ui";
import { useId, useRef, useState } from "react";
import type { Mode } from "../config/panes";
import { SAMPLES, type Sample } from "../content/samples";
import type { ShareOutcome } from "../services/share";
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
  verify: boolean;
  theme: Theme;
  onSample: (sample: Sample) => void;
  onTarget: (id: string) => void;
  onOptLevel: (level: OptLevelId) => void;
  onVerify: (on: boolean) => void;
  onLoadFile: (name: string, source: string) => void;
  onShare: () => Promise<ShareOutcome>;
  onToggleTheme: () => void;
};

export function SetupControls({
  mode,
  targets,
  targetId,
  optLevel,
  verify,
  theme,
  onSample,
  onTarget,
  onOptLevel,
  onVerify,
  onLoadFile,
  onShare,
  onToggleTheme,
}: SetupControlsProps) {
  const fileId = useId();
  const file = useRef<HTMLInputElement>(null);
  const [shared, setShared] = useState(false);
  const [manual, setManual] = useState<string | null>(null);

  const take = async (chosen: File | undefined): Promise<void> => {
    if (chosen === undefined) return;
    onLoadFile(chosen.name, await chosen.text());
  };

  const copyLink = async (): Promise<void> => {
    const outcome = await onShare();
    if (!outcome.copied) {
      setManual(outcome.link);
      return;
    }
    setManual(null);
    setShared(true);
    window.setTimeout(() => setShared(false), 1500);
  };

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
      {mode === "pipeline" && (
        <label
          className="field check"
          title="Check the SSA invariants after every pass that changed the graph, and report every pass that breaks one"
        >
          <span>Verify each pass</span>
          <input type="checkbox" checked={verify} onChange={(event) => onVerify(event.target.checked)} />
        </label>
      )}
      {mode !== "lab" && (
        <>
          <input
            id={fileId}
            ref={file}
            type="file"
            className="visually-hidden"
            accept=".tera,.txt,text/plain"
            onChange={(event) => {
              void take(event.target.files?.[0]);
              event.currentTarget.value = "";
            }}
          />
          <button
            type="button"
            className="setup-action"
            title="Open a .tera file from disk"
            onClick={() => file.current?.click()}
          >
            Open file
          </button>
          <button
            type="button"
            className="setup-action"
            title="Copy a link that carries this program, target and optimisation level"
            onClick={() => void copyLink()}
          >
            {shared ? "copied" : "Copy link"}
          </button>
          {manual !== null && (
            <label className="field share-manual">
              <span>Copy by hand</span>
              <input
                type="text"
                readOnly
                value={manual}
                onFocus={(event) => event.currentTarget.select()}
              />
            </label>
          )}
        </>
      )}
      <button type="button" className="theme-toggle" onClick={onToggleTheme}>
        {theme === "dark" ? "Light" : "Dark"}
      </button>
    </>
  );
}
