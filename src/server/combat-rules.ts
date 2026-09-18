import { parseRuneScript, RuneScriptRuntime, type Value } from "../runescript";
import type { CombatEvent } from "./game";

const COMBAT_RULES = `
proc on_attack(attacker_id, defender_id, accuracy_roll, hit_chance) {
  if (accuracy_roll < hit_chance) {
    call event_log("combat_hit", attacker_id, defender_id);
    return 1;
  }
  call event_log("combat_miss", attacker_id, defender_id);
  return 0;
}
`;

export interface CombatRules {
  onAttack(attackerId:string, defenderId:string, attackRoll:number, defenceRoll:number):
    { hit:boolean; events:CombatEvent[] };
}

export function createCombatRules(): CombatRules {
  const program = parseRuneScript(COMBAT_RULES);
  return {
    onAttack(attackerId, defenderId, accuracyRoll, hitChance, attackRoll, defenceRoll) {
      const events: CombatEvent[] = [];
      const runtime = new RuneScriptRuntime({
        event_log: (...values:Value[]) => {
          const name=String(values[0] ?? "event");
          if (name==="combat_hit" || name==="combat_miss") {
            events.push({
              tick:0,
              type:name==="combat_hit" ? "hit" : "miss",
              attacker:String(values[1] ?? attackerId),
              defender:String(values[2] ?? defenderId),
              damage:0,
              attackRoll,
              defenceRoll
            });
          }
          return null;
        }
      });
      const result=runtime.call(program, runtime.createContext(), "on_attack",
        [attackerId, defenderId, accuracyRoll, hitChance]);
      return { hit:result===1, events };
    }
  };
}
