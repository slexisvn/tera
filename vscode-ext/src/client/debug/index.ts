import { dirname, join } from "node:path";
import {
  DebugAdapterInlineImplementation,
  debug,
  window,
  workspace,
  type DebugAdapterDescriptor,
  type DebugAdapterDescriptorFactory,
  type DebugConfiguration,
  type DebugConfigurationProvider,
  type ExtensionContext,
  type WorkspaceFolder,
} from "vscode";
import { TeraDebugAdapter } from "./adapter.ts";
import { hasUnresolvedVariablePath, normalizeDebugPath } from "./paths.ts";

const DEBUG_TYPE = "tera";
const WORKER_ENTRY = join("dist", "debug-worker.mjs");

class TeraDebugConfigurationProvider implements DebugConfigurationProvider {
  provideDebugConfigurations(): DebugConfiguration[] {
    return [defaultConfiguration()];
  }

  resolveDebugConfiguration(
    folder: WorkspaceFolder | undefined,
    config: DebugConfiguration,
  ): DebugConfiguration | undefined {
    const next = { ...defaultConfiguration(), ...config };
    next.type = DEBUG_TYPE;
    next.request = next.request || "launch";
    next.name = next.name || "Debug Tera File";
    return resolveProgram(next, folder, false);
  }

  resolveDebugConfigurationWithSubstitutedVariables(
    folder: WorkspaceFolder | undefined,
    config: DebugConfiguration,
  ): DebugConfiguration | undefined {
    return resolveProgram({ ...config }, folder, true);
  }
}

class TeraDebugAdapterFactory implements DebugAdapterDescriptorFactory {
  constructor(private readonly context: ExtensionContext) {}

  createDebugAdapterDescriptor(): DebugAdapterDescriptor {
    return new DebugAdapterInlineImplementation(
      new TeraDebugAdapter(this.context.asAbsolutePath(WORKER_ENTRY)),
    );
  }
}

function defaultConfiguration(): DebugConfiguration {
  return {
    type: DEBUG_TYPE,
    request: "launch",
    name: "Debug Tera File",
    program: "${file}",
    typecheck: "off",
  };
}

function resolveProgram(
  config: DebugConfiguration,
  folder: WorkspaceFolder | undefined,
  variablesSubstituted: boolean,
): DebugConfiguration | undefined {
  const active = window.activeTextEditor?.document;
  const workspaceFolder = active ? workspace.getWorkspaceFolder(active.uri) : folder;
  const program = typeof config.program === "string" ? config.program.trim() : "";
  if (!program || program === "${file}") {
    config.program = active?.uri.fsPath;
  }
  if (!variablesSubstituted && hasUnresolvedVariablePath(config.program)) return config;
  if (!config.program || hasUnresolvedVariablePath(config.program)) {
    window.showErrorMessage("Open a .tera file before starting the Tera debugger.");
    return undefined;
  }
  config.program = normalizeDebugPath(config.program, workspaceFolder?.uri.fsPath);
  const cwd = typeof config.cwd === "string" ? config.cwd.trim() : "";
  if (!cwd || cwd === "${workspaceFolder}" || hasUnresolvedVariablePath(cwd)) {
    config.cwd = workspaceFolder?.uri.fsPath || dirname(config.program);
  }
  config.cwd = normalizeDebugPath(config.cwd, dirname(config.program));
  return config;
}

export function registerTeraDebugger(context: ExtensionContext): void {
  context.subscriptions.push(
    debug.registerDebugConfigurationProvider(
      DEBUG_TYPE,
      new TeraDebugConfigurationProvider(),
    ),
    debug.registerDebugAdapterDescriptorFactory(
      DEBUG_TYPE,
      new TeraDebugAdapterFactory(context),
    ),
  );
}
