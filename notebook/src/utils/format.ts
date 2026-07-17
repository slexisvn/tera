export function appendInlineCode(target: HTMLElement, text: string | null | undefined): void {
  const source = String(text ?? '');
  const parts = source.split(/(`[^`]+`)/g);
  for (const part of parts) {
    if (!part) continue;
    if (part.length > 1 && part.startsWith('`') && part.endsWith('`')) {
      const code = document.createElement('code');
      code.textContent = part.slice(1, -1);
      target.append(code);
    } else {
      target.append(document.createTextNode(part));
    }
  }
}
