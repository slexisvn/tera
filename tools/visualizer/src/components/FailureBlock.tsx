import type { Failure } from "../services/run-report";

type FailureBlockProps = {
  failure: Failure;
  onGoToLine?: (line: number) => void;
};

export function FailureBlock({ failure, onGoToLine }: FailureBlockProps) {
  const body = (
    <>
      <span className="failure-source">{failure.source}</span>
      <span className="failure-message">{failure.message}</span>
    </>
  );
  if (failure.line === null || onGoToLine === undefined) return <div className="failure">{body}</div>;
  return (
    <button type="button" className="failure" onClick={() => onGoToLine(failure.line!)}>
      {body}
      <span className="failure-go">go to line {failure.line}</span>
    </button>
  );
}
