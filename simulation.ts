import { createTickStageRunner, type TickStage } from "../engine/tick";
import { applyFreeze, isFrozen, tickLocks } from "../entity/locks";
import { consumeExpiredAttackDelay, createAttackTimerState } from "../combat/timers";
import { attackGate, dispatchAttack } from "../combat/attackGate";
import { rollAttack } from "../combat/resolve";
import { compatiblePrayerSet, type PrayerId } from "../prayer/prayers";
import type { PlayerEntity, MinionEntity, TowerEntity } from "./entities";
import { consumeItem, equipItem, equipmentBonuses, nextPid } from "./entities";
import { toCombatLevels, grantUnallocatedXp, investXp, maxHitpoints, levelOf } from "./stats";
import { gpRewards, xpRewards, shopCatalog } from "./economy";
import { decideAction, findConsumable } from "./ai";
import { zoneAt, BLUE_TOWER_X, RED_TOWER_X, BLUE_BASE_X, RED_BASE_X, canJoinFight, type JoinFightInput } from "./lane";
import type { TilePosition } from "../world/movement";

const MINION_SPAWN_INTERVAL_TICKS = 15; // ~9s per wave
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
  towers: [TowerEntity, TowerEntity];
  engagedAttackerTeam?: "blue" | "red"; // whoever currently "owns" the active singles fight
  log: SimulationLogEntry[];
  rng: () => number;
}

function log(state: SimulationState, message: string): void {
  state.log.push({ tick: state.tick, message });
}

function opponentOf(state: SimulationState, id: string): PlayerEntity {
  return state.blue.id === id ? state.red : state.blue;
}

function setPlayer(state: SimulationState, player: PlayerEntity): void {
  if (state.blue.id === player.id) {
    state.blue = player;
  } else {
    state.red = player;
  }
}

// --- Stage 1: decide + apply movement (PID order matters: an earlier freeze can cancel a later move) ---
const movementStage: TickStage<SimulationState> = {
  name: "movement",
  run: (state) => {
    const actors = [state.blue, state.red].sort((a, b) => a.pid - b.pid);
    for (const actor of actors) {
      if (!actor.alive) continue;
      const enemy = opponentOf(state, actor.id);
      const decision = decideAction(actor, enemy, state.tick);
      const frozen = isFrozen(actor.locks, state.tick);
      if (!frozen && decision.moveDelta !== 0) {
        const nextTile: TilePosition = { x: actor.tile.x + decision.moveDelta, y: actor.tile.y };
        setPlayer(state, { ...actor, tile: nextTile, zone: zoneAt(nextTile) });
      }
    }
  }
};

// --- Stage 2: prayer changes ---
const prayerStage: TickStage<SimulationState> = {
  name: "prayers",
  run: (state) => {
    for (const actor of [state.blue, state.red]) {
      if (!actor.alive) continue;
      const enemy = opponentOf(state, actor.id);
      const decision = decideAction(actor, enemy, state.tick);
      const requested = decision.activatePrayer as PrayerId | undefined;
      const activePrayers = requested ? compatiblePrayerSet([...actor.activePrayers, requested]) : actor.activePrayers;
      // Simplified flat drain: 1 prayer point per active prayer per tick while any prayer is on.
      const drain = activePrayers.length > 0 ? activePrayers.length : 0;
      const prayerPoints = Math.max(0, actor.prayerPoints - drain);
      const finalPrayers = prayerPoints > 0 ? [...activePrayers] : [];
      setPlayer(state, { ...actor, activePrayers: finalPrayers, prayerPoints });
    }
  }
};

// --- Stage 3: combat (attack gate -> PID-ordered resolution -> damage) ---
const combatStage: TickStage<SimulationState> = {
  name: "combat",
  run: (state) => {
    const actors = [state.blue, state.red].sort((a, b) => a.pid - b.pid);
    for (const actor of actors) {
      if (!actor.alive) continue;
      const enemy = opponentOf(state, actor.id);
      if (!enemy.alive) continue;

      const decision = decideAction(actor, enemy, state.tick);
      if (!decision.attackStyle || !actor.equipment.weapon) continue;

      const zone = zoneAt(actor.tile);
      const joinInput: JoinFightInput = {
        zone,
        currentAttackerTeam: state.engagedAttackerTeam,
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
        weapon: { style: weapon.style ?? "slash", cooldownTicks: weapon.cooldownTicks ?? 4, attackRange: weapon.attackRange ?? 1 },
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

      let updatedActor = { ...actor, attackTimer: gateResult.attackTimer, lastCombatTick: state.tick };
      if (special) {
        updatedActor = { ...updatedActor, specEnergy: Math.max(0, updatedActor.specEnergy - special.energyCost) };
      }
      setPlayer(state, updatedActor);

      const newHp = Math.max(0, enemy.currentHp - hit.finalDamage);
      const updatedEnemy = { ...enemy, currentHp: newHp, lastCombatTick: state.tick, lastDamagedByPlayerId: actor.id };
      setPlayer(state, updatedEnemy);
      state.engagedAttackerTeam = actor.team;

      log(
        state,
        hit.landed
          ? `${actor.id} hits ${enemy.id} for ${hit.finalDamage} (${weapon.style}${special ? " SPEC" : ""})`
          : `${actor.id} misses ${enemy.id} (${weapon.style}${special ? " SPEC" : ""})`
      );

      if (newHp <= 0) {
        handleDeath(state, updatedEnemy, actor);
      }
    }
  }
};

function handleDeath(state: SimulationState, victim: PlayerEntity, killer: PlayerEntity): void {
  const killerWithXp = { ...killer, stats: grantUnallocatedXp(killer.stats, xpRewards.playerKill), gp: killer.gp + gpRewards.playerKill, kills: killer.kills + 1 };
  setPlayer(state, killerWithXp);
  respawnVictim(state, victim);
  log(state, `${victim.id} was slain by ${killer.id}`);
}

/** A minion or tower landed the kill — no player gets kill credit, just respawn + log. */
function handleEnvironmentalDeath(state: SimulationState, victim: PlayerEntity, sourceLabel: string): void {
  respawnVictim(state, victim);
  log(state, `${victim.id} was slain by ${sourceLabel}`);
}

function respawnVictim(state: SimulationState, victim: PlayerEntity): void {
  const respawnTile: TilePosition = { x: victim.team === "blue" ? BLUE_BASE_X : RED_BASE_X, y: 0 };
  const respawned = {
    ...victim,
    alive: false,
    respawnAtTick: state.tick + 15, // ~9s respawn for prototype pacing
    currentHp: 0,
    tile: respawnTile,
    zone: "base" as const,
    deaths: victim.deaths + 1
  };
  setPlayer(state, respawned);
  state.engagedAttackerTeam = undefined;
}

// --- Stage 4: consumables / effects / stat investment ---
const effectsStage: TickStage<SimulationState> = {
  name: "effects",
  run: (state) => {
    for (const actor of [state.blue, state.red]) {
      if (!actor.alive) continue;
      const enemy = opponentOf(state, actor.id);
      const decision = decideAction(actor, enemy, state.tick);
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
        const item = shopCatalog.find((candidate) => candidate.id === decision.buyItemId);
        if (item && updated.gp >= item.cost) {
          updated = equipItem(updated, item);
          log(state, `${updated.id} buys ${item.name}`);
        }
      }

      updated = {
        ...updated,
        statusEffects: updated.statusEffects.filter((effect) => effect.expiresAtTick > state.tick),
        specEnergy: Math.min(100, updated.specEnergy + 0.1) // slow passive spec regen
      };

      setPlayer(state, updated);
    }
  }
};

// --- Stage 5: towers (target minions in range first — players only once no minion is closer) ---
const towerStage: TickStage<SimulationState> = {
  name: "towers",
  run: (state) => {
    for (const tower of state.towers) {
      if (!tower.alive) continue;
      if (!canAttack(tower.attackTimer, state.tick)) continue;

      const enemyMinions = state.minions.filter(
        (minion) => minion.alive && minion.team !== tower.team && Math.abs(minion.tile.x - tower.tile.x) <= tower.attackRange
      );
      const nearestMinion = enemyMinions.sort((a, b) => Math.abs(a.tile.x - tower.tile.x) - Math.abs(b.tile.x - tower.tile.x))[0];

      if (nearestMinion) {
        tower.attackTimer = { ...tower.attackTimer, lastAttackTick: state.tick, weaponCooldownTicks: 5, additiveAttackDelayTicks: 0 };
        const damage = Math.floor(state.rng() * (tower.maxHit + 1));
        nearestMinion.currentHp = Math.max(0, nearestMinion.currentHp - damage);
        if (nearestMinion.currentHp <= 0) {
          nearestMinion.alive = false;
          log(state, `Tower ${tower.id} destroys ${nearestMinion.id}`);
        }
        continue;
      }

      const enemyPlayers = [state.blue, state.red].filter((player) => player.alive && player.team !== tower.team);
      const target = enemyPlayers.find((player) => Math.abs(player.tile.x - tower.tile.x) <= tower.attackRange);
      if (!target) continue;

      tower.attackTimer = { ...tower.attackTimer, lastAttackTick: state.tick, weaponCooldownTicks: 5, additiveAttackDelayTicks: 0 };
      const damage = Math.floor(state.rng() * (tower.maxHit + 1));
      const newHp = Math.max(0, target.currentHp - damage);
      setPlayer(state, { ...target, currentHp: newHp, lastCombatTick: state.tick, lastDamagedByPlayerId: tower.id });
      log(state, `Tower ${tower.id} hits ${target.id} for ${damage}`);
      if (newHp <= 0) {
        handleEnvironmentalDeath(state, { ...target, currentHp: 0 }, tower.id);
      }
    }
  }
};

function canAttack(timer: { lastAttackTick: number; weaponCooldownTicks: number }, tick: number): boolean {
  return tick - timer.lastAttackTick >= timer.weaponCooldownTicks;
}

// --- Stage: minion waves (spawn, march down the lane, fight minions/tower/players in aggro range) ---
const minionStage: TickStage<SimulationState> = {
  name: "minions",
  run: (state) => {
    if (state.tick > 0 && state.tick % MINION_SPAWN_INTERVAL_TICKS === 0) {
      for (const team of ["blue", "red"] as const) {
        minionSeq += 1;
        state.minions.push({
          id: `minion-${team}-${minionSeq}`,
          kind: "minion",
          team,
          pid: nextPid(),
          tile: { x: team === "blue" ? BLUE_BASE_X + 2 : RED_BASE_X - 2, y: 0 },
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

    const alive = state.minions.filter((minion) => minion.alive);
    const sorted = [...alive].sort((a, b) => a.pid - b.pid);

    for (const minion of sorted) {
      const enemyMinions = alive.filter((other) => other.team !== minion.team && other.alive);
      const nearestMinion = enemyMinions
        .map((other) => ({ other, dist: Math.abs(other.tile.x - minion.tile.x) }))
        .sort((a, b) => a.dist - b.dist)[0];

      const enemyPlayers = [state.blue, state.red].filter((player) => player.alive && player.team !== minion.team);
      const nearestPlayer = enemyPlayers
        .map((player) => ({ player, dist: Math.abs(player.tile.x - minion.tile.x) }))
        .sort((a, b) => a.dist - b.dist)[0];

      const enemyTower = state.towers.find((tower) => tower.team !== minion.team && tower.alive);
      const towerDist = enemyTower ? Math.abs(enemyTower.tile.x - minion.tile.x) : Infinity;

      // Classic lane-creep priority: enemy minions first, then an engaged/nearby
      // player, then the tower. This is what makes standing in a wave risky.
      type MinionTarget =
        | { readonly kind: "minion"; readonly entity: MinionEntity; readonly dist: number }
        | { readonly kind: "player"; readonly entity: PlayerEntity; readonly dist: number }
        | { readonly kind: "tower"; readonly entity: TowerEntity; readonly dist: number };

      let target: MinionTarget | undefined;
      if (nearestMinion && nearestMinion.dist <= MINION_AGGRO_RANGE) {
        target = { kind: "minion", entity: nearestMinion.other, dist: nearestMinion.dist };
      } else if (nearestPlayer && nearestPlayer.dist <= MINION_AGGRO_RANGE) {
        target = { kind: "player", entity: nearestPlayer.player, dist: nearestPlayer.dist };
      } else if (enemyTower && towerDist <= MINION_AGGRO_RANGE) {
        target = { kind: "tower", entity: enemyTower, dist: towerDist };
      }

      if (target && target.dist <= 1) {
        if (canAttack(minion.attackTimer, state.tick)) {
          minion.attackTimer = { ...minion.attackTimer, lastAttackTick: state.tick, weaponCooldownTicks: 4, additiveAttackDelayTicks: 0 };
          const damage = Math.floor(state.rng() * (minion.maxHit + 1));

          if (target.kind === "player") {
            const newHp = Math.max(0, target.entity.currentHp - damage);
            setPlayer(state, { ...target.entity, currentHp: newHp, lastCombatTick: state.tick, lastDamagedByPlayerId: minion.id });
            log(state, `${minion.id} hits ${target.entity.id} for ${damage}`);
            if (newHp <= 0) {
              handleEnvironmentalDeath(state, { ...target.entity, currentHp: 0 }, minion.id);
            }
          } else {
            target.entity.currentHp = Math.max(0, target.entity.currentHp - damage);
            if (target.entity.currentHp <= 0) {
              target.entity.alive = false;
              log(state, `${minion.id} destroys ${target.entity.id}`);
              if (target.kind === "minion") {
                rewardNearestPlayer(state, minion);
              }
            }
          }
        }
      } else {
        const direction = minion.team === "blue" ? 1 : -1;
        minion.tile = { x: minion.tile.x + direction, y: minion.tile.y };
      }
    }

    state.minions = alive;
  }
};

function rewardNearestPlayer(state: SimulationState, killerMinion: MinionEntity): void {
  const candidates = [state.blue, state.red].filter((player) => player.alive && player.team === killerMinion.team);
  const nearest = candidates.sort((a, b) => Math.abs(a.tile.x - killerMinion.tile.x) - Math.abs(b.tile.x - killerMinion.tile.x))[0];
  if (!nearest || Math.abs(nearest.tile.x - killerMinion.tile.x) > MINION_AGGRO_RANGE) return; // must be "on lane" to farm
  setPlayer(state, {
    ...nearest,
    gp: nearest.gp + gpRewards.minionKill,
    stats: grantUnallocatedXp(nearest.stats, xpRewards.minionKill)
  });
}

// --- Stage 6: lock decay (freeze/stun countdown) ---
const lockDecayStage: TickStage<SimulationState> = {
  name: "lock-decay",
  run: (state) => {
    for (const actor of [state.blue, state.red]) {
      setPlayer(state, { ...actor, locks: tickLocks(actor.locks, state.tick) });
      const consumed = consumeExpiredAttackDelay(actor.attackTimer, state.tick);
      setPlayer(state, { ...actor, attackTimer: consumed.state });
    }
  }
};

// --- Stage 7: respawns ---
const respawnStage: TickStage<SimulationState> = {
  name: "respawns",
  run: (state) => {
    for (const actor of [state.blue, state.red]) {
      if (!actor.alive && actor.respawnAtTick !== undefined && state.tick >= actor.respawnAtTick) {
        setPlayer(state, { ...actor, alive: true, currentHp: maxHitpoints(actor.stats), respawnAtTick: undefined });
        log(state, `${actor.id} respawns`);
      }
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
