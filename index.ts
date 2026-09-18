import { createPlayer, equipItem, type TowerEntity } from "./moba/entities";
import { createAttackTimerState } from "./combat/timers";
import { shopCatalog } from "./moba/economy";
import { advanceTick, TICK_MS, type SimulationState } from "./moba/simulation";
import { BLUE_TOWER_X, RED_TOWER_X, BLUE_BASE_X, RED_BASE_X, zoneAt } from "./moba/lane";
import { levelOf } from "./moba/stats";

function makeTower(id: string, team: "blue" | "red", x: number): TowerEntity {
  return {
    id,
    kind: "tower",
    team,
    tile: { x, y: 0 },
    currentHp: 250,
    maxHp: 250,
    attackBonus: 40,
    maxHit: 18,
    attackRange: 3,
    attackTimer: createAttackTimerState(),
    alive: true
  };
}

function itemById(id: string) {
  const item = shopCatalog.find((candidate) => candidate.id === id);
  if (!item) throw new Error(`Unknown starting item ${id}`);
  return item;
}

function buildStartingLoadout(playerId: string, team: "blue" | "red", role: "melee" | "ranged" | "mage") {
  const tile = { x: team === "blue" ? BLUE_BASE_X + 4 : RED_BASE_X - 4, y: 0 };
  let player = createPlayer(playerId, team, tile);
  player = { ...player, zone: zoneAt(tile), gp: 300 };

  const loadouts: Record<typeof role, string[]> = {
    melee: ["rune_scimitar", "rune_defender", "fighter_torso", "berserker_helm"],
    ranged: ["magic_shortbow", "black_dhide_body", "archer_helm"],
    mage: ["ancient_staff", "mystic_robe_top"]
  } as const;

  for (const id of loadouts[role]) {
    const item = itemById(id);
    if (player.gp >= item.cost) {
      player = equipItem(player, item);
    }
  }
  return player;
}

function main(): void {
  const blue = buildStartingLoadout("blue-1", "blue", "melee");
  const red = buildStartingLoadout("red-1", "red", "ranged");

  const state: SimulationState = {
    tick: 0,
    blue,
    red,
    minions: [],
    towers: [makeTower("blue-tower", "blue", BLUE_TOWER_X), makeTower("red-tower", "red", RED_TOWER_X)],
    log: [],
    rng: Math.random
  };

  const MAX_TICKS = 300; // 300 * 600ms = 3 simulated minutes

  for (let i = 0; i < MAX_TICKS; i += 1) {
    advanceTick(state);
  }

  console.log(`Simulated ${MAX_TICKS} ticks (${(MAX_TICKS * TICK_MS) / 1000}s of match time)\n`);
  for (const entry of state.log) {
    console.log(`[tick ${entry.tick.toString().padStart(4, " ")}] ${entry.message}`);
  }

  console.log("\n--- Final state ---");
  for (const player of [state.blue, state.red]) {
    console.log(
      `${player.id} (${player.team}): HP ${player.currentHp}/${levelOf(player.stats, "hitpoints")}, ` +
        `Atk ${levelOf(player.stats, "attack")} Str ${levelOf(player.stats, "strength")} Def ${levelOf(player.stats, "defence")} ` +
        `Rng ${levelOf(player.stats, "ranged")} Mag ${levelOf(player.stats, "magic")}, GP ${player.gp}, ` +
        `K/D ${player.kills}/${player.deaths}`
    );
  }
  for (const tower of state.towers) {
    console.log(`${tower.id}: ${tower.alive ? `${tower.currentHp}/${tower.maxHp} HP` : "DESTROYED"}`);
  }
}

main();
