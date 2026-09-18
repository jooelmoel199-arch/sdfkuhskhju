import type { Expression, RuneScriptProgram, ScriptFunction, Statement, Value } from "./types";

type Token =
  | { kind: "number" | "string" | "identifier" | "symbol" | "eof"; text: string };

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (/\\s/.test(c)) { i++; continue; }
    if (source.startsWith("//", i)) {
      const end = source.indexOf("\n", i);
      i = end === -1 ? source.length : end + 1;
      continue;
    }
    if (c === '"') {
      let out = ""; i++;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === "\\" && i + 1 < source.length) { out += source[i + 1]; i += 2; }
        else { out += source[i++]; }
      }
      if (source[i] === '"') i++;
      tokens.push({ kind: "string", text: out });
      continue;
    }
    const number = source.slice(i).match(/^-?(?:\\d+\\.?)?\\d+/)?.[0];
    if (number) { tokens.push({ kind: "number", text: number }); i += number.length; continue; }
    const identifier = source.slice(i).match(/^[A-Za-z_][A-Za-z0-9_]*/)?.[0];
    if (identifier) { tokens.push({ kind: "identifier", text: identifier }); i += identifier.length; continue; }
    const two = source.slice(i, i + 2);
    if (["==","!=","<=",">=","&&","||"].includes(two)) { tokens.push({ kind: "symbol", text: two }); i += 2; continue; }
    if ("{}();,+-*/%!=<>".includes(c)) { tokens.push({ kind: "symbol", text: c }); i++; continue; }
    throw new Error(`RuneScript lexer: unexpected character '${c}' at ${i}`);
  }
  tokens.push({ kind: "eof", text: "" });
  return tokens;
}

export function parseRuneScript(source: string): RuneScriptProgram {
  const tokens = lex(source);
  let p = 0;
  const peek = () => tokens[p];
  const take = () => tokens[p++];
  const expect = (text: string) => {
    const t = take();
    if (t.text !== text) throw new Error(`RuneScript parser: expected '${text}', got '${t.text}'`);
  };
  const identifier = () => {
    const t = take();
    if (t.kind !== "identifier") throw new Error(`RuneScript parser: expected identifier, got '${t.text}'`);
    return t.text;
  };

  function primary(): Expression {
    const t = take();
    if (t.kind === "number") return { kind: "literal", value: Number(t.text) };
    if (t.kind === "string") return { kind: "literal", value: t.text };
    if (t.kind === "identifier") {
      if (t.text === "true" || t.text === "false") return { kind: "literal", value: t.text === "true" };
      if (t.text === "null") return { kind: "literal", value: null };
      if (peek().text === "(") {
        take();
        const args: Expression[] = [];
        if (peek().text !== ")") {
          do { args.push(expression()); } while (peek().text === "," && (take(), true));
        }
        expect(")");
        return { kind: "call", name: t.text, args };
      }
      return { kind: "variable", name: t.text };
    }
    if (t.text === "(") {
      const e = expression(); expect(")"); return e;
    }
    throw new Error(`RuneScript parser: unexpected '${t.text}'`);
  }

  function unary(): Expression {
    if (peek().text === "-" || peek().text === "!") {
      const op = take().text as "-" | "!";
      return { kind: "unary", op, value: unary() };
    }
    return primary();
  }

  const precedence: Record<string, number> = {"||":1,"&&":2,"==":3,"!=":3,"<":4,"<=":4,">":4,">=":4,"+":5,"-":5,"*":6,"/":6,"%":6};
  function expression(min = 0): Expression {
    let left = unary();
    while (true) {
      const op = peek().text;
      const prec = precedence[op];
      if (prec === undefined || prec < min) break;
      take();
      const right = expression(prec + 1);
      left = { kind: "binary", op: op as Expression & never, left, right } as Expression;
    }
    return left;
  }

  function block(): Statement[] {
    expect("{");
    const result: Statement[] = [];
    while (peek().text !== "}") result.push(statement());
    expect("}");
    return result;
  }

  function statement(): Statement {
    const keyword = identifier();
    if (keyword === "set") {
      const name = identifier(); expect("="); const value = expression(); expect(";");
      return { kind: "set", name, value };
    }
    if (keyword === "print") {
      const value = expression(); expect(";");
      return { kind: "print", value };
    }
    if (keyword === "call") {
      const name = identifier(); expect("(");
      const args: Expression[] = [];
      if (peek().text !== ")") do { args.push(expression()); } while (peek().text === "," && (take(), true));
      expect(")"); expect(";");
      return { kind: "call", name, args };
    }
    if (keyword === "return") {
      const value = peek().text === ";" ? undefined : expression(); expect(";");
      return { kind: "return", value };
    }
    if (keyword === "if") {
      expect("("); const condition = expression(); expect(")");
      const thenBody = block();
      const elseBody = peek().text === "else" ? (take(), block()) : [];
      return { kind: "if", condition, thenBody, elseBody };
    }
    throw new Error(`RuneScript parser: unknown statement '${keyword}'`);
  }

  const functions = new Map<string, ScriptFunction>();
  const main: Statement[] = [];
  while (peek().kind !== "eof") {
    const keyword = identifier();
    if (keyword === "proc") {
      const name = identifier(); expect("(");
      const params: string[] = [];
      if (peek().text !== ")") do { params.push(identifier()); } while (peek().text === "," && (take(), true));
      expect(")");
      functions.set(name, { name, params, body: block() });
    } else {
      throw new Error(`RuneScript parser: top-level '${keyword}' is not supported; use proc or statements`);
    }
  }
  return { functions, main };
}
