import { createScriptServer, runScriptEvent, advanceScriptTick } from "./server";

const source = "proc on_attack(attacker_id, defender_id, attack_roll, defence_roll) { if (attack_roll > defence_roll) { call event_log(\"combat_hit\", attacker_id, defender_id); return 1; } call event_log(\"combat_miss\", attacker_id, defender_id); return 0; }";
const server = createScriptServer();
const result = runScriptEvent(server, source, "on_attack", ["blue-1", "red-1", 72, 61]);
advanceScriptTick(server);
console.log({ tick: server.tick, result: result.result, events: server.events, log: result.log });