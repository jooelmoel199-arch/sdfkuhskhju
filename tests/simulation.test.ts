function equal(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) throw new Error(message + ` (expected ${String(expected)}, got ${String(actual)})`);
}

function ok(value: unknown, message: string): void {
  if (!value) throw new Error(message);
}

function deepEqualSet(actual: Set<unknown>, expected: Set<unknown>, message: string): void {
  if (actual.size !== expected.size || [...actual].some(value => !expected.has(value))) {
    throw new Error(message);
  }
}

import { createPrototypeState } from "../moba/factory";
import { advanceTick } from "../moba/simulation";
import { shopCatalog } from "../moba/economy";

function testPrototypeShape() {
  const state = createPrototypeState();
  equal(state.players.length, 10, "prototype should have five players per team");
  deepEqualSet(new Set(state.players.map(player => player.role)), new Set(["top", "middle", "bottom", "support", "jungle"]), "roster should cover all five MOBA positions");
  equal(state.towers.length, 6, "prototype should have two towers per lane");
  equal(state.jungleCamps.length, 5, "prototype should have four jungle camps plus one river boss");
  equal(state.tick, 0, "simulation starts at tick zero");
}

function testWaveCadence() {
  const state = createPrototypeState();
  for (let i = 0; i < 16; i += 1) advanceTick(state);
  equal(state.tick, 16, "16 simulation steps should advance through authoritative tick 15");
  equal(state.minions.length, 18, "one three-lane wave should create 18 minions");
  deepEqualSet(new Set(state.minions.map(minion => minion.laneId)), new Set(["top", "middle", "bottom"]), "wave should populate all lanes");
}

function testProjectileDelay() {
  const state = createPrototypeState();
  const rangedWeapon = shopCatalog.find(item => item.id === "magic_shortbow");
  ok(rangedWeapon, "magic shortbow should exist in shop");
  state.blue = {
    ...state.blue,
    tile: { x: 10, y: 20 },
    zone: "lane",
    equipment: { ...state.blue.equipment, weapon: rangedWeapon },
    attackType: "rapid_ranged"
  };
  state.players = state.players.map(player => player.id === state.blue.id ? state.blue : player);
  state.players = state.players.map(player => player.id === state.red.id ? { ...player, tile: { x: 18, y: 20 }, zone: "lane" } : player);
  state.red = state.players.find(player => player.id === state.red.id)!;
  state.humanControl = {
    attackEnabled: true,
    laneId: "middle",
    attackTargetId: state.red.id,
    moveTargetX: state.red.tile.x,
    moveTargetY: state.red.tile.y
  };
  state.rng = (() => {
    let call = 0;
    return () => (call++ % 2 === 0 ? 0 : 0.999999);
  })();

  advanceTick(state);
  if (state.projectiles.length !== 1) {
    throw new Error(
      "ranged attack should create a projectile; blue=" + JSON.stringify(state.blue.tile) +
      " red=" + JSON.stringify(state.red.tile) +
      " gate context logs=" + state.log.slice(-12).map(entry => "[" + entry.tick + "] " + entry.message).join(" | ")
    );
  }
  equal(state.projectiles[0].hitTick, state.tick + 3, "8-tile bow projectile should use a 3-tick hit delay");
}

function testCampRespawnSchedule() {
  const state = createPrototypeState();
  const camp = state.jungleCamps[0];
  state.jungleCamps[0] = { ...camp, alive: false, currentHp: 0, respawnAtTick: 2 };
  advanceTick(state);
  equal(state.jungleCamps[0].alive, false, "camp should remain dead before respawn tick");
  advanceTick(state);
  equal(state.jungleCamps[0].alive, true, "neutral camp should respawn on its scheduled tick");
  equal(state.jungleCamps[0].currentHp, state.jungleCamps[0].maxHp, "respawned camp should be full HP");
}

testPrototypeShape();
testWaveCadence();
testProjectileDelay();
testCampRespawnSchedule();

console.log("All simulation tests passed.");
