import { createTickStageRunner, type TickStage } from "../engine/tick";
import { isFrozen, tickLocks } from "../entity/locks";
import { consumeExpiredAttackDelay, createAttackTimerState } from "../combat/timers";
import { dispatchAttack } from "../combat/attackGate";
import { rollAttack } from "../combat/resolve";
import { compatiblePrayerSet, type PrayerId } from "../prayer/prayers";
import type { PlayerEntity, MinionEntity, TowerEntity } from "./entities";
import { consumeItem, equipItem, equipmentBonuses, nextPid } from "./entities";
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

export const TICK_MS = 600;

export interface SimulationLogEntry {
  readonly tick: number;
  readonly message: string;
}

export interface SimulationState {
  tick: number;
  blue: PlayerEntity;
  red: PlayerEntity;
  minions: MinionEntity[];
  towers: TowerEntity[];
  engagedAttackerTeamByLane: Partial<Record<LaneId, "blue" | "red">>;
  log: SimulationLogEntry[];
  rng: () => number;
  humanControl?: {
    moveTargetX?: number;
    attackEnabled: boolean;
    activatePrayer?: PrayerId;
    laneId: LaneId;
    attackTargetId?: string;
  };
}

function log(state: SimulationState, message: string): void {
  state.log.push({ tick: state.tick, message });
  if (state.log.length > 250) state.log.splice(0, state.log.length - 250);
}

function opponentOf(state: SimulationState, id: string): PlayerEntity {
  return state.blue.id === id ? state.red : state.blue;
}

function setPlayer(state: SimulationState, player: PlayerEntity): void {
  if (state.blue.id === player.id) state.blue = player;
  else state.red = player;
}

function decisionFor(state: SimulationState, actor: PlayerEntity, enemy: PlayerEntity) {
  const ai = decideAction(actor, enemy, state.tick);
  if (actor.team !== "blue" || !state.humanControl) {
    return ai;
  }

  const targetX = state.humanControl.attackTargetId === enemy.id ? enemy.tile.x : state.humanControl.moveTargetX;
  const moveDelta = targetX === undefined || Math.abs(targetX - actor.tile.x) < 0.01
    ? 0
    : targetX > actor.tile.x ? 1 : -1;
  const attackStyle = state.humanControl.attackEnabled ? actor.equipment.weapon?.style : undefined;

  return {
    ...ai,
    moveDelta: moveDelta as -1 | 0 | 1,
    attackStyle,
    activatePrayer: state.humanControl.activatePrayer,
    eatItemId: undefined,
    useSpecial: false,
    investStat: undefined,
    buyItemId: undefined
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
    const actors = [state.blue, state.red].sort((a, b) => a.pid - b.pid);

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

      const nextTile: TilePosition = {
        x: Math.max(1, Math.min(39, current.tile.x + decision.moveDelta)),
        y: LANE_Y[laneFromPlayer(current)]
      };

      setPlayer(state, { ...current, tile: nextTile, zone: zoneAt(nextTile) });
    }
  }
};

// --- 2. Prayer changes ---
const prayerStage: TickStage<SimulationState> = {
  name: "prayers",
  run: state => {
    for (const actor of [state.blue, state.red]) {
      if (!actor.alive) continue;
      const enemy = opponentOf(state, actor.id);
      const decision = decisionFor(state, actor, enemy);
      const requested = decision.activatePrayer as PrayerId | undefined;
      const active = requested ? compatiblePrayerSet([...actor.activePrayers, requested]) : actor.activePrayers;
      const drain = active.length;
      const prayerPoints = Math.max(0, actor.prayerPoints - drain);
      setPlayer(state, {
        ...actor,
        activePrayers: prayerPoints > 0 ? [...active] : [],
        prayerPoints
      });
    }
  }
};

// --- 3. Player combat ---
const combatStage: TickStage<SimulationState> = {
  name: "combat",
  run: state => {
    const actors = [state.blue, state.red].sort((a, b) => a.pid - b.pid);

    for (const snapshot of actors) {
      const actor = snapshot.id === state.blue.id ? state.blue : state.red;
      if (!actor.alive || !actor.equipment.weapon) continue;

      const enemy = opponentOf(state, actor.id);
      if (!enemy.alive || !sameLane(actor, enemy)) continue;

      const decision = decisionFor(state, actor, enemy);
      if (!decision.attackStyle) continue;

      const lane = actor.laneId;
      const joinInput: JoinFightInput = {
        zone: actor.zone,
        currentAttackerTeam: state.engagedAttackerTeamByLane[lane],
        incomingTeam: actor.team,
        defenderLastCombatTick: enemy.lastCombatTick,
        currentTick: state.tick
      };
      if (!canJoinFight(joinInput)) continue;

      const weapon = actor.equipment.weapon;
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
          attackRange: weapon.attackRange ?? 1
        },
        extraAttackDelayUntilTick: actor.attackDelayUntilTick
      });

      if (!gateResult.gate.canAttack) {
        setPlayer(state, { ...actor, attackTimer: gateResult.attackTimer });
        continue;
      }

      const special = decision.useSpecial ? weapon.special : undefined;
      const hit = rollAttack({
        style: weapon.style ?? "slash",
        attackerLevels: toCombatLevels(actor.stats),
        defenderLevels: toCombatLevels(enemy.stats),
        attackerBonuses: equipmentBonuses(actor.equipment),
        defenderBonuses: equipmentBonuses(enemy.equipment),
        defenderPrayers: enemy.activePrayers,
        attackerIsPlayer: true,
        accuracyMultiplier: special?.accuracyMultiplier,
        damageMultiplier: special?.damageMultiplier,
        rng: state.rng
      });

      const attackerAfterAttack: PlayerEntity = {
        ...actor,
        attackTimer: gateResult.attackTimer,
        lastCombatTick: state.tick,
        specEnergy: special ? Math.max(0, actor.specEnergy - special.energyCost) : actor.specEnergy
      };
      setPlayer(state, attackerAfterAttack);

      const currentEnemy = opponentOf(state, actor.id);
      const newHp = Math.max(0, currentEnemy.currentHp - hit.finalDamage);
      const updatedEnemy: PlayerEntity = {
        ...currentEnemy,
        currentHp: newHp,
        lastCombatTick: state.tick,
        lastDamagedByPlayerId: actor.id
      };
      setPlayer(state, updatedEnemy);
      state.engagedAttackerTeamByLane[lane] = actor.team;

      log(
        state,
        hit.landed
          ? `${actor.id} hits ${currentEnemy.id} for ${hit.finalDamage} (${weapon.style}${special ? " SPEC" : ""})`
          : `${actor.id} misses ${currentEnemy.id} (${weapon.style}${special ? " SPEC" : ""})`
      );

      if (newHp <= 0) handlePlayerDeath(state, updatedEnemy, actor);
    }
  }
};

function handlePlayerDeath(state: SimulationState, victim: PlayerEntity, killer: PlayerEntity): void {
  const killerCurrent = state.blue.id === killer.id ? state.blue : state.red;
  const killerWithXp: PlayerEntity = {
    ...killerCurrent,
    stats: grantUnallocatedXp(killerCurrent.stats, xpRewards.playerKill),
    gp: killerCurrent.gp + gpRewards.playerKill,
    kills: killerCurrent.kills + 1
  };
  setPlayer(state, killerWithXp);
  respawnPlayer(state, victim);
  log(state, `${victim.id} was slain by ${killer.id}`);
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
    for (const actor of [state.blue, state.red]) {
      if (!actor.alive) continue;
      const enemy = opponentOf(state, actor.id);
      const decision = decisionFor(state, actor, enemy);
      let updated = actor;

      if (decision.eatItemId) {
        const item = findConsumable(decision.eatItemId);
        if (item && updated.gp >= item.cost) {
          updated = consumeItem(updated, item, state.tick);
          updated = { ...updated, attackDelayUntilTick: state.tick + item.attackDelayTicks };
        }
      }

      if (decision.investStat) {
        updated = { ...updated, stats: investXp(updated.stats, decision.investStat, updated.stats.unallocatedXp) };
      }

      if (decision.buyItemId && updated.zone === "base") {
        const item = shopCatalog.find(candidate => candidate.id === decision.buyItemId);
        if (item && updated.gp >= item.cost) {
          updated = equipItem(updated, item);
          log(state, `${updated.id} buys ${item.name}`);
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

      const target = [state.blue, state.red].find(player =>
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

      const enemyPlayers = [state.blue, state.red]
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
  const candidates = [state.blue, state.red]
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
    for (const actor of [state.blue, state.red]) {
      setPlayer(state, { ...actor, locks: tickLocks(actor.locks, state.tick) });
      const consumed = consumeExpiredAttackDelay(actor.attackTimer, state.tick);
      setPlayer(state, { ...actor, attackTimer: consumed.state });
    }
  }
};

// --- 8. Respawns ---
const respawnStage: TickStage<SimulationState> = {
  name: "respawns",
  run: state => {
    for (const actor of [state.blue, state.red]) {
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
  towerStage,
  minionStage,
  lockDecayStage,
  respawnStage
]);

export function advanceTick(state: SimulationState): void {
  tickRunner.run(state);
  state.tick += 1;
}

export { levelOf };
