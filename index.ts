import { advanceTick, TICK_MS } from "./moba/simulation";
import { createPrototypeState } from "./moba/factory";
import { levelOf } from "./moba/stats";

const state = createPrototypeState();
const MAX_TICKS = 300;

for (let i = 0; i < MAX_TICKS; i += 1) advanceTick(state);

console.log(`Simulated ${MAX_TICKS} ticks (${(MAX_TICKS * TICK_MS) / 1000}s of match time)\n`);
for (const entry of state.log) {
  console.log(`[tick ${entry.tick.toString().padStart(4, " ")}] ${entry.message}`);
}

console.log("\n--- Final state ---");
for (const player of [state.blue, state.red]) {
  console.log(
    `${player.id} (${player.team}, ${player.laneId}): HP ${player.currentHp}/${levelOf(player.stats, "hitpoints")}, ` +
    `Atk ${levelOf(player.stats, "attack")} Str ${levelOf(player.stats, "strength")} Def ${levelOf(player.stats, "defence")} ` +
    `Rng ${levelOf(player.stats, "ranged")} Mag ${levelOf(player.stats, "magic")}, GP ${player.gp}, K/D ${player.kills}/${player.deaths}`
  );
}
for (const tower of state.towers) {
  console.log(`${tower.id}: ${tower.alive ? `${tower.currentHp}/${tower.maxHp} HP` : "DESTROYED"}`);
}
