import { parseRuneScript, RuneScriptRuntime } from "./index";
import type { Value } from "./types";

export interface RuneScriptEvent { readonly name: string; readonly args: Value[]; }
export interface ScriptServer { tick: number; readonly events: RuneScriptEvent[]; readonly globals: Record<string, Value>; }

export function createScriptServer(globals: Record<string, Value> = {}): ScriptServer {
  return { tick: 0, events: [], globals };
}

/** Executes server-side content on the authoritative 600 ms clock. */
export function runScriptEvent(server: ScriptServer, source: string, eventName: string, args: Value[] = []): { result: Value | undefined; log: readonly string[] } {
  const program = parseRuneScript(source);
  const runtime = new RuneScriptRuntime({
    event_log: (...values) => {
      server.events.push({ name: String(values[0] ?? "event"), args: values.slice(1) });
      return null;
    },
    get_tick: () => server.tick
  });
  const context = runtime.createContext(server.globals);
  const result = runtime.call(program, context, eventName, args);
  return { result, log: context.log };
}

export function advanceScriptTick(server: ScriptServer): void { server.tick += 1; }
