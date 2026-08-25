export const RUN_SHORTCUT = navigator.platform.startsWith("Mac") ? "⌘⏎" : "Ctrl+⏎";

type RunButtonProps = {
  busy: boolean;
  onRun: () => void;
  className?: string;
};

export function RunButton({ busy, onRun, className = "" }: RunButtonProps) {
  return (
    <button
      type="button"
      className={`run-button ${className}`.trim()}
      onClick={onRun}
      disabled={busy}
      title={`Compile the code and run it — ${RUN_SHORTCUT}`}
    >
      {busy ? "Compiling…" : "Compile & run"}
      <span className="run-shortcut">{RUN_SHORTCUT}</span>
    </button>
  );
}
