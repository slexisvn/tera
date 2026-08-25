export const RUN_SHORTCUT = navigator.platform.startsWith("Mac") ? "⌘⏎" : "Ctrl+⏎";

type RunButtonProps = {
  busy: boolean;
  ready: boolean;
  onRun: () => void;
};

export function RunButton({ busy, ready, onRun }: RunButtonProps) {
  return (
    <button
      type="button"
      className="run-button"
      data-busy={busy || undefined}
      onClick={onRun}
      disabled={busy || !ready}
      title={ready ? `Compile the code and run it — ${RUN_SHORTCUT}` : "The compiler is still loading"}
    >
      {ready ? "Compile & run" : "Loading compiler…"}
      <span className="run-shortcut">{RUN_SHORTCUT}</span>
    </button>
  );
}
