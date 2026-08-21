import { describe, expect } from "vitest";
import { nodeEngine } from "../../../helpers/engine.js";
import { itRunsPe, runPe } from "../../../helpers/pe-runner.js";

const src = (...lines: string[]) => lines.join("\n");

function interpreted(source: string): string {
  const stream: string[] = [];
  nodeEngine({ typecheck: "off", output: (text) => stream.push(`${text}\n`) }).run(`${source}\n`);
  return stream.join("");
}

function image(source: string): Uint8Array {
  const program = nodeEngine({ typecheck: "off" }).compileAot(`${source}\n`, {
    backend: "x64-windows",
    format: "executable",
  });
  expect(program.skipped).toEqual([]);
  return program.files[0]!.contents as Uint8Array;
}

function agrees(source: string): void {
  const run = runPe(image(source));

  expect(run.status).toBe(0);
  expect(run.stdout).toBe(interpreted(source));
}

describe("AOT interface dispatch", () => {
  itRunsPe("calls a method on what another interface call answered", () => {
    agrees(
      src(
        "interface Widget:",
        "  render() -> string",
        "interface WidgetFactory:",
        "  createButton() -> Widget",
        "class WinButton implements Widget:",
        "  public render() -> string:",
        '    return "win button"',
        "class MacButton implements Widget:",
        "  public render() -> string:",
        '    return "mac button"',
        "class WinFactory implements WidgetFactory:",
        "  public createButton() -> Widget:",
        "    return WinButton()",
        "class MacFactory implements WidgetFactory:",
        "  public createButton() -> Widget:",
        "    return MacButton()",
        "fn paint(factory: WidgetFactory) -> string:",
        "  return factory.createButton().render()",
        "print(paint(WinFactory()), paint(MacFactory()))",
      ),
    );
  });

  itRunsPe("calls its own abstract method from a base class", () => {
    agrees(
      src(
        "interface Logger:",
        "  log(message: string) -> string",
        "class TextLogger implements Logger:",
        "  public log(message: string) -> string:",
        '    return "log: " + message',
        "class JsonLogger implements Logger:",
        "  public log(message: string) -> string:",
        '    return "json: " + message',
        "abstract class LoggerApp:",
        "  public abstract createLogger() -> Logger",
        "  public run(message: string) -> string:",
        "    return this.createLogger().log(message)",
        "class TextLoggerApp extends LoggerApp:",
        "  public createLogger() -> Logger:",
        "    return TextLogger()",
        "class JsonLoggerApp extends LoggerApp:",
        "  public createLogger() -> Logger:",
        "    return JsonLogger()",
        'print(TextLoggerApp().run("ready"), JsonLoggerApp().run("ready"))',
      ),
    );
  });
});
