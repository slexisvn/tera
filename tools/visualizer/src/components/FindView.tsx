import { useDebounced } from "@tera/ui";
import { useId, useMemo, useState } from "react";
import { SEARCH_DELAY_MS } from "../config/constants";
import { searchStages, type SearchHit } from "../services/stage-search";
import type { Stage } from "../types/stage";

type FindViewProps = {
  stages: readonly Stage[];
  hasRun: boolean;
  onSelect: (id: string) => void;
};

function Hit({ hit, onSelect }: { hit: SearchHit; onSelect: (id: string) => void }) {
  return (
    <li>
      <button
        type="button"
        className="find-hit"
        onClick={() => onSelect(hit.stageId)}
        title={`Open ${hit.title} on ${hit.owner}`}
      >
        <span className="find-where">
          {hit.title}
          <span className="find-owner">{hit.owner}</span>
        </span>
        <code className="find-line">{hit.text}</code>
      </button>
    </li>
  );
}

export function FindView({ stages, hasRun, onSelect }: FindViewProps) {
  const [query, setQuery] = useState("");
  const [regex, setRegex] = useState(false);
  const fieldId = useId();

  const settled = useDebounced(query, SEARCH_DELAY_MS);
  const typing = settled !== query;
  const report = useMemo(() => searchStages(stages, settled, { regex }), [regex, settled, stages]);

  return (
    <div className="find" data-typing={typing || undefined}>
      <div className="find-bar">
        <label className="visually-hidden" htmlFor={fieldId}>
          Text to look for in every stage
        </label>
        <input
          id={fieldId}
          type="search"
          value={query}
          placeholder="CheckBounds, v17, Int32Add…"
          onChange={(event) => setQuery(event.target.value)}
        />
        <button
          type="button"
          className="find-regex"
          aria-pressed={regex}
          title="Read what you typed as a regular expression"
          onClick={() => setRegex((on) => !on)}
        >
          .*
        </button>
      </div>

      {!hasRun && <p className="console-note">Compile something first — this searches the stages of the last compile.</p>}
      {hasRun && report.error !== null && <p className="console-note bad">{report.error}</p>}
      {hasRun && report.error === null && settled.trim() !== "" && (
        <>
          <div className="find-summary">
            {report.total === 0 ? (
              <span>No stage contains that.</span>
            ) : (
              <>
                <span>
                  {report.total} {report.total === 1 ? "line" : "lines"} in {report.stages}{" "}
                  {report.stages === 1 ? "stage" : "stages"}
                </span>
                {report.first !== null && (
                  <button
                    type="button"
                    className="find-jump"
                    onClick={() => onSelect(report.first!.stageId)}
                    title="The earliest stage this text appears in — the pass that introduced it"
                  >
                    first: {report.first.title}
                    <span className="find-owner">{report.first.owner}</span>
                  </button>
                )}
                {report.last !== null && report.last.stageId !== report.first?.stageId && (
                  <button
                    type="button"
                    className="find-jump"
                    onClick={() => onSelect(report.last!.stageId)}
                    title="The last stage this text survives in"
                  >
                    last: {report.last.title}
                    <span className="find-owner">{report.last.owner}</span>
                  </button>
                )}
              </>
            )}
          </div>
          <ul className="find-hits">
            {report.hits.map((hit) => (
              <Hit key={`${hit.stageId}-${hit.line}`} hit={hit} onSelect={onSelect} />
            ))}
          </ul>
          {report.capped && (
            <p className="console-note">
              Showing the first {report.hits.length} of {report.total} — narrow the search.
            </p>
          )}
        </>
      )}
    </div>
  );
}
