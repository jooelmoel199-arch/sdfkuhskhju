import { parseRuneScript, RuneScriptRuntime } from "./index";

const source = `proc damage_roll(attacker, defender) {
  set accuracy = attacker + 10;
  set defence = defender;
  if (accuracy > defence) {
    print "hit";
    return 12;
  } else {
    print "miss";
    return 0;
  }
}`;

const program = parseRuneScript(source);
const runtime = new RuneScriptRuntime();
const context = runtime.createContext();
const damage = runtime.call(program, context, "damage_roll", [40, 30]);

console.log({ damage, log: context.log });
