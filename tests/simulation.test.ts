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

import { createPrototypeState, createPvpTestState } from "../moba/factory";
import { advanceTick } from "../moba/simulation";
import { shopCatalog } from "../moba/economy";
import { distanceHitDelay, meleeHitTick, projectileHitTick } from "../combat/pendingHits";
import { rollDragonClawsSpecial } from "../combat/resolve";
import { zeroBonuses, effectiveDefenceLevel, effectiveAttackLevel } from "../combat/formulas";

function testPrototypeShape() {
  const state = createPrototypeState();
  equal(state.players.length, 10, "prototype should have five players per team");
  deepEqualSet(new Set(state.players.map(player => player.role)), new Set(["top", "middle", "bottom", "support", "jungle"]), "roster should cover all five MOBA positions");
  equal(state.towers.length, 6, "prototype should have two towers per lane");
  equal(state.jungleCamps.length, 5, "prototype should have four jungle camps plus one river boss");
  equal(state.tick, 0, "simulation starts at tick zero");
}


function testPvpTestLane() {
  const state = createPvpTestState();
  equal(state.pvpTest, true, "PvP test state should be marked as test mode");
  equal(state.players.length, 2, "PvP test lane should contain exactly two players");
  equal(state.towers.length, 0, "PvP test lane should not contain towers");
  equal(state.minions.length, 0, "PvP test lane should not contain minions");
  equal(state.blue.currentHp, 99, "PvP test player should start at 99 HP");
  equal(state.blue.prayerPoints, 99, "PvP test player should start at 99 Prayer");
  ok(state.blue.inventory.some(item => item.id === "dragon_claws"), "PvP test loadout should contain dragon claws");
  ok(state.blue.inventory.some(item => item.id === "armadyl_godsword"), "PvP test loadout should contain AGS");
  ok(state.blue.inventory.some(item => item.id === "armadyl_crossbow"), "PvP test loadout should contain ACB");
  ok(state.blue.inventory.some(item => item.id === "ancient_staff"), "PvP test loadout should contain an ice spell weapon");
}

function testHumanPrayerInputIsOneShot() {
  const state = createPvpTestState();
  state.humanControl = {
    attackEnabled: false,
    laneId: "middle",
    attackTargetId: state.red.id,
    activatePrayer: "protect_from_melee"
  };
  advanceTick(state);
  ok(state.blue.activePrayers.includes("protect_from_melee"), "prayer input should activate overhead");
  advanceTick(state);
  ok(state.blue.activePrayers.includes("protect_from_melee"), "prayer should remain active until another explicit toggle");
}

function testQueuedHitResolvesOnTargetTurn() {
  const state = createPvpTestState();
  state.pendingHits.push({
    id: "test-hit",
    dueTick: 0,
    attackerId: state.blue.id,
    targetId: state.red.id,
    attackerPid: state.blue.pid,
    targetPid: state.red.pid,
    style: "slash",
    attackType: "aggressive",
    landed: true,
    hitChance: 1,
    rawDamage: 99,
    createdTick: 0
  });
  state.humanControl = { attackEnabled: false, laneId: "middle", attackTargetId: state.red.id };
  advanceTick(state);
  equal(state.red.alive, false, "queued hit should kill before the target's combat turn");
  equal(state.red.kills, 0, "dead target must not retaliate after its queued death");
}

function testGearSwapCanAttackSameTick() {
  const state = createPvpTestState();
  state.blue = {
    ...state.blue,
    tile: { x: 19, y: state.blue.tile.y },
    attackTimer: { lastAttackTick: -10, weaponCooldownTicks: 0, additiveAttackDelayTicks: 0 }
  };
  state.players = state.players.map(player => player.id === state.blue.id ? state.blue : player);
  state.red = { ...state.red, tile: { x: 20, y: state.red.tile.y } };
  state.players = state.players.map(player => player.id === state.red.id ? state.red : player);
  state.humanControl = {
    attackEnabled: true,
    laneId: "middle",
    attackTargetId: state.red.id,
    equipItemId: "armadyl_godsword"
  };
  advanceTick(state);
  equal(state.blue.equipment.weapon?.id, "armadyl_godsword", "AGS should equip on the input tick");
  ok(state.pendingHits.length > 0 || state.combatEvents.some(event => event.attackerId === state.blue.id),
    "gear switch should not consume the entire player turn");
  equal(state.blue.attackType, "aggressive", "AGS should select its default aggressive style");
}

function testFoodAddsToCombatTimer() {
  const state = createPvpTestState();
  const startingSharks = state.blue.inventory.find(item => item.id === "shark")?.quantity ?? 0;
  state.humanControl = {
    attackEnabled: true,
    laneId: "middle",
    attackTargetId: state.red.id,
    consumeItemId: "shark"
  };
  state.blue = {
    ...state.blue,
    attackTimer: { lastAttackTick: 0, weaponCooldownTicks: 4, additiveAttackDelayTicks: 0 },
    eatDelayUntilTick: 0
  };
  state.players = state.players.map(player => player.id === state.blue.id ? state.blue : player);
  advanceTick(state);
  equal(state.blue.inventory.find(item => item.id === "shark")?.quantity, startingSharks - 1, "shark should be consumed once");
  equal(state.blue.attackTimer.additiveAttackDelayTicks, 3, "shark should add three ticks to the attack cycle");
}

function testKarambwanCombo() {
  const state = createPvpTestState();
  const startingSharks = state.blue.inventory.find(item => item.id === "shark")?.quantity ?? 0;
  const startingKarambwans = state.blue.inventory.find(item => item.id === "karambwan")?.quantity ?? 0;
  state.humanControl = {
    attackEnabled: true,
    laneId: "middle",
    attackTargetId: state.red.id,
    consumeItemId: "shark",
    comboConsumableId: "karambwan"
  };
  advanceTick(state);
  equal(state.blue.inventory.find(item => item.id === "shark")?.quantity, startingSharks - 1, "combo shark should be consumed");
  equal(state.blue.inventory.find(item => item.id === "karambwan")?.quantity, startingKarambwans - 1, "karambwan should be consumed on the same tick");
  equal(state.blue.attackTimer.additiveAttackDelayTicks, 5, "shark plus karambwan should add five ticks");
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
    equipment: { ...state.blue.equipment, weapon: { ...rangedWeapon, attackRange: 8 } },
    attackType: "rapid_ranged"
  };
  state.players = state.players.map(player => player.id === state.blue.id ? state.blue : player);
  state.players = state.players.map(player => player.id === state.red.id ? { ...player, tile: { x: 20, y: 20 }, zone: "lane" } : player);
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
  equal(state.projectiles[0].hitTick - state.projectiles[0].createdTick, 3, "8-tile bow projectile should use a 3-tick hit delay");
}

function testOsrsHitTiming() {
  equal(distanceHitDelay("ranged", 1), 2, "bows should hit in 2 ticks at distance 1");
  equal(distanceHitDelay("ranged", 8), 3, "bows should hit in 3 ticks at distance 8");
  equal(distanceHitDelay("ranged", 9), 4, "bows should hit in 4 ticks at distance 9");
  equal(distanceHitDelay("ranged", 2), 2, "bows should hit in 2 ticks at distance 2");
  equal(distanceHitDelay("ranged", 3), 3, "bows should hit in 3 ticks at distance 3");
  equal(distanceHitDelay("magic", 2), 3, "magic should hit in 3 ticks at distance 2");
  equal(distanceHitDelay("magic", 8), 5, "magic should hit in 5 ticks at distance 8");
  equal(distanceHitDelay("magic", 1), 2, "magic should hit in 2 ticks at distance 1");
  equal(distanceHitDelay("magic", 4), 3, "magic should hit in 3 ticks at distance 4");
  equal(distanceHitDelay("magic", 5), 4, "magic should hit in 4 ticks at distance 5");
  equal(meleeHitTick(10, 1, 2), 10, "higher-priority attacker should land melee damage on the same tick");
  equal(meleeHitTick(10, 2, 1), 11, "lower-priority attacker should incur a one-tick processing delay");
  equal(projectileHitTick(10, "ranged", 8, 1, 2), 13, "higher-priority ranged attack uses the 3-tick projectile delay");
  equal(projectileHitTick(10, "ranged", 8, 2, 1), 14, "lower-priority ranged attack gets the processing-order tick");
}

function testPlayerMagicFormula() {
  const levels = { attack: 70, strength: 70, defence: 70, ranged: 70, magic: 80 };
  equal(effectiveAttackLevel(levels, "magic", "accurate", 1), 88, "player spell accuracy should use Magic level + 8");
  equal(effectiveDefenceLevel(levels, "magic", "accurate", 1, 1), 85, "player magic defence should be 70% Magic + 30% Defence + 8");
}

function testDragonClawsSpecial() {
  const result = rollDragonClawsSpecial({
    style: "slash",
    attackType: "aggressive",
    attackerLevels: { attack: 99, strength: 99, defence: 99, ranged: 99, magic: 99 },
    defenderLevels: { attack: 1, strength: 1, defence: 1, ranged: 1, magic: 1 },
    attackerBonuses: { ...zeroBonuses, slash_attack_bonus: 132, melee_strength_bonus: 114 },
    defenderBonuses: { ...zeroBonuses },
    defenderPrayers: [],
    attackerIsPlayer: true,
    rng: () => 0
  });
  equal(result.damages.length, 4, "Dragon claws should generate four hitsplats");
  ok(result.damages.every(damage => damage >= 0), "Dragon claws damage should never be negative");
  ok(result.damages.reduce((sum, damage) => sum + damage, 0) > 0, "Dragon claws should land against a very low defence target");
}

function testQueuedHitUsesImpactPrayer() {
  const state = createPvpTestState();
  state.blue = { ...state.blue, currentHp: 99, tile: { x: 19, y: state.blue.tile.y } };
  state.red = { ...state.red, currentHp: 99, tile: { x: 20, y: state.red.tile.y }, activePrayers: [] };
  state.players = state.players.map(player =>
    player.id === state.blue.id ? state.blue :
    player.id === state.red.id ? state.red : player
  );
  state.pendingHits.push({
    id: "impact-prayer-test",
    dueTick: 1,
    attackerId: state.red.id,
    targetId: state.blue.id,
    attackerPid: state.red.pid,
    targetPid: state.blue.pid,
    style: "ranged",
    attackType: "rapid_ranged",
    landed: true,
    hitChance: 1,
    rawDamage: 20,
    createdTick: 0
  });
  state.humanControl = { attackEnabled: false, laneId: "middle", attackTargetId: state.red.id };

  advanceTick(state);
  state.humanControl.activatePrayer = "protect_from_missiles";
  advanceTick(state);

  equal(state.blue.currentHp, 87, "missile protection should reduce a queued 20 damage hit to 12 at impact");
}

function testRedemptionSavesLethalHit() {
  const state = createPvpTestState();
  state.red = {
    ...state.red,
    currentHp: 5,
    prayerPoints: 99,
    activePrayers: ["redemption"]
  };
  state.players = state.players.map(player => player.id === state.red.id ? state.red : player);
  state.pendingHits.push({
    id: "redemption-test",
    dueTick: 1,
    attackerId: state.blue.id,
    targetId: state.red.id,
    attackerPid: state.blue.pid,
    targetPid: state.red.pid,
    style: "slash",
    attackType: "aggressive",
    landed: true,
    hitChance: 1,
    rawDamage: 20,
    createdTick: 0
  });
  state.humanControl = { attackEnabled: false, laneId: "middle", attackTargetId: state.red.id };
  advanceTick(state);
  advanceTick(state);
  equal(state.red.alive, true, "Redemption should prevent a lethal queued hit from killing the target");
  equal(state.red.currentHp, 24, "Redemption should restore the target to at least 25% of 99 HP");
  equal(state.red.prayerPoints, 0, "Redemption should consume the remaining prayer");
}

function testCampRespawnSchedule() {
  const state = createPrototypeState();
  const camp = state.jungleCamps[0];
  state.jungleCamps[0] = { ...camp, alive: false, currentHp: 0, respawnAtTick: 1 };
  advanceTick(state);
  equal(state.jungleCamps[0].alive, false, "camp should remain dead before respawn tick");
  advanceTick(state);
  equal(state.jungleCamps[0].alive, true, "neutral camp should respawn on its scheduled tick");
  equal(state.jungleCamps[0].currentHp, state.jungleCamps[0].maxHp, "respawned camp should be full HP");
}

testPrototypeShape();
testPvpTestLane();
testHumanPrayerInputIsOneShot();
testQueuedHitResolvesOnTargetTurn();
testGearSwapCanAttackSameTick();
testFoodAddsToCombatTimer();
testKarambwanCombo();
testWaveCadence();
testProjectileDelay();
testOsrsHitTiming();
testPlayerMagicFormula();
testDragonClawsSpecial();
testQueuedHitUsesImpactPrayer();
testRedemptionSavesLethalHit();
testCampRespawnSchedule();

console.log("All simulation tests passed.");
