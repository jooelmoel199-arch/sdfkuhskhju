import { createTickStageRunner, type TickStage } from "../engine/tick";
import { applyFreeze, isFrozen, tickLocks } from "../entity/locks";
import { consumeExpiredAttackDelay, createAttackTimerState, delayAttack } from "../combat/timers";
import { dispatchAttack } from "../combat/attackGate";
import { meleeHitTick, projectileHitTick, type PendingHit } from "../combat/pendingHits";
import { rollAttack, rollDragonClawsSpecial } from "../combat/resolve";
import { compatiblePrayerSet, aggregatePrayerBoosts, prayerDefinitions, applyProtectionDamageReduction, type PrayerId } from "../prayer/prayers";
import type { PlayerEntity, MinionEntity, TowerEntity, NeutralCampEntity, ProjectileEntity } from "./entities";
import { consumeItem, equipItem, equipOwnedItem, equipmentBonuses, nextPid, inventoryCount, addInventoryItem } from "./entities";
import { toCombatLevels, grantUnallocatedXp, investXp, maxHitpoints, levelOf } from "./stats";
import { gpRewards, xpRewards, shopCatalog } from "./economy";
import { decideAction, findConsumable } from "./ai";
import {
  zoneAt,
  BLUE_TOWER_X,
  RED_TOWER_X,
  BLUE_BASE_X,
  RED_BASE_X,
  LANE_Y,
  LANES,
  nearestLane,
  canJoinFight,
  type JoinFightInput
} from "./lane";
import type { LaneId } from "./lane";
import type { TilePosition } from "../world/movement";

const MINION_SPAWN_INTERVAL_TICKS = 15;
const MINIONS_PER_WAVE_PER_LANE = 3;
const MINION_MAX_HP = 15;
const MINION_MAX_HIT = 4;
const MINION_AGGRO_RANGE = 6;

let minionSeq = 0;
let projectileSeq = 0;

export const TICK_MS = 600;

export interface CombatEvent {
  readonly tick: number;
  readonly attackerId: string;
  readonly targetId: string;
  readonly style: "melee" | "ranged" | "magic";
  readonly damage: number;
  readonly landed: boolean;
  readonly special?: boolean;
  readonly freezeTicks?: number;
}

export interface SimulationLogEntry {
  readonly tick: number;
  readonly message: string;
}

export interface SimulationState {
  tick: number;
  blue: PlayerEntity;
  red: PlayerEntity;
  players: PlayerEntity[];
  minions: MinionEntity[];
  projectiles: ProjectileEntity[];
  pendingHits: PendingHit[];
  towers: TowerEntity[];
  pidOrder: string[];
  nextPidShuffleTick: number;
  jungleCamps: NeutralCampEntity[];
  engagedAttackerTeamByLane: Partial<Record<LaneId, "blue" | "red">>;
  teamBuffs: Partial<Record<"blue" | "red", { name: string; expiresAtTick: number; damageMultiplier: number }>>;
  matchResult?: "blue" | "red";
  readonly pvpTest?: boolean;
  combatEvents: CombatEvent[];
  log: SimulationLogEntry[];
  rng: () => number;
  humanControl?: {
    moveTargetX?: number;
    moveTargetY?: number;
    attackEnabled: boolean;
    activatePrayer?: PrayerId;
    laneId: LaneId;
    attackTargetId?: string;
    spellId?: "ice_rush" | "ice_burst" | "ice_blitz" | "ice_barrage";
    consumeItemId?: string;
    comboConsumableId?: string;
    equipItemId?: string;
investStat?: "attack" | "strength" | "defence" | "ranged" | "magic" | "hitpoints" | "prayer";
    buyItemId?: string;
    useSpecial?: boolean;
    buyConsumableId?: string;
    buyConsumableQuantity?: number;
  };
}

function spellProfile(id: "ice_rush" | "ice_burst" | "ice_blitz" | "ice_barrage" | undefined) {
  switch (id) {
    case "ice_rush": return { maxHit: 20, freezeTicks: 16, aoeRadius: 0 };
    case "ice_burst": return { maxHit: 22, freezeTicks: 20, aoeRadius: 1 };
    case "ice_blitz": return { maxHit: 26, freezeTicks: 26, aoeRadius: 1 };
    default: return { maxHit: 30, freezeTicks: 32, aoeRadius: 1 };
  }
}

function eventStyle(style: string): CombatEvent["style"] {
  if (style === "magic") return "magic";
  if (style === "ranged") return "ranged";
  return "melee";
}

function pushCombatEvent(state: SimulationState, event: CombatEvent): void {
  state.combatEvents.push(event);
  if (state.combatEvents.length > 80) state.combatEvents.splice(0, state.combatEvents.length - 80);
}

function playerPriority(state: SimulationState, playerId: string): number {
  const index = state.pidOrder.indexOf(playerId);
  return index < 0 ? 9999 : index;
}

function refreshPid(state: SimulationState): void {
  if (state.tick < state.nextPidShuffleTick) return;
  const order = [...state.pidOrder];
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = Math.floor(state.rng() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  state.pidOrder = order;
  state.nextPidShuffleTick = state.tick + 40 + Math.floor(state.rng() * 21);
  log(state, "PID order shuffled");
}

function log(state: SimulationState, message: string): void {
  state.log.push({ tick: state.tick, message });
  if (state.log.length > 250) state.log.splice(0, state.log.length - 250);
}

function opponentOf(state: SimulationState, id: string): PlayerEntity {
  const actor = state.players.find(player => player.id === id) ?? state.blue;
  const humanTargetId = actor.id === state.blue.id ? state.humanControl?.attackTargetId : undefined;
  const explicit = humanTargetId
    ? state.players.find(player => player.id === humanTargetId && player.alive && player.team !== actor.team)
    : undefined;
  if (explicit) return explicit;

  const enemies = state.players
    .filter(player => player.alive && player.team !== actor.team)
    .sort((a, b) => {
      const aSameLane = a.laneId === actor.laneId ? 0 : 1;
      const bSameLane = b.laneId === actor.laneId ? 0 : 1;
      if (aSameLane !== bSameLane) return aSameLane - bSameLane;
      return Math.hypot(a.tile.x - actor.tile.x, a.tile.y - actor.tile.y) -
        Math.hypot(b.tile.x - actor.tile.x, b.tile.y - actor.tile.y);
    });
  return enemies[0] ?? (actor.team === "blue" ? state.red : state.blue);
}

function effectiveWeaponCooldown(weapon: NonNullable<PlayerEntity["equipment"]["weapon"]>, attackType: PlayerEntity["attackType"]): number {
  const base = weapon.cooldownTicks ?? 4;
  return weapon.style === "ranged" && attackType === "rapid_ranged" ? Math.max(1, base - 1) : base;
}

function setPlayer(state: SimulationState, player: PlayerEntity): void {
  state.players = state.players.map(current => current.id === player.id ? player : current);
  if (state.blue.id === player.id) state.blue = player;
  if (state.red.id === player.id) state.red = player;
}

function decisionFor(state: SimulationState, actor: PlayerEntity, enemy: PlayerEntity) {
  const ai = decideAction(actor, enemy, state.tick);
  if (actor.id !== state.blue.id || !state.humanControl) return ai;

  let targetTile: TilePosition | undefined;
  if (state.humanControl.attackTargetId === enemy.id) {
    targetTile = enemy.tile;
  } else if (state.humanControl.attackTargetId) {
    targetTile = state.jungleCamps.find(camp => camp.id === state.humanControl?.attackTargetId)?.tile;
  }
  const targetX = targetTile?.x ?? state.humanControl.moveTargetX;
  const targetY = targetTile?.y ?? state.humanControl.moveTargetY;
  const moveDelta = targetX === undefined || Math.abs(targetX - actor.tile.x) < 0.01
    ? 0
    : targetX > actor.tile.x ? 1 : -1;
  const attackStyle = state.humanControl.attackEnabled ? actor.equipment.weapon?.style : undefined;

  return {
    ...ai,
    moveDelta: moveDelta as -1 | 0 | 1,
    attackStyle,
    attackType: actor.team === "blue" ? actor.attackType : ai.attackType,
    activatePrayer: state.humanControl.activatePrayer,
    eatItemId: state.humanControl.consumeItemId,
    useSpecial: Boolean(state.humanControl.useSpecial),
    investStat: state.humanControl.investStat,
    buyItemId: state.humanControl.buyItemId,
    buyConsumableId: state.humanControl.buyConsumableId,
    buyConsumableQuantity: state.humanControl.buyConsumableQuantity,
    equipItemId: state.humanControl.equipItemId
  };
}

function laneFromPlayer(player: PlayerEntity): LaneId {
  return player.laneId;
}

function sameLane(a: { laneId: LaneId }, b: { laneId: LaneId }): boolean {
  return a.laneId === b.laneId;
}

function clearLaneEngagementForPlayer(state: SimulationState, team: "blue" | "red"): void {
  for (const lane of LANES) {
    if (state.engagedAttackerTeamByLane[lane] === team) {
      delete state.engagedAttackerTeamByLane[lane];
    }
  }
}

// --- 0. Client input ---
// Inputs are applied before player movement/interaction, matching the server
// model used by OSRS: inventory/equipment commands can affect the same tick's
// player turn, while food delays the combat/skilling timer.
const clientInputStage: TickStage<SimulationState> = {
  name: "client-input",
  run: state => {
    if (!state.humanControl) return;
    const actor = state.players.find(player => player.id === state.blue.id);
    if (!actor || !actor.alive) return;

    if (state.humanControl.equipItemId) {
      const equipped = equipOwnedItem(actor, state.humanControl.equipItemId);
      if (equipped !== actor) {
        setPlayer(state, equipped);
      }
    }

    let current = state.players.find(player => player.id === actor.id) ?? actor;
    if (state.humanControl.consumeItemId) {
      current = applyConsumableAction(state, current, state.humanControl.consumeItemId);
      setPlayer(state, current);
    }
    if (state.humanControl.comboConsumableId) {
      current = applyConsumableAction(state, current, state.humanControl.comboConsumableId, true);
      setPlayer(state, current);
    }
  }
};

// --- 1. Target-turn queued-hit resolution ---
const queuedHitTurnStage: TickStage<SimulationState> = {
  name: "queued-hit-turns",
  run: state => {
    const actors = [...state.players]
      .sort((a, b) => playerPriority(state, a.id) - playerPriority(state, b.id));
    for (const actor of actors) {
      if (!actor.alive) continue;
      resolvePendingHitsForPlayer(state, actor.id);
    }
  }
};

// --- 2. Movement / target lane routing ---
const movementStage: TickStage<SimulationState> = {
  name: "movement",
  run: state => {
    refreshPid(state);
    const actors = [...state.players].sort((a, b) => playerPriority(state, a.id) - playerPriority(state, b.id));

    for (const actor of actors) {
      if (!actor.alive) continue;

      const enemy = opponentOf(state, actor.id);

      // The scripted red opponent rotates to whichever lane the human selects.
      if (actor.team === "red" && state.humanControl && enemy.laneId !== actor.laneId && !state.engagedAttackerTeamByLane[enemy.laneId]) {
        const rotated: PlayerEntity = {
          ...actor,
          laneId: enemy.laneId,
          tile: { x: actor.tile.x, y: LANE_Y[enemy.laneId] },
          zone: zoneAt({ x: actor.tile.x, y: LANE_Y[enemy.laneId] })
        };
        setPlayer(state, rotated);
      }

      const current = state.players.find(player => player.id === actor.id);
      if (!current) continue;
      const currentEnemy = opponentOf(state, current.id);
      const decision = decisionFor(state, current, currentEnemy);
      if (isFrozen(current.locks, state.tick) || decision.moveDelta === 0) continue;

      const x = Math.max(1, Math.min(39, current.tile.x + decision.moveDelta));
      let y = current.tile.y;

      if (current.team === "blue" && state.humanControl?.moveTargetY !== undefined) {
        const dy = state.humanControl.moveTargetY - current.tile.y;
        if (Math.abs(dy) > 0.01) {
          y += Math.sign(dy);
        }
      } else if (current.role !== "jungle") {
        y = LANE_Y[laneFromPlayer(current)];
      }

      const nextTile: TilePosition = { x, y };
      const nextZone = zoneAt(nextTile);
      const nextLaneId = nextZone === "lane" ? nearestLane(nextTile.y) : current.laneId;

      setPlayer(state, { ...current, tile: nextTile, laneId: nextLaneId, zone: nextZone });
    }
  }
};

// --- 2. Prayer changes ---
const prayerStage: TickStage<SimulationState> = {
  name: "prayers",
  run: state => {
    for (const actor of [...state.players]) {
      if (!actor.alive) continue;
      if (state.pvpTest && actor.team === "red") continue;
      const enemy = opponentOf(state, actor.id);
      const decision = decisionFor(state, actor, enemy);
      const requested = decision.activatePrayer as PrayerId | undefined;
      const toggled = requested && actor.activePrayers.includes(requested)
        ? actor.activePrayers.filter(prayer => prayer !== requested)
        : requested
          ? compatiblePrayerSet([...actor.activePrayers, requested])
          : actor.activePrayers;
      const active = toggled;
      const prayerBonus = equipmentBonuses(actor.equipment).prayer_bonus;
      // OSRS prayer drain is accumulated over discrete game ticks. This also
      // permits one-tick prayer flicking when the same overhead is toggled off
      // before another drain tick is accumulated.
      const drainEffect = active.reduce((sum, prayer) => sum + (prayerDefinitions[prayer]?.drain ?? 0), 0);
      const drainResistance = Math.max(60, 60 + 2 * prayerBonus);
      let drainAccumulator = actor.prayerDrainAccumulator + drainEffect;
      let prayerPoints = actor.prayerPoints;
      while (drainAccumulator >= drainResistance && prayerPoints > 0) {
        drainAccumulator -= drainResistance;
        prayerPoints -= 1;
      }
      setPlayer(state, {
        ...actor,
        activePrayers: prayerPoints > 0 ? [...active] : [],
        lastPrayerToggleTick: requested ? state.tick : actor.lastPrayerToggleTick,
        prayerPoints,
        prayerDrainAccumulator: prayerPoints > 0 ? drainAccumulator : 0
      });
    }
  }
};

// --- 3. Player combat ---
function resolvePendingHitsForPlayer(state: SimulationState, targetId: string): void {
  const ready = state.pendingHits.filter(hit => hit.targetId === targetId && hit.dueTick <= state.tick);
  if (ready.length === 0) return;
  state.pendingHits = state.pendingHits.filter(hit => !(hit.targetId === targetId && hit.dueTick <= state.tick));

  for (const hit of ready) {
    const target = state.players.find(player => player.id === hit.targetId);
    if (!target || !target.alive) continue;
    const attacker = state.players.find(player => player.id === hit.attackerId);

    if (!hit.landed) {
      setPlayer(state, { ...target, lastCombatTick: state.tick });
      pushCombatEvent(state, { tick: state.tick, attackerId: hit.attackerId, targetId: target.id,
        style: eventStyle(hit.style), damage: 0, landed: false });
      log(state, hit.attackerId + " misses " + target.id + " (" + hit.style + " " + hit.attackType + ")");
      continue;
    }

    const impactDamage = applyProtectionDamageReduction({
      damage: hit.rawDamage,
      attackStyle: hit.style,
      defenderPrayers: target.activePrayers,
      attackerIsPlayer: Boolean(attacker)
    });
    const newHp = Math.max(0, target.currentHp - impactDamage);
    let resolvedTarget: PlayerEntity = {
      ...target,
      currentHp: newHp,
      lastCombatTick: state.tick,
      lastDamagedByPlayerId: hit.attackerId
    };

    if (hit.freezeTicks) {
      resolvedTarget = {
        ...resolvedTarget,
        locks: applyFreeze(resolvedTarget.locks, state.tick, hit.freezeTicks, hit.attackerId)
      };
    }
    if (impactDamage > 0 && resolvedTarget.activePrayers.includes("smite")) {
      resolvedTarget = {
        ...resolvedTarget,
        prayerPoints: Math.max(0, resolvedTarget.prayerPoints - Math.floor(impactDamage * 0.25))
      };
    }
    if (newHp <= Math.floor(maxHitpoints(resolvedTarget.stats) * 0.1) &&
        resolvedTarget.activePrayers.includes("redemption") && resolvedTarget.prayerPoints > 0) {
      resolvedTarget = {
        ...resolvedTarget,
        currentHp: Math.max(newHp, Math.floor(maxHitpoints(resolvedTarget.stats) * 0.25)),
        prayerPoints: 0,
        activePrayers: [...compatiblePrayerSet(resolvedTarget.activePrayers.filter(prayer => prayer !== "redemption"))]
      };
      log(state, resolvedTarget.id + " triggers Redemption");
    }

    setPlayer(state, resolvedTarget);
    pushCombatEvent(state, { tick: state.tick, attackerId: hit.attackerId, targetId: target.id,
      style: eventStyle(hit.style), damage: impactDamage, landed: true, freezeTicks: hit.freezeTicks });
    log(state, hit.attackerId + " hits " + target.id + " for " + impactDamage +
      " (" + hit.style + " " + hit.attackType + ", tick " + hit.dueTick + ")");
    if (resolvedTarget.currentHp <= 0 && attacker) handlePlayerDeath(state, resolvedTarget, attacker);
  }
}

const combatStage: TickStage<SimulationState> = {
  name: "combat",
  run: state => {
    const actors = [...state.players].sort((a, b) => playerPriority(state, a.id) - playerPriority(state, b.id));

    for (const snapshot of actors) {
      const actor = state.players.find(player => player.id === snapshot.id);
      if (!actor) continue;
      if (!actor.alive || !actor.equipment.weapon) continue;
      if (state.pvpTest && actor.team === "red") continue;

      const enemy = opponentOf(state, actor.id);
      const decision = decisionFor(state, actor, enemy);

      if (!decision.attackStyle) continue;

      const targetCamp = actor.team === "blue" && state.humanControl?.attackTargetId
        ? state.jungleCamps.find(camp => camp.id === state.humanControl?.attackTargetId && camp.alive)
        : undefined;

      if (targetCamp) {
        handleCampAttack(state, actor, targetCamp, decision.attackType);
        continue;
      }

      const targetTower = actor.team === "blue" && state.humanControl?.attackTargetId
        ? state.towers.find(tower =>
            tower.id === state.humanControl?.attackTargetId &&
            tower.alive &&
            tower.team !== actor.team &&
            tower.laneId === actor.laneId
          )
        : undefined;
      if (targetTower) {
        handleTowerAttack(state, actor, targetTower, decision.attackType);
        continue;
      }

      if (!enemy.alive) continue;

      const lane = actor.laneId;
      const joinInput: JoinFightInput = {
        zone: actor.zone,
        currentAttackerTeam: state.engagedAttackerTeamByLane[lane],
        incomingTeam: actor.team,
        defenderLastCombatTick: enemy.lastCombatTick,
        currentTick: state.tick
      };
      if (!canJoinFight(joinInput)) continue;
      if (enemy.zone === "lane" && enemy.lastDamagedByPlayerId &&
          enemy.lastDamagedByPlayerId !== actor.id &&
          state.tick - enemy.lastCombatTick <= 8) {
        const previousAttacker = state.players.find(player => player.id === enemy.lastDamagedByPlayerId);
        if (previousAttacker?.alive && previousAttacker.team !== actor.team) continue;
      }

      const weapon = actor.equipment.weapon;
      const attackType = decision.attackType;
      const gateResult = dispatchAttack({
        currentTick: state.tick,
        attackerTile: actor.tile,
        defenderTile: enemy.tile,
        attackerFrozen: isFrozen(actor.locks, state.tick),
        locks: actor.locks,
        attackTimer: actor.attackTimer,
        weapon: {
          style: weapon.style ?? "slash",
          cooldownTicks: weapon.cooldownTicks ?? 4,
          attackRange: weapon.attackRange ?? 1,
          attackType
        },
        extraAttackDelayUntilTick: actor.attackDelayUntilTick
      });

      if (!gateResult.gate.canAttack) {
        setPlayer(state, { ...actor, attackTimer: gateResult.attackTimer });
        continue;
      }

      const special = decision.useSpecial ? weapon.special : undefined;
      const currentEnemy = opponentOf(state, actor.id);
      const prayerBoosts = aggregatePrayerBoosts(actor.activePrayers);
      const targetPrayerBoosts = aggregatePrayerBoosts(currentEnemy.activePrayers);
      const attackStyle = weapon.style ?? "slash";
      const relevantStatusBoost = actor.statusEffects
        .filter(effect => effect.style === attackStyle || (attackStyle !== "magic" && attackStyle !== "ranged" && effect.style === "slash"))
        .reduce((sum, effect) => sum + effect.amount, 0);
      const teamBuff = state.teamBuffs[actor.team];
      const teamBuffMultiplier = teamBuff && teamBuff.expiresAtTick > state.tick ? teamBuff.damageMultiplier : 1;
      const attackBoostMultiplier = (1 + (attackStyle === "magic" ? prayerBoosts.magic : attackStyle === "ranged" ? prayerBoosts.rangedAttack : prayerBoosts.attack) + relevantStatusBoost) * teamBuffMultiplier;
      const strengthBoostMultiplier = (1 + (attackStyle === "magic" ? 0 : attackStyle === "ranged" ? prayerBoosts.rangedStrength : prayerBoosts.strength) + relevantStatusBoost) * teamBuffMultiplier;
      const defenceBoostMultiplier = 1 + targetPrayerBoosts.defence;

      const attackerAfterAttack: PlayerEntity = {
        ...actor,
        attackType,
        attackTimer: gateResult.attackTimer,
        lastCombatTick: state.tick,
        specEnergy: special ? Math.max(0, actor.specEnergy - special.energyCost) : actor.specEnergy
      };
      setPlayer(state, attackerAfterAttack);
      state.engagedAttackerTeamByLane[actor.laneId] = actor.team;

      const hit = rollAttack({
        style: attackStyle,
        attackType,
        attackerLevels: toCombatLevels(actor.stats),
        defenderLevels: toCombatLevels(currentEnemy.stats),
        attackerBonuses: equipmentBonuses(actor.equipment),
        defenderBonuses: equipmentBonuses(currentEnemy.equipment),
        defenderPrayers: currentEnemy.activePrayers,
        attackerIsPlayer: true,
        attackBoostMultiplier,
        strengthBoostMultiplier,
        defenceBoostMultiplier,
        accuracyMultiplier: special?.accuracyMultiplier,
        damageMultiplier: special?.damageMultiplier,
        maxMagicDamage: attackStyle === "magic" ? spellProfile(state.humanControl?.spellId).maxHit : weapon.spell?.maxHit,
        rng: state.rng
      });

      const distance = Math.max(Math.abs(actor.tile.x - currentEnemy.tile.x), Math.abs(actor.tile.y - currentEnemy.tile.y));
      const hitTick = attackStyle === "ranged" || attackStyle === "magic"
        ? projectileHitTick(state.tick, attackStyle, distance, playerPriority(state, actor.id), playerPriority(state, currentEnemy.id))
        : meleeHitTick(state.tick, playerPriority(state, actor.id), playerPriority(state, currentEnemy.id));

      if (weapon.id === "dragon_claws" && special) {
        const claw = rollDragonClawsSpecial({
          style: "slash",
          attackType,
          attackerLevels: toCombatLevels(actor.stats),
          defenderLevels: toCombatLevels(currentEnemy.stats),
          attackerBonuses: equipmentBonuses(actor.equipment),
          defenderBonuses: equipmentBonuses(currentEnemy.equipment),
          defenderPrayers: currentEnemy.activePrayers,
          attackerIsPlayer: true,
          attackBoostMultiplier,
          strengthBoostMultiplier,
          defenceBoostMultiplier,
          rng: state.rng
        });
        const clawTick = meleeHitTick(state.tick, playerPriority(state, actor.id), playerPriority(state, currentEnemy.id));
        for (let strike = 0; strike < 4; strike += 1) {
          state.pendingHits.push({
            id: "claw-" + actor.id + "-" + state.tick + "-" + strike,
            dueTick: clawTick,
            attackerId: actor.id,
            targetId: currentEnemy.id,
            attackerPid: actor.pid,
            targetPid: currentEnemy.pid,
            style: "slash",
            attackType,
            landed: claw.landed,
            hitChance: 0,
            rawDamage: claw.damages[strike],
            createdTick: state.tick
          });
        }
        log(state, actor.id + " uses Dragon claws on " + currentEnemy.id + " (" + claw.damages.join("/") + ")");
      } else {
        state.pendingHits.push({
          id: "hit-" + actor.id + "-" + state.tick + "-" + (++projectileSeq),
          dueTick: hitTick,
          attackerId: actor.id,
          targetId: currentEnemy.id,
          attackerPid: actor.pid,
          targetPid: currentEnemy.pid,
          style: attackStyle,
          attackType,
          landed: hit.landed,
          hitChance: hit.hitChance,
          rawDamage: hit.rawDamage,
          freezeTicks: attackStyle === "magic" ? spellProfile(state.humanControl?.spellId).freezeTicks : undefined,
          createdTick: state.tick
        });
      }

      if (attackStyle === "magic" && spellProfile(state.humanControl?.spellId).aoeRadius && currentEnemy.zone !== "lane") {
        const secondaryTargets = state.players.filter(target =>
          target.alive &&
          target.team !== actor.team &&
          target.id !== currentEnemy.id &&
          Math.max(Math.abs(target.tile.x - currentEnemy.tile.x), Math.abs(target.tile.y - currentEnemy.tile.y)) <= spellProfile(state.humanControl?.spellId).aoeRadius
        );
        for (const secondary of secondaryTargets) {
          const secondaryPrayer = aggregatePrayerBoosts(secondary.activePrayers);
          const secondaryHit = rollAttack({
            style: attackStyle,
            attackType,
            attackerLevels: toCombatLevels(actor.stats),
            defenderLevels: toCombatLevels(secondary.stats),
            attackerBonuses: equipmentBonuses(actor.equipment),
            defenderBonuses: equipmentBonuses(secondary.equipment),
            defenderPrayers: secondary.activePrayers,
            attackerIsPlayer: true,
            attackBoostMultiplier,
            strengthBoostMultiplier,
            defenceBoostMultiplier: 1 + secondaryPrayer.defence,
            maxMagicDamage: spellProfile(state.humanControl?.spellId).maxHit,
            accuracyMultiplier: special?.accuracyMultiplier,
            damageMultiplier: special?.damageMultiplier,
            rng: state.rng
          });
          const secondaryDistance = Math.max(Math.abs(actor.tile.x - secondary.tile.x), Math.abs(actor.tile.y - secondary.tile.y));
          state.pendingHits.push({
            id: "hit-" + actor.id + "-" + state.tick + "-" + (++projectileSeq),
            dueTick: projectileHitTick(state.tick, "magic", secondaryDistance, playerPriority(state, actor.id), playerPriority(state, secondary.id)),
            attackerId: actor.id,
            targetId: secondary.id,
            attackerPid: actor.pid,
            targetPid: secondary.pid,
            style: "magic",
            attackType,
            landed: secondaryHit.landed,
            hitChance: secondaryHit.hitChance,
            rawDamage: secondaryHit.rawDamage,
            freezeTicks: spellProfile(state.humanControl?.spellId).freezeTicks,
            createdTick: state.tick
          });
        }
      }

      if (attackStyle === "ranged" || attackStyle === "magic") {
        state.projectiles.push({
          id: "projectile-" + projectileSeq,
          kind: "projectile",
          attackerId: actor.id,
          targetId: currentEnemy.id,
          style: attackStyle,
          attackType,
          attackerLevels: toCombatLevels(actor.stats),
          attackerBonuses: equipmentBonuses(actor.equipment),
          attackBoostMultiplier,
          strengthBoostMultiplier,
          damageMultiplier: special?.damageMultiplier ?? 1,
          accuracyMultiplier: special?.accuracyMultiplier ?? 1,
          createdTick: state.tick,
          hitTick,
          fromTile: actor.tile,
          toTile: currentEnemy.tile
        });
        log(state, actor.id + " fires " + attackStyle + " at " + currentEnemy.id + (special ? " (SPEC)" : ""));
      } else {
        log(state, actor.id + " queues " + attackStyle + " at " + currentEnemy.id +
          " for tick " + hitTick + (special ? " (SPEC)" : ""));
      }
    }
  }
};


const pendingHitStage: TickStage<SimulationState> = {
  name: "pending-hits",
  run: state => {
    // Player queues are resolved at the beginning of the target's PID turn.
    // This stage only removes stale projectile visuals.
    state.projectiles = state.projectiles.filter(projectile => projectile.hitTick > state.tick);
  }
};

function handleTowerAttack(
  state: SimulationState,
  actor: PlayerEntity,
  tower: SimulationState["towers"][number],
  attackType: PlayerEntity["attackType"]
): void {
  const weapon = actor.equipment.weapon;
  if (!weapon) return;

  const gateResult = dispatchAttack({
    currentTick: state.tick,
    attackerTile: actor.tile,
    defenderTile: tower.tile,
    attackerFrozen: isFrozen(actor.locks, state.tick),
    locks: actor.locks,
    attackTimer: actor.attackTimer,
    weapon: {
      style: weapon.style ?? "slash",
      cooldownTicks: weapon.cooldownTicks ?? 4,
      attackRange: weapon.attackRange ?? 1,
      attackType
    },
    extraAttackDelayUntilTick: actor.attackDelayUntilTick
  });
  if (!gateResult.gate.canAttack) {
    setPlayer(state, { ...actor, attackTimer: gateResult.attackTimer });
    return;
  }

  const style = weapon.style ?? "slash";
  const prayerBoosts = aggregatePrayerBoosts(actor.activePrayers);
  const attackBoostMultiplier =
    1 + (style === "magic" ? prayerBoosts.magic : style === "ranged" ? prayerBoosts.rangedAttack : prayerBoosts.attack);
  const strengthBoostMultiplier =
    1 + (style === "magic" ? 0 : style === "ranged" ? prayerBoosts.rangedStrength : prayerBoosts.strength);

  // Towers are MOBA structures rather than RuneScape NPCs. They use a fixed
  // defensive profile while player attack timing/damage remains the combat model.
  const towerLevels = { attack: 60, strength: 60, defence: 70, ranged: 60, magic: 60 };
  const hit = rollAttack({
    style,
    attackType,
    attackerLevels: toCombatLevels(actor.stats),
    defenderLevels: towerLevels,
    attackerBonuses: equipmentBonuses(actor.equipment),
    defenderBonuses: { ...equipmentBonuses(actor.equipment), slash_defence_bonus: 40, stab_defence_bonus: 40, crush_defence_bonus: 40 },
    defenderPrayers: [],
    attackerIsPlayer: true,
    attackBoostMultiplier,
    strengthBoostMultiplier,
    maxMagicDamage: weapon.spell?.maxHit,
    rng: state.rng
  });

  setPlayer(state, {
    ...actor,
    attackType,
    attackTimer: gateResult.attackTimer,
    lastCombatTick: state.tick
  });

  if (!hit.landed) {
    log(state, actor.id + " misses " + tower.id);
    return;
  }

  tower.currentHp = Math.max(0, tower.currentHp - hit.finalDamage);
  log(state, actor.id + " hits " + tower.id + " for " + hit.finalDamage);

  if (tower.currentHp <= 0) {
    tower.alive = false;
    log(state, tower.id + " falls");
    const enemyTeam = tower.team;
    const remaining = state.towers.some(other => other.alive && other.team === enemyTeam);
    if (!remaining) {
      state.matchResult = actor.team;
      log(state, actor.team + " wins the prototype match");
    }
  }
}

function applyConsumableAction(state: SimulationState, actor: PlayerEntity, itemId: string, combo = false): PlayerEntity {
  const item = findConsumable(itemId);
  if (!item || inventoryCount(actor, item.id) <= 0 || (!combo && state.tick < actor.eatDelayUntilTick) || (combo && !item.comboFood)) return actor;
  const updated = consumeItem(actor, item, state.tick);
  // OSRS food modifies the attack/skilling timer additively. A 3-tick food
  // adds three to a live positive cycle; it does not create a cooldown when idle.
  const currentRemaining = Math.max(0, actor.attackTimer.lastAttackTick +
    actor.attackTimer.weaponCooldownTicks + actor.attackTimer.additiveAttackDelayTicks - state.tick);
  const additive = item.attackDelayTicks;
  const next = {
    ...updated,
    attackTimer: delayAttack(actor.attackTimer, additive),
    attackDelayUntilTick: 0,
    eatDelayUntilTick: state.tick + item.eatDelayTicks
  };
  log(state, actor.id + " eats " + item.name + " (" + additive + "t food delay; " + currentRemaining + "t attack cycle remaining)");
  return next;
}

function handleCampAttack(state: SimulationState, actor: PlayerEntity, camp: NeutralCampEntity, attackType: PlayerEntity["attackType"]): void {
  const weapon = actor.equipment.weapon;
  if (!weapon) return;

  const gateResult = dispatchAttack({
    currentTick: state.tick,
    attackerTile: actor.tile,
    defenderTile: camp.tile,
    attackerFrozen: isFrozen(actor.locks, state.tick),
    locks: actor.locks,
    attackTimer: actor.attackTimer,
    weapon: {
      style: weapon.style ?? "slash",
      cooldownTicks: weapon.cooldownTicks ?? 4,
      attackRange: weapon.attackRange ?? 1
    },
    extraAttackDelayUntilTick: actor.attackDelayUntilTick
  });
  if (!gateResult.gate.canAttack) {
    setPlayer(state, { ...actor, attackTimer: gateResult.attackTimer });
    return;
  }

  const style = weapon.style ?? "slash";
  const prayerBoosts = aggregatePrayerBoosts(actor.activePrayers);
  const relevantStatusBoost = actor.statusEffects
    .filter(effect => effect.style === style || (style !== "magic" && style !== "ranged" && effect.style === "slash"))
    .reduce((sum, effect) => sum + effect.amount, 0);
  const attackBoostMultiplier = 1 + (style === "magic" ? prayerBoosts.magic : style === "ranged" ? prayerBoosts.rangedAttack : prayerBoosts.attack) + relevantStatusBoost;
  const strengthBoostMultiplier = 1 + (style === "magic" ? 0 : style === "ranged" ? prayerBoosts.rangedStrength : prayerBoosts.strength) + relevantStatusBoost;
  const special = actor.team === "blue" ? undefined : undefined;
  const hit = rollAttack({
    style,
    attackType,
    attackerLevels: toCombatLevels(actor.stats),
    defenderLevels: camp.combatLevels,
    attackerBonuses: equipmentBonuses(actor.equipment),
    defenderBonuses: camp.bonuses,
    defenderPrayers: [],
    attackerIsPlayer: true,
    attackBoostMultiplier,
    strengthBoostMultiplier,
    rng: state.rng
  });

  setPlayer(state, { ...actor, attackType, attackTimer: gateResult.attackTimer, lastCombatTick: state.tick });
  const index = state.jungleCamps.findIndex(candidate => candidate.id === camp.id);
  if (index < 0) return;
  const currentCamp = state.jungleCamps[index];
  const newHp = Math.max(0, currentCamp.currentHp - hit.finalDamage);
  if (newHp <= 0) {
    state.jungleCamps[index] = {
      ...currentCamp,
      currentHp: 0,
      alive: false,
      aggroTargetId: undefined,
      respawnAtTick: state.tick + currentCamp.respawnTicks
    };
    const rewardPlayer = state.blue.id === actor.id ? state.blue : state.red;
    setPlayer(state, {
      ...rewardPlayer,
      gp: rewardPlayer.gp + currentCamp.rewardGp,
      stats: grantUnallocatedXp(rewardPlayer.stats, currentCamp.rewardXp)
    });
    if (currentCamp.id === "river-chaos-elemental") {
      state.teamBuffs[actor.team] = {
        name: "Elemental surge",
        expiresAtTick: state.tick + 100,
        damageMultiplier: 1.10
      };
      log(state, actor.team + " gains Elemental surge for 60s");
    }
    log(state, actor.id + " clears " + currentCamp.name + " for " + currentCamp.rewardGp + " GP");
  } else {
    state.jungleCamps[index] = { ...currentCamp, currentHp: newHp, aggroTargetId: actor.id };
    log(state, hit.landed
      ? actor.id + " hits " + currentCamp.name + " for " + hit.finalDamage
      : actor.id + " misses " + currentCamp.name);
  }
};
function handlePlayerDeath(state: SimulationState, victim: PlayerEntity, killer: PlayerEntity): void {
  const killerCurrent = state.players.find(player => player.id === killer.id);
  if (killerCurrent) {
    const killerWithXp: PlayerEntity = {
      ...killerCurrent,
      stats: grantUnallocatedXp(killerCurrent.stats, xpRewards.playerKill),
      gp: killerCurrent.gp + gpRewards.playerKill,
      kills: killerCurrent.kills + 1
    };
    setPlayer(state, killerWithXp);
  }

  if (victim.activePrayers.includes("retribution") && killerCurrent) {
    const distance = Math.max(
      Math.abs(victim.tile.x - killerCurrent.tile.x),
      Math.abs(victim.tile.y - killerCurrent.tile.y)
    );
    if (distance <= 15) {
      const retaliation = Math.floor(maxHitpoints(victim.stats) * 0.1);
      setPlayer(state, {
        ...killerCurrent,
        currentHp: Math.max(0, killerCurrent.currentHp - retaliation)
      });
      log(state, victim.id + " triggers Retribution for " + retaliation);
    }
  }

  respawnPlayer(state, victim);
  log(state, victim.id + " was slain by " + killer.id);
}

function handleEnvironmentalDeath(state: SimulationState, victim: PlayerEntity, sourceLabel: string): void {
  respawnPlayer(state, victim);
  log(state, `${victim.id} was slain by ${sourceLabel}`);
}

function respawnPlayer(state: SimulationState, victim: PlayerEntity): void {
  const respawnTile: TilePosition = {
    x: victim.team === "blue" ? BLUE_BASE_X : RED_BASE_X,
    y: LANE_Y[victim.laneId]
  };

  clearLaneEngagementForPlayer(state, victim.team);

  setPlayer(state, {
    ...victim,
    alive: false,
    respawnAtTick: state.tick + 15,
    currentHp: 0,
    tile: respawnTile,
    zone: "base",
    deaths: victim.deaths + 1
  });
}

// --- 4. Effects / economy ---
const effectsStage: TickStage<SimulationState> = {
  name: "effects",
  run: state => {
    for (const actor of [...state.players]) {
      if (!actor.alive) continue;
      const enemy = opponentOf(state, actor.id);
      const decision = decisionFor(state, actor, enemy);
      let updated = actor;

      // Equipment and food are consumed by the combat stage so each human input
      // has one authoritative tick and cannot be applied twice in one frame.

      if (decision.investStat) {
        updated = { ...updated, stats: investXp(updated.stats, decision.investStat, updated.stats.unallocatedXp) };
      }

      if (decision.buyItemId && updated.zone === "base") {
        const item = shopCatalog.find(candidate => candidate.id === decision.buyItemId);
        if (item && updated.gp >= item.cost) {
          const displaced = updated.equipment[item.slot];
          const displacedShield = item.twoHanded ? updated.equipment.shield : undefined;
          updated = equipItem(updated, item);
          updated = addInventoryItem(updated, item.id, 1);
          if (displaced) updated = addInventoryItem(updated, displaced.id, 1);
          if (displacedShield) updated = addInventoryItem(updated, displacedShield.id, 1);
          log(state, updated.id + " buys " + item.name);
        }
      }

      if (decision.buyConsumableId && updated.zone === "base") {
        const item = findConsumable(decision.buyConsumableId);
        const quantity = Math.max(1, Math.trunc(decision.buyConsumableQuantity ?? 1));
        const totalCost = item ? item.cost * quantity : Infinity;
        if (item && updated.gp >= totalCost) {
          updated = addInventoryItem(updated, item.id, quantity);
          updated = { ...updated, gp: updated.gp - totalCost };
          log(state, `${updated.id} buys ${quantity}x ${item.name}`);
        }
      }
      updated = {
        ...updated,
        statusEffects: updated.statusEffects.filter(effect => effect.expiresAtTick > state.tick),
        specEnergy: Math.min(100, updated.specEnergy + 0.1),
        gp: updated.gp + gpRewards.passivePerTick
      };
      setPlayer(state, updated);
    }
  }
};

// --- 5. Six lane towers ---
const towerStage: TickStage<SimulationState> = {
  name: "towers",
  run: state => {
    for (const tower of state.towers) {
      if (!tower.alive || !canAttackTimer(tower.attackTimer, state.tick)) continue;

      const enemyMinions = state.minions
        .filter(minion => minion.alive && minion.team !== tower.team && minion.laneId === tower.laneId &&
          Math.abs(minion.tile.x - tower.tile.x) <= tower.attackRange)
        .sort((a, b) => Math.abs(a.tile.x - tower.tile.x) - Math.abs(b.tile.x - tower.tile.x));

      const minion = enemyMinions[0];
      if (minion) {
        tower.attackTimer = { ...tower.attackTimer, lastAttackTick: state.tick, weaponCooldownTicks: 5 };
        const damage = Math.floor(state.rng() * (tower.maxHit + 1));
        minion.currentHp = Math.max(0, minion.currentHp - damage);
        if (minion.currentHp <= 0) {
          minion.alive = false;
          log(state, `${tower.id} destroys ${minion.id}`);
        }
        continue;
      }

      const target = state.players.find(player =>
        player.alive && player.team !== tower.team && player.laneId === tower.laneId &&
        Math.abs(player.tile.x - tower.tile.x) <= tower.attackRange
      );
      if (!target) continue;

      tower.attackTimer = { ...tower.attackTimer, lastAttackTick: state.tick, weaponCooldownTicks: 5 };
      const damage = Math.floor(state.rng() * (tower.maxHit + 1));
      const newHp = Math.max(0, target.currentHp - damage);
      setPlayer(state, {
        ...target,
        currentHp: newHp,
        lastCombatTick: state.tick,
        lastDamagedByPlayerId: tower.id
      });
      log(state, `${tower.id} hits ${target.id} for ${damage}`);
      if (newHp <= 0) handleEnvironmentalDeath(state, { ...target, currentHp: 0 }, tower.id);
    }
  }
};

function canAttackTimer(timer: { lastAttackTick: number; weaponCooldownTicks: number }, tick: number): boolean {
  return tick - timer.lastAttackTick >= timer.weaponCooldownTicks;
}

// --- 6. Minion waves in all lanes ---
const minionStage: TickStage<SimulationState> = {
  name: "minions",
  run: state => {
    if (state.tick > 0 && state.tick % MINION_SPAWN_INTERVAL_TICKS === 0) {
      for (const lane of LANES) {
        for (let index = 0; index < MINIONS_PER_WAVE_PER_LANE; index += 1) {
          for (const team of ["blue", "red"] as const) {
            minionSeq += 1;
            const x = team === "blue"
              ? BLUE_BASE_X + 2 - index
              : RED_BASE_X - 2 + index;
            state.minions.push({
              id: `minion-${team}-${lane}-${minionSeq}`,
              kind: "minion",
              team,
              laneId: lane,
              pid: nextPid(),
              tile: { x, y: LANE_Y[lane] },
              currentHp: MINION_MAX_HP,
              maxHp: MINION_MAX_HP,
              attackBonus: 20,
              maxHit: MINION_MAX_HIT,
              style: "crush",
              attackTimer: createAttackTimerState(),
              alive: true
            });
          }
        }
      }
    }

    const alive = state.minions.filter(minion => minion.alive);
    const sorted = [...alive].sort((a, b) => a.pid - b.pid);

    for (const minion of sorted) {
      const enemyMinions = alive
        .filter(other => other.alive && other.team !== minion.team && other.laneId === minion.laneId)
        .map(other => ({ other, dist: Math.abs(other.tile.x - minion.tile.x) }))
        .sort((a, b) => a.dist - b.dist);
      const nearestMinion = enemyMinions[0];

      const enemyPlayers = state.players
        .filter(player => player.alive && player.team !== minion.team && player.laneId === minion.laneId)
        .map(player => ({ player, dist: Math.abs(player.tile.x - minion.tile.x) }))
        .sort((a, b) => a.dist - b.dist);
      const nearestPlayer = enemyPlayers[0];

      const enemyTower = state.towers.find(tower =>
        tower.alive && tower.team !== minion.team && tower.laneId === minion.laneId
      );
      const towerDist = enemyTower ? Math.abs(enemyTower.tile.x - minion.tile.x) : Infinity;

      type MinionTarget =
        | { kind: "minion"; entity: MinionEntity; dist: number }
        | { kind: "player"; entity: PlayerEntity; dist: number }
        | { kind: "tower"; entity: TowerEntity; dist: number };

      let target: MinionTarget | undefined;
      if (nearestMinion && nearestMinion.dist <= MINION_AGGRO_RANGE) {
        target = { kind: "minion", entity: nearestMinion.other, dist: nearestMinion.dist };
      } else if (nearestPlayer && nearestPlayer.dist <= MINION_AGGRO_RANGE) {
        target = { kind: "player", entity: nearestPlayer.player, dist: nearestPlayer.dist };
      } else if (enemyTower && towerDist <= MINION_AGGRO_RANGE) {
        target = { kind: "tower", entity: enemyTower, dist: towerDist };
      }

      if (target && target.dist <= 1) {
        if (canAttackTimer(minion.attackTimer, state.tick)) {
          minion.attackTimer = {
            ...minion.attackTimer,
            lastAttackTick: state.tick,
            weaponCooldownTicks: 4
          };
          const damage = Math.floor(state.rng() * (minion.maxHit + 1));

          if (target.kind === "player") {
            const currentTarget = target.entity.id === state.blue.id ? state.blue : state.red;
            const newHp = Math.max(0, currentTarget.currentHp - damage);
            setPlayer(state, {
              ...currentTarget,
              currentHp: newHp,
              lastCombatTick: state.tick,
              lastDamagedByPlayerId: minion.id
            });
            log(state, `${minion.id} hits ${currentTarget.id} for ${damage}`);
            if (newHp <= 0) handleEnvironmentalDeath(state, { ...currentTarget, currentHp: 0 }, minion.id);
          } else {
            target.entity.currentHp = Math.max(0, target.entity.currentHp - damage);
            if (target.entity.currentHp <= 0) {
              target.entity.alive = false;
              log(state, `${minion.id} destroys ${target.entity.id}`);
              if (target.kind === "minion") rewardNearestPlayer(state, minion);
            }
          }
        }
      } else {
        const direction = minion.team === "blue" ? 1 : -1;
        minion.tile = { ...minion.tile, x: Math.max(1, Math.min(39, minion.tile.x + direction)) };
      }
    }

    state.minions = state.minions.filter(minion => minion.alive);
  }
};


function rewardNearestPlayer(state: SimulationState, killerMinion: MinionEntity): void {
  const candidates = state.players
    .filter(player => player.alive && player.team === killerMinion.team && player.laneId === killerMinion.laneId)
    .sort((a, b) => Math.abs(a.tile.x - killerMinion.tile.x) - Math.abs(b.tile.x - killerMinion.tile.x));
  const nearest = candidates[0];
  if (!nearest || Math.abs(nearest.tile.x - killerMinion.tile.x) > MINION_AGGRO_RANGE) return;

  setPlayer(state, {
    ...nearest,
    gp: nearest.gp + gpRewards.minionKill,
    stats: grantUnallocatedXp(nearest.stats, xpRewards.minionKill)
  });
}

// --- 7. Lock decay ---
const lockDecayStage: TickStage<SimulationState> = {
  name: "lock-decay",
  run: state => {
    for (const actor of [...state.players]) {
      const locks = tickLocks(actor.locks, state.tick);
      const consumed = consumeExpiredAttackDelay(actor.attackTimer, state.tick);
      setPlayer(state, { ...actor, locks, attackTimer: consumed.state });
    }
  }
};


// --- 8. Neutral jungle camp AI and respawns ---
const jungleStage: TickStage<SimulationState> = {
  name: "jungle",
  run: state => {
    for (let index = 0; index < state.jungleCamps.length; index += 1) {
      const camp = state.jungleCamps[index];

      if (!camp.alive) {
        if (camp.respawnAtTick !== undefined && state.tick >= camp.respawnAtTick) {
          state.jungleCamps[index] = { ...camp, currentHp: camp.maxHp, alive: true, attackTimer: createAttackTimerState(), respawnAtTick: undefined, aggroTargetId: undefined };
          log(state, camp.name + " respawns");
        }
        continue;
      }

      let target = camp.aggroTargetId
        ? state.players.find(player => player.id === camp.aggroTargetId && player.alive)
        : undefined;

      if (!target) {
        target = state.players
          .filter(player => player.alive && Math.hypot(player.tile.x - camp.tile.x, player.tile.y - camp.tile.y) <= camp.attackRange + 2)
          .sort((a, b) =>
            Math.hypot(a.tile.x - camp.tile.x, a.tile.y - camp.tile.y) -
            Math.hypot(b.tile.x - camp.tile.x, b.tile.y - camp.tile.y)
          )[0];
      }

      if (!target) continue;
      const distance = Math.hypot(target.tile.x - camp.tile.x, target.tile.y - camp.tile.y);
      if (distance > camp.attackRange || !canAttackTimer(camp.attackTimer, state.tick)) continue;

      const hit = rollAttack({
        style: camp.style,
        attackType: "accurate",
        attackerLevels: camp.combatLevels,
        defenderLevels: toCombatLevels(target.stats),
        attackerBonuses: camp.bonuses,
        defenderBonuses: equipmentBonuses(target.equipment),
        defenderPrayers: target.activePrayers,
        attackerIsPlayer: false,
        rng: state.rng
      });

      state.jungleCamps[index] = { ...camp, attackTimer: { ...camp.attackTimer, lastAttackTick: state.tick, weaponCooldownTicks: 5 }, aggroTargetId: target.id };
      const newHp = Math.max(0, target.currentHp - hit.finalDamage);
      setPlayer(state, { ...target, currentHp: newHp, lastCombatTick: state.tick, lastDamagedByPlayerId: camp.id });
      log(state, hit.landed ? camp.name + " hits " + target.id + " for " + hit.finalDamage : camp.name + " misses " + target.id);
      if (newHp <= 0) handleEnvironmentalDeath(state, { ...target, currentHp: 0 }, camp.name);
    }
  }
};
// --- 9. Respawns ---
const respawnStage: TickStage<SimulationState> = {
  name: "respawns",
  run: state => {
    for (const actor of [...state.players]) {
      if (actor.alive || actor.respawnAtTick === undefined || state.tick < actor.respawnAtTick) continue;
      const tile = { x: actor.team === "blue" ? BLUE_BASE_X : RED_BASE_X, y: LANE_Y[actor.laneId] };
      setPlayer(state, {
        ...actor,
        alive: true,
        currentHp: maxHitpoints(actor.stats),
        respawnAtTick: undefined,
        tile,
        zone: "base"
      });
      log(state, `${actor.id} respawns in ${actor.laneId} lane`);
    }
  }
};

export const tickRunner = createTickStageRunner<SimulationState>([
  clientInputStage,
  prayerStage,
  queuedHitTurnStage,
  movementStage,
  combatStage,
  effectsStage,
  pendingHitStage,
  towerStage,
  minionStage,
  jungleStage,
  lockDecayStage,
  respawnStage
]);

export function advanceTick(state: SimulationState): void {
  if (state.matchResult) return;
  tickRunner.run(state);
  if (state.humanControl) {
    delete state.humanControl.activatePrayer;
    delete state.humanControl.consumeItemId;
    delete state.humanControl.comboConsumableId;
    delete state.humanControl.equipItemId;
    delete state.humanControl.investStat;
    delete state.humanControl.buyItemId;
    delete state.humanControl.useSpecial;
    delete state.humanControl.buyConsumableId;
    delete state.humanControl.buyConsumableQuantity;
  }
  state.tick += 1;
}

export { levelOf };
