export type Value = number | string | boolean | null;

export interface ScriptContext {
  readonly vars: Map<string, Value>;
  readonly globals: Map<string, Value>;
  readonly calls: Map<string, ScriptFunction>;
  readonly log: string[];
}

export interface ScriptFunction {
  readonly name: string;
  readonly params: readonly string[];
  readonly body: readonly Statement[];
}

export type Expression =
  | { kind: "literal"; value: Value }
  | { kind: "variable"; name: string }
  | { kind: "binary"; op: "+" | "-" | "*" | "/" | "%" | "==" | "!=" | "<" | "<=" | ">" | ">=" | "&&" | "||"; left: Expression; right: Expression }
  | { kind: "unary"; op: "-" | "!"; value: Expression }
  | { kind: "call"; name: string; args: Expression[] };

export type Statement =
  | { kind: "set"; name: string; value: Expression }
  | { kind: "print"; value: Expression }
  | { kind: "if"; condition: Expression; thenBody: Statement[]; elseBody: Statement[] }
  | { kind: "return"; value?: Expression }
  | { kind: "call"; name: string; args: Expression[] };

export interface RuneScriptProgram {
  readonly functions: Map<string, ScriptFunction>;
  readonly main: readonly Statement[];
}
