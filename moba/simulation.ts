import { createTickStageRunner, type TickStage } from "../engine/tick";
import { applyFreeze, isFrozen, tickLocks } from "../entity/locks";
import { consumeExpiredAttackDelay, createAttackTimerState } from "../combat/timers";
import { dispatchAttack } from "../combat/attackGate";
import { meleeHitTick, projectileHitTick, type PendingHit } from "../combat/pendingHits";
import { rollAttack, rollDragonClawsSpecial } from "../combat/resolve";
import { compatiblePrayerSet, aggregatePrayerBoosts, prayerDefinitions, type PrayerId } from "../prayer/prayers";
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
  towers: TowerEntity[];
  jungleCamps: NeutralCampEntity[];
  engagedAttackerTeamByLane: Partial<Record<LaneId, "blue" | "red">>;
  teamBuffs: Partial<Record<"blue" | "red", { name: string; expiresAtTick: number; damageMultiplier: number }>>;
  log: SimulationLogEntry[];
  rng: () => number;
  humanControl?: {
    moveTargetX?: number;
    moveTargetY?: number;
    attackEnabled: boolean;
    activatePrayer?: PrayerId;
    laneId: LaneId;
    attackTargetId?: string;
    consumeItemId?: string;
    equipItemId?: string;
    investStat?: "attack" | "strength" | "defence" | "ranged" | "magic" | "hitpoints";
    buyItemId?: string;
    useSpecial?: boolean;
    buyConsumableId?: string;
    buyConsumableQuantity?: number;
  };
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

// --- 1. Movement / target lane routing ---
const movementStage: TickStage<SimulationState> = {
  name: "movement",
  run: state => {
    refreshPid(state);\n    const actors = [...state.players].sort((a, b) => playerPriority(state, a.id) - playerPriority(state, b.id));

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

      const current = actor.team === "red" ? state.red : state.blue;
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
      const enemy = opponentOf(state, actor.id);
      const decision = decisionFor(state, actor, enemy);
      const requested = decision.activatePrayer as PrayerId | undefined;
      const active = requested ? compatiblePrayerSet([...actor.activePrayers, requested]) : actor.activePrayers;
      const prayerBonus = equipmentBonuses(actor.equipment).prayer_bonus;
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
        prayerPoints,
        prayerDrainAccumulator: prayerPoints > 0 ? drainAccumulator : 0
      });
    }
  }
};

// --- 3. Player combat ---
const combatStage: TickStage<SimulationState> = {
  name: "combat",
  run: state => {
    const actors = [...state.players].sort((a, b) => playerPriority(state, a.id) - playerPriority(state, b.id));

    for (const snapshot of actors) {
      const actor = state.players.find(player => player.id === snapshot.id);
      if (!actor) continue;
      if (!actor.alive || !actor.equipment.weapon) continue;

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
        maxMagicDamage: weapon.spell?.maxHit,
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
          rawDamage: hit.finalDamage,
          freezeTicks: attackStyle === "magic" ? weapon.spell?.freezeTicks : undefined,
          createdTick: state.tick
        });
      }

      if (attackStyle === "magic" && weapon.spell?.aoeRadius && currentEnemy.zone !== "lane") {
        const secondaryTargets = state.players.filter(target =>
          target.alive &&
          target.team !== actor.team &&
          target.id !== currentEnemy.id &&
          Math.max(Math.abs(target.tile.x - currentEnemy.tile.x), Math.abs(target.tile.y - currentEnemy.tile.y)) <= weapon.spell!.aoeRadius
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
            maxMagicDamage: weapon.spell.maxHit,
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
            rawDamage: secondaryHit.finalDamage,
            freezeTicks: weapon.spell.freezeTicks,
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
    const pending: PendingHit[] = [];
    for (const hit of state.pendingHits) {
      if (hit.dueTick > state.tick) {
        pending.push(hit);
        continue;
      }
      const target = state.players.find(player => player.id === hit.targetId);
      if (!target || !target.alive) continue;
      const attacker = state.players.find(player => player.id === hit.attackerId);
      if (hit.landed) {
        const newHp = Math.max(0, target.currentHp - hit.rawDamage);
        let updatedTarget: PlayerEntity = {
          ...target,
          currentHp: newHp,
          lastCombatTick: state.tick,
          lastDamagedByPlayerId: hit.attackerId
        };
        if (hit.freezeTicks) {
          updatedTarget = {
            ...updatedTarget,
            locks: applyFreeze(updatedTarget.locks, state.tick, hit.freezeTicks, hit.attackerId)
          };
        }
        let resolvedTarget = updatedTarget;
        if (hit.landed && hit.rawDamage > 0 && resolvedTarget.activePrayers.includes("smite")) {
          resolvedTarget = {
            ...resolvedTarget,
            prayerPoints: Math.max(0, resolvedTarget.prayerPoints - Math.floor(hit.rawDamage * 0.25))
          };
        }
        if (newHp > 0 && newHp <= Math.floor(maxHitpoints(resolvedTarget.stats) * 0.1) &&
            resolvedTarget.activePrayers.includes("redemption") && resolvedTarget.prayerPoints > 0) {
          resolvedTarget = {
            ...resolvedTarget,
            currentHp: Math.max(newHp, Math.floor(maxHitpoints(resolvedTarget.stats) * 0.25)),
            prayerPoints: 0,
            activePrayers: compatiblePrayerSet(resolvedTarget.activePrayers.filter(prayer => prayer !== "redemption"))
          };
          log(state, resolvedTarget.id + " triggers Redemption");
        }
        setPlayer(state, resolvedTarget);
        log(state, hit.attackerId + " hits " + target.id + " for " + hit.rawDamage +
          " (" + hit.style + " " + hit.attackType + ", tick " + hit.dueTick + ")");
        if (newHp <= 0 && attacker) handlePlayerDeath(state, resolvedTarget, attacker);
      } else {
        setPlayer(state, { ...target, lastCombatTick: state.tick });
        log(state, hit.attackerId + " misses " + target.id + " (" + hit.style + ")");
      }
    }
    state.pendingHits = pending;
    state.projectiles = state.projectiles.filter(projectile => projectile.hitTick > state.tick);
  }
};

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

      if (decision.equipItemId) {
        updated = equipOwnedItem(updated, decision.equipItemId);
      }

      if (decision.eatItemId) {
        const item = findConsumable(decision.eatItemId);
        if (item && inventoryCount(updated, item.id) > 0 && state.tick >= updated.eatDelayUntilTick) {
          const weaponReadyTick = updated.attackTimer.lastAttackTick + updated.attackTimer.weaponCooldownTicks + updated.attackTimer.additiveAttackDelayTicks;
          const remainingAttackDelay = Math.max(0, weaponReadyTick - state.tick);
          const actionDelay = remainingAttackDelay > 0 ? remainingAttackDelay + item.attackDelayTicks : 0;
          updated = consumeItem(updated, item, state.tick);
          updated = {
            ...updated,
            attackDelayUntilTick: Math.max(updated.attackDelayUntilTick, state.tick + actionDelay),
            eatDelayUntilTick: state.tick + 3
          };
        }
      }

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
  movementStage,
  prayerStage,
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
  tickRunner.run(state);
  if (state.humanControl) {
    delete state.humanControl.consumeItemId;
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
