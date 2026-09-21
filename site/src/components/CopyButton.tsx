import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { ui } from '../content/site';

export function CopyButton({ value, label = ui.copy }: { value: string; label?: string }) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'error'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => setStatus('idle'), [value]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setStatus('copied');
    } catch {
      setStatus('error');
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setStatus('idle'), 2400);
  }

  const message = status === 'copied' ? ui.copied : status === 'error' ? ui.copyFailed : label;
  return <span className="copy-control">
    <button className="icon-button" type="button" onClick={copy} title={message} aria-label={message}>
      {status === 'copied' ? <Check size={16} /> : <Copy size={16} />}
    </button>
    <span className={status === 'idle' ? 'sr-only' : 'copy-status'} role="status">{status !== 'idle' && message}</span>
  </span>;
}
