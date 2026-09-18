import type { Expression, RuneScriptProgram, ScriptContext, Statement, Value } from "./types";

export class RuneScriptRuntime {
  constructor(private readonly builtins: Record<string, (...args: Value[]) => Value> = {}) {}

  createContext(globals: Record<string, Value> = {}): ScriptContext {
    return { vars: new Map(), globals: new Map(Object.entries(globals)), calls: new Map(), log: [] };
  }

  run(program: RuneScriptProgram, context: ScriptContext): Value | undefined {
    for (const fn of program.functions.values()) context.calls.set(fn.name, fn);
    return this.runStatements(program.main, context);
  }

  call(program: RuneScriptProgram, context: ScriptContext, name: string, args: Value[] = []): Value | undefined {
    for (const fn of program.functions.values()) context.calls.set(fn.name, fn);
    const fn = context.calls.get(name);
    if (!fn) throw new Error(`RuneScript runtime: unknown procedure '${name}'`);
    const previous = new Map(context.vars);
    context.vars.clear();
    fn.params.forEach((param, i) => context.vars.set(param, args[i] ?? null));
    const result = this.runStatements(fn.body, context);
    context.vars.clear();
    for (const [key, value] of previous) context.vars.set(key, value);
    return result;
  }

  private runStatements(statements: readonly Statement[], context: ScriptContext): Value | undefined {
    for (const statement of statements) {
      const result = this.runStatement(statement, context);
      if (result !== undefined) return result;
    }
    return undefined;
  }

  private runStatement(statement: Statement, context: ScriptContext): Value | undefined {
    switch (statement.kind) {
      case "set": context.vars.set(statement.name, this.eval(statement.value, context)); return undefined;
      case "print": context.log.push(String(this.eval(statement.value, context))); return undefined;
      case "call": this.callFromExpression(statement.name, statement.args, context); return undefined;
      case "return": return statement.value ? this.eval(statement.value, context) : null;
      case "if":
        return this.runStatements(this.truthy(this.eval(statement.condition, context)) ? statement.thenBody : statement.elseBody, context);
    }
  }

  private callFromExpression(name: string, args: Expression[], context: ScriptContext): Value | undefined {
    const values = args.map(arg => this.eval(arg, context));
    if (this.builtins[name]) return this.builtins[name](...values);
    const fn = context.calls.get(name);
    if (!fn) throw new Error(`RuneScript runtime: unknown call '${name}'`);
    return this.call({ functions: new Map([[name, fn]]), main: [] }, context, name, values);
  }

  private eval(expr: Expression, context: ScriptContext): Value {
    switch (expr.kind) {
      case "literal": return expr.value;
      case "variable": return context.vars.get(expr.name) ?? context.globals.get(expr.name) ?? null;
      case "unary": {
        const v = this.eval(expr.value, context);
        return expr.op === "!" ? !this.truthy(v) : -this.number(v);
      }
      case "call": return this.callFromExpression(expr.name, expr.args, context) ?? null;
      case "binary": {
        const a = this.eval(expr.left, context), b = this.eval(expr.right, context);
        switch (expr.op) {
          case "+": return typeof a === "string" || typeof b === "string" ? String(a) + String(b) : this.number(a) + this.number(b);
          case "-": return this.number(a) - this.number(b);
          case "*": return this.number(a) * this.number(b);
          case "/": return this.number(a) / this.number(b);
          case "%": return this.number(a) % this.number(b);
          case "==": return a === b;
          case "!=": return a !== b;
          case "<": return this.number(a) < this.number(b);
          case "<=": return this.number(a) <= this.number(b);
          case ">": return this.number(a) > this.number(b);
          case ">=": return this.number(a) >= this.number(b);
          case "&&": return this.truthy(a) && this.truthy(b);
          case "||": return this.truthy(a) || this.truthy(b);
        }
      }
    }
  }

  private truthy(v: Value): boolean { return Boolean(v); }
  private number(v: Value): number { return typeof v === "number" ? v : Number(v ?? 0); }
}
