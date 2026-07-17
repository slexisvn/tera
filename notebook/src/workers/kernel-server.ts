import { createKernel } from '../vscode/kernel-vscode';
import { errorMessage } from "../types/kernel";

type KernelServerMessage =
  | { id: number; type: "execute"; source: string }
  | { id: number; type: "restart"; source?: never };

const writeProtocol = process.stdout.write.bind(process.stdout);

const toStderr = (...args: unknown[]): boolean => process.stderr.write(args.map(String).join(' ') + '\n');
console.log = toStderr;
console.info = toStderr;
console.warn = toStderr;
console.error = toStderr;

const kernel = createKernel();

function send(obj: object): void {
  writeProtocol(JSON.stringify(obj) + '\n');
}

async function handle(msg: KernelServerMessage): Promise<void> {
  const { id, type, source } = msg;
  try {
    let result;
    if (type === 'execute') result = await kernel.execute(source);
    else if (type === 'restart') { kernel.restart(); result = { ok: true }; }
    else throw new Error(`unknown message '${type}'`);
    send({ id, ok: true, result });
  } catch (err) {
    send({ id, ok: false, error: errorMessage(err) });
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (line.trim()) handle(JSON.parse(line) as KernelServerMessage);
  }
});
process.stdin.on('end', () => process.exit(0));

send({ type: 'ready' });
