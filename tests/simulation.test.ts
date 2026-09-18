import assert from "node:assert/strict";
import { createPrototypeState } from "../moba/factory";
import { advanceTick } from "../moba/simulation";
import { shopCatalog } from "../moba/economy";

function testPrototypeShape() {
  const state = createPrototypeState();
  assert.equal(state.players.length, 6, "prototype should have three players per team");
  assert.equal(state.towers.length, 6, "prototype should have two towers per lane");
  assert.equal(state.jungleCamps.length, 4, "prototype should have four neutral camps");
  assert.equal(state.tick, 0, "simulation starts at tick zero");
}

function testWaveCadence() {
  const state = createPrototypeState();
  for (let i = 0; i < 15; i += 1) advanceTick(state);
  assert.equal(state.tick, 15, "15 simulation steps should equal 15 ticks");
  assert.equal(state.minions.length, 18, "one three-lane wave should create 18 minions");
  assert.deepEqual(
    new Set(state.minions.map(minion => minion.laneId)),
    new Set(["top", "middle", "bottom"]),
    "wave should populate all lanes"
  );
}

function testProjectileDelay() {
  const state = createPrototypeState();
  const rangedWeapon = shopCatalog.find(item => item.id === "magic_shortbow");
  assert.ok(rangedWeapon, "magic shortbow should exist in shop");
  state.blue = {
    ...state.blue,
    tile: { x: 10, y: 20 },
    zone: "lane",
    equipment: { ...state.blue.equipment, weapon: rangedWeapon },
    attackType: "rapid_ranged"
  };
  state.players = state.players.map(player => player.id === state.blue.id ? state.blue : player);
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
  assert.equal(state.projectiles.length, 1, "ranged attack should create a projectile");
  assert.equal(state.projectiles[0].hitTick, state.tick + 1, "projectile should land two ticks from launch time");
}

function testCampRespawnSchedule() {
  const state = createPrototypeState();
  const camp = state.jungleCamps[0];
  state.jungleCamps[0] = { ...camp, alive: false, currentHp: 0, respawnAtTick: 2 };
  advanceTick(state);
  assert.equal(state.jungleCamps[0].alive, false);
  advanceTick(state);
  assert.equal(state.jungleCamps[0].alive, true, "neutral camp should respawn on its scheduled tick");
  assert.equal(state.jungleCamps[0].currentHp, state.jungleCamps[0].maxHp);
}

testPrototypeShape();
testWaveCadence();
testProjectileDelay();
testCampRespawnSchedule();

console.log("All simulation tests passed.");
