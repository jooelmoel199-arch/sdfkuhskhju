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
import { advanceTick, tickRunner } from "../moba/simulation";
import { shopCatalog } from "../moba/economy";
import { distanceHitDelay, meleeHitTick, projectileHitTick } from "../combat/pendingHits";
import { rollDragonClawsSpecial } from "../combat/resolve";
import { zeroBonuses, effectiveDefenceLevel, effectiveAttackLevel } from "../combat/formulas";
import { drainPlayerCommands, enqueuePlayerCommand, makeStrongCommand } from "../combat/commandQueue";
import { queueClientCommand } from "../moba/simulation";

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
  state.red = { ...state.red, equipment: { ...state.red.equipment, weapon: undefined }, activePrayers: [] };
  state.players = state.players.map(player => player.id === state.red.id ? state.red : player);
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





function testPidTurnPreventsDeadPlayerAction() {
  const state = createPvpTestState();
  ok(state.red.equipment.weapon, "red dummy should start with a weapon");
  state.blue = {
    ...state.blue,
    tile: { x: 19, y: state.blue.tile.y },
    attackTimer: { lastAttackTick: -10, weaponCooldownTicks: 4, additiveAttackDelayTicks: 0 }
  };
  state.red = {
    ...state.red,
    tile: { x: 20, y: state.red.tile.y },
    attackTimer: { lastAttackTick: -10, weaponCooldownTicks: 4, additiveAttackDelayTicks: 0 },
    currentHp: 1
  };
  state.players = state.players.map(player =>
    player.id === state.blue.id ? state.blue :
    player.id === state.red.id ? state.red : player
  );
  state.pidOrder = [state.blue.id, state.red.id];
  state.pendingHits.push({
    id: "pid-turn-lethal",
    dueTick: 0,
    attackerId: state.blue.id,
    targetId: state.red.id,
    attackerPid: state.blue.pid,
    targetPid: state.red.pid,
    style: "slash",
    attackType: "aggressive",
    landed: true,
    hitChance: 1,
    rawDamage: 10,
    createdTick: 0
  });
  state.humanControl = {
    attackEnabled: true,
    laneId: "middle",
    attackTargetId: state.red.id
  };

  advanceTick(state);

  ok(!state.red.alive, "lower-PID red player should die on its own target turn");
  ok(
    !state.combatEvents.some(event => event.tick === 0 && event.attackerId === state.red.id),
    "a player killed during its PID turn must not execute combat later that tick"
  );
}

function testPidTurnRunsPrayerBeforeIncomingImpact() {
  const state = createPvpTestState();
  state.blue = { ...state.blue, currentHp: 99, tile: { x: 19, y: state.blue.tile.y }, activePrayers: [] };
  state.red = { ...state.red, tile: { x: 20, y: state.red.tile.y } };
  state.players = state.players.map(player =>
    player.id === state.blue.id ? state.blue :
    player.id === state.red.id ? state.red : player
  );
  state.pidOrder = [state.red.id, state.blue.id];
  state.pendingHits.push({
    id: "pid-prayer-order",
    dueTick: 0,
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
  state.humanControl = {
    attackEnabled: false,
    laneId: "middle",
    attackTargetId: state.red.id,
    activatePrayer: "protect_from_missiles"
  };

  advanceTick(state);

  equal(state.blue.currentHp, 87, "the target's prayer command must execute before its queued impact on its PID turn");
}

function testPvPDummyProvidesIncomingPressure() {
  const state = createPvpTestState();
  state.humanControl = { attackEnabled: false, laneId: "middle", attackTargetId: state.red.id };
  advanceTick(state);
  ok(state.red.activePrayers.includes("protect_from_melee"), "dummy should use a defensive prayer for its melee weapon");
  for (let i = 0; i < 5; i += 1) advanceTick(state);
  ok(
    state.pendingHits.some(hit => hit.attackerId === state.red.id) ||
    state.combatEvents.some(event => event.attackerId === state.red.id),
    "active PvP dummy should eventually produce incoming damage"
  );
}

function testMissedFreezeDoesNotApply() {
  const state = createPvpTestState();
  state.pendingHits.push({
    id: "missed-freeze-test",
    dueTick: 1,
    attackerId: state.blue.id,
    targetId: state.red.id,
    attackerPid: state.blue.pid,
    targetPid: state.red.pid,
    style: "magic",
    attackType: "accurate",
    landed: false,
    hitChance: 0,
    rawDamage: 0,
    freezeTicks: 20,
    createdTick: 0
  });
  state.humanControl = { attackEnabled: false, laneId: "middle", attackTargetId: state.red.id };
  advanceTick(state);
  advanceTick(state);
  equal(state.red.locks.freezeUntilTick, -1, "a missed ice spell must not freeze its target");
}

function testDragonClawsExposeRawDamageForImpactPrayer() {
  const result = rollDragonClawsSpecial({
    style: "slash",
    attackType: "aggressive",
    attackerLevels: { attack: 99, strength: 99, defence: 99, ranged: 99, magic: 99 },
    defenderLevels: { attack: 1, strength: 1, defence: 1, ranged: 1, magic: 1 },
    attackerBonuses: { ...zeroBonuses, slash_attack_bonus: 132, melee_strength_bonus: 114 },
    defenderBonuses: { ...zeroBonuses },
    defenderPrayers: ["protect_from_melee"],
    attackerIsPlayer: true,
    rng: () => 0
  });
  equal(result.rawDamages.length, 4, "Dragon claws should expose four raw impact values");
  equal(result.damages.reduce((sum, damage) => sum + damage, 0),
    result.rawDamages.reduce((sum, damage) => sum + Math.floor(damage * 0.6), 0),
    "launch-time prayer view should remain consistent with raw claws damage");
}


function testFoodBeforeReadyAttackDoesNotCreateCooldown() {
  const state = createPvpTestState();
  state.blue = {
    ...state.blue,
    attackTimer: { lastAttackTick: 0, weaponCooldownTicks: 0, additiveAttackDelayTicks: 0 }
  };
  state.players = state.players.map(player => player.id === state.blue.id ? state.blue : player);
  state.humanControl = {
    attackEnabled: false,
    laneId: "middle",
    attackTargetId: state.red.id,
    consumeItemId: "shark"
  };

  advanceTick(state);

  equal(state.blue.attackTimer.additiveAttackDelayTicks, 0,
    "eating while the attack cycle is ready must not create a new attack delay");
}

function testClientCommandQueueIsFifoAndCapped() {
  const first = makeStrongCommand({ kind: "equip", itemId: "abyssal_whip" }, 1, 0, 0);
  const weak = {
    kind: "special" as const,
    targetId: "red-dummy",
    priority: "weak" as const,
    id: "weak-2",
    sequence: 2,
    issuedTick: 0,
    executeTick: 0
  };
  const interrupted = enqueuePlayerCommand([first, weak], makeStrongCommand({ kind: "prayer", prayerId: "protect_from_melee" }, 3, 0, 0));
  ok(!interrupted.some(command => command.priority === "weak"), "a strong client command should interrupt stale weak queue entries");

  let queue = interrupted;
  for (let sequence = 4; sequence <= 15; sequence += 1) {
    queue = enqueuePlayerCommand(queue, makeStrongCommand({ kind: "special", targetId: "red-dummy" }, sequence, 0, 0));
  }
  const drained = drainPlayerCommands(queue, 0, 10);
  equal(drained.commands.length, 10, "client input should process at most ten queued commands per tick");
  equal(drained.queue.length, queue.length - 10, "commands beyond the client-input cap must remain queued");
  ok(
    drained.commands.every((command, index) => index === 0 || command.sequence > drained.commands[index - 1].sequence),
    "client input commands should preserve FIFO sequence"
  );
}

function testClientCommandHasOneTickInputLatency() {
  const state = createPvpTestState();
  ok(state.blue.equipment.weapon?.id === "rune_scimitar", "fixture should begin with rune scimitar equipped");
  queueClientCommand(state, { kind: "equip", itemId: "abyssal_whip" });

  advanceTick(state);
  equal(state.blue.equipment.weapon?.id, "rune_scimitar", "a command clicked during the current tick should not execute until the next server tick");

  advanceTick(state);
  equal(state.blue.equipment.weapon?.id, "abyssal_whip", "the queued client command should execute on the following server tick");
}

function testGraniteMaulSpecialIgnoresAttackCooldown() {
  const state = createPvpTestState();
  state.blue = {
    ...state.blue,
    tile: { x: 19, y: state.blue.tile.y },
    attackTimer: { lastAttackTick: 0, weaponCooldownTicks: 7, additiveAttackDelayTicks: 0 }
  };
  state.red = {
    ...state.red,
    tile: { x: 20, y: state.red.tile.y },
    activePrayers: []
  };
  state.players = state.players.map(player =>
    player.id === state.blue.id ? state.blue :
    player.id === state.red.id ? state.red : player
  );
  state.humanControl = {
    attackEnabled: true,
    laneId: "middle",
    attackTargetId: state.red.id,
    equipItemId: "granite_maul",
    useSpecial: true
  };

  advanceTick(state);

  equal(state.blue.equipment.weapon?.id, "granite_maul", "Granite maul should equip from the queued client input");
  equal(state.blue.specEnergy, 50, "one Granite maul special should consume 50% special energy");
  equal(state.blue.attackTimer.lastAttackTick, 0, "Granite maul special should not start the normal 7-tick attack cooldown");
  equal(state.blue.queuedSpecialAttacks, 0, "the instant Granite maul special should consume its queued special command");
  ok(
    state.pendingHits.some(hit => hit.attackerId === state.blue.id && hit.targetId === state.red.id),
    "Granite maul special should enqueue an impact for the target's PID turn"
  );
}

function testAuthoritativeStageOrder() {
  equal(
    tickRunner.stageNames.join(">"),
    "client-input>npc-turns>player-turns>pending-hits>lock-decay>respawns",
    "server tick should process client input before NPCs and PID-ordered players"
  );
}


function testFoodDelayExpiresAfterOneAttackCycle() {
  const state = createPvpTestState();
  state.blue = {
    ...state.blue,
    attackTimer: { lastAttackTick: 0, weaponCooldownTicks: 4, additiveAttackDelayTicks: 3 }
  };
  state.players = state.players.map(player => player.id === state.blue.id ? state.blue : player);
  state.humanControl = { attackEnabled: false, laneId: "middle", attackTargetId: state.red.id };
  for (let i = 0; i < 7; i += 1) advanceTick(state);
  equal(state.blue.attackTimer.additiveAttackDelayTicks, 0,
    "expired food delay must be consumed instead of persisting into future attack cycles");
}

function testNpcHitQueuesIntoPlayerTurn() {
  const state = createPvpTestState();
  state.blue = { ...state.blue, currentHp: 99, activePrayers: [] };
  state.players = state.players.map(player => player.id === state.blue.id ? state.blue : player);
  state.pendingHits.push({
    id: "npc-queue-test",
    dueTick: 0,
    attackerId: "tower-test",
    targetId: state.blue.id,
    attackerPid: -1,
    targetPid: state.blue.pid,
    style: "crush",
    attackType: "accurate",
    landed: true,
    hitChance: 1,
    rawDamage: 20,
    createdTick: 0
  });
  state.humanControl = { attackEnabled: false, laneId: "middle", attackTargetId: state.red.id };
  advanceTick(state);
  equal(state.blue.currentHp, 79, "queued NPC damage should resolve during the player's turn");
}

function testPlayerNpcImpactWaitsForNpcTurn() {
  // PVP fixtures have no towers, so use the prototype fixture for an actual NPC.
  const prototype = createPrototypeState();
  const targetTower = prototype.towers.find(candidate => candidate.team === "red" && candidate.laneId === "middle")!;
  prototype.pendingNpcHits.push({
    id: "player-npc-queue-test",
    dueTick: 0,
    attackerId: prototype.blue.id,
    targetId: targetTower.id,
    attackerPid: prototype.blue.pid,
    targetPid: -1,
    style: "slash",
    attackType: "aggressive",
    landed: true,
    hitChance: 1,
    rawDamage: 20,
    createdTick: 0
  });
  const before = targetTower.currentHp;
  advanceTick(prototype);
  equal(targetTower.currentHp, before - 20, "player->NPC queued damage should resolve on the NPC turn");
}

function testFoodAndPrayerCanPrecedeImpact() {
  const state = createPvpTestState();
  state.blue = { ...state.blue, currentHp: 60 };
  state.players = state.players.map(player => player.id === state.blue.id ? state.blue : player);
  state.pendingHits.push({
    id: "food-prayer-impact-test",
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
  state.humanControl = {
    attackEnabled: false,
    laneId: "middle",
    attackTargetId: state.red.id,
    consumeItemId: "shark"
  };
  advanceTick(state);
  const healed = state.blue.currentHp;
  state.humanControl.activatePrayer = "protect_from_missiles";
  advanceTick(state);
  equal(state.blue.currentHp, healed - 12, "impact should use the current protection prayer after the food tick");
  ok(state.blue.attackTimer.additiveAttackDelayTicks >= 3, "food should still delay the next attack cycle");
}

function testRedemptionSavesLethalHit() {
  const state = createPvpTestState();
  state.red = { ...state.red, equipment: { ...state.red.equipment, weapon: undefined } };
  state.players = state.players.map(player => player.id === state.red.id ? state.red : player);
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
testAuthoritativeStageOrder();
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
testClientCommandQueueIsFifoAndCapped();
testClientCommandHasOneTickInputLatency();
testGraniteMaulSpecialIgnoresAttackCooldown();
testPidTurnPreventsDeadPlayerAction();
testPidTurnRunsPrayerBeforeIncomingImpact();
testPvPDummyProvidesIncomingPressure();
testMissedFreezeDoesNotApply();
testDragonClawsExposeRawDamageForImpactPrayer();
testFoodAndPrayerCanPrecedeImpact();
testFoodDelayExpiresAfterOneAttackCycle();
testNpcHitQueuesIntoPlayerTurn();
testPlayerNpcImpactWaitsForNpcTurn();
testQueuedHitUsesImpactPrayer();
testRedemptionSavesLethalHit();
testCampRespawnSchedule();

console.log("All simulation tests passed.");
