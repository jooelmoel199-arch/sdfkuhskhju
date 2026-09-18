import { createTickStageRunner, type TickStage } from "../engine/tick";
import { applyFreeze, isFrozen, tickLocks } from "../entity/locks";
import { consumeExpiredAttackDelay, createAttackTimerState, delayAttack } from "../combat/timers";
import { dispatchAttack } from "../combat/attackGate";
import { meleeHitTick, projectileHitTick, type PendingHit } from "../combat/pendingHits";
import { rollAttack, rollDragonClawsSpecial } from "../combat/resolve";
import { compatiblePrayerSet, aggregatePrayerBoosts, prayerDefinitions, applyProtectionDamageReduction, type PrayerId } from "../prayer/prayers";
import type { PlayerEntity, MinionEntity, TowerEntity, NeutralCampEntity, ProjectileEntity } from "./entities";
import { consumeItem, equipItem, equipOwnedItem, equipmentBonuses, nextNpcId, nextPid, inventoryCount, addInventoryItem } from "./entities";
import { toCombatLevels, grantUnallocatedXp, investXp, maxHitpoints, levelOf } from "./stats";
import { gpRewards, xpRewards, shopCatalog } from "./economy";
import { decideAction, findConsumable } from "./ai";
import { drainPlayerCommands, enqueuePlayerCommand, makeStrongCommand, type PlayerCommand, type PlayerCommandInput } from "../combat/commandQueue";
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
import { canMeleeReachThisTick, type TilePosition } from "../world/movement";

const MINION_SPAWN_INTERVAL_TICKS = 15;
const MINIONS_PER_WAVE_PER_LANE = 3;
const MINION_MAX_HP = 15;
const MINION_MAX_HIT = 4;
const MINION_AGGRO_RANGE = 6;

let minionSeq = 0;
let projectileSeq = 0;

export const TICK_MS = 600;

export interface PendingDeath {
  readonly victimId: string;
  readonly dueTick: number;
  readonly killerId?: string;
  readonly sourceId?: string;
}

export interface CombatEvent {
  readonly tick: number;
  readonly attackerId: string;
  readonly targetId: string;
  readonly style: "melee" | "ranged" | "magic";
  readonly damage: number;
  readonly landed: boolean;
  readonly special?: boolean;
  readonly vengeance?: boolean;
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
  /** Monotonic per-simulation insertion order for queue FIFO semantics. */
  pendingHitSequence: number;
  pendingNpcHits: PendingHit[];
  pendingDeaths: PendingDeath[];
  /** Client commands are delivered on the following server tick and consumed FIFO, up to ten per tick. */
  clientCommands: Record<string, PlayerCommand[]>;
  nextClientCommandSequence: number;
  /** NPC currently executing its authoritative turn. */
  npcTurnId?: string;
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
  /** Player currently executing the authoritative PID turn. */
  playerTurnId?: string;
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

function comparePendingHits(a: PendingHit, b: PendingHit): number {
  return a.dueTick - b.dueTick ||
    a.createdTick - b.createdTick ||
    (a.sequence ?? 0) - (b.sequence ?? 0) ||
    a.attackerPid - b.attackerPid ||
    a.id.localeCompare(b.id);
}

function enqueuePendingHit(state: SimulationState, hit: PendingHit): void {
  state.pendingHitSequence += 1;
  state.pendingHits.push({ ...hit, sequence: state.pendingHitSequence });
}

function enqueuePendingNpcHit(state: SimulationState, hit: PendingHit): void {
  state.pendingHitSequence += 1;
  state.pendingNpcHits.push({ ...hit, sequence: state.pendingHitSequence });
}

function resolvePendingNpcHits(state: SimulationState, targetId: string): PendingHit[] {
  const ready = state.pendingNpcHits
    .filter(hit => hit.targetId === targetId && hit.dueTick <= state.tick)
    .sort(comparePendingHits);
  if (ready.length === 0) return [];
  const consumed = new Set(ready.map(hit => hit.id));
  state.pendingNpcHits = state.pendingNpcHits.filter(hit => !consumed.has(hit.id));
  return ready;
}

function schedulePlayerDeath(
  state: SimulationState,
  victimId: string,
  killerId?: string,
  sourceId?: string
): void {
  if (state.pendingDeaths.some(death => death.victimId === victimId)) return;
  state.pendingDeaths.push({
    victimId,
    dueTick: state.tick + 1,
    killerId,
    sourceId
  });
}

function resolvePendingDeathForPlayer(state: SimulationState, targetId: string): void {
  const deaths = state.pendingDeaths
    .filter(death => death.victimId === targetId && death.dueTick <= state.tick)
    .sort((a, b) => a.dueTick - b.dueTick);
  if (deaths.length === 0) return;
  state.pendingDeaths = state.pendingDeaths.filter(death => !(death.victimId === targetId && death.dueTick <= state.tick));
  const death = deaths[0];
  const victim = state.players.find(player => player.id === targetId && player.alive);
  if (!victim || victim.currentHp > 0) return;
  const killer = death.killerId
    ? state.players.find(player => player.id === death.killerId && player.alive)
    : undefined;
  if (killer) handlePlayerDeath(state, victim, killer);
  else handleEnvironmentalDeath(state, victim, death.sourceId ?? "queued damage");
}

export function queueClientCommand(
  state: SimulationState,
  input: PlayerCommandInput,
  executeNextTick = true,
  playerId = state.blue.id
): void {
  state.nextClientCommandSequence += 1;
  const command = makeStrongCommand(
    input,
    state.nextClientCommandSequence,
    state.tick,
    state.tick + (executeNextTick ? 1 : 0)
  );
  const currentQueue = state.clientCommands[playerId] ?? [];
  state.clientCommands[playerId] = enqueuePlayerCommand(currentQueue, command);
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

function isGmaulEquipped(player: PlayerEntity): boolean {
  return player.equipment.weapon?.id === "granite_maul";
}

function gmaulSpecBarVisible(player: PlayerEntity, currentTick: number): boolean {
  if (!isGmaulEquipped(player)) return false;
  // A deserialised/already-equipped Gmaul without an explicit switch timestamp
  // is already on the combat tab, so its special bar is available.
  return player.gmaulSpecBarVisibleTick === undefined ||
    player.gmaulSpecBarVisibleTick <= currentTick;
}

function gmaulAutoSpecWindowOpen(
  player: PlayerEntity,
  targetId: string,
  currentTick: number
): boolean {
  return isGmaulEquipped(player) &&
    player.lastGmaulTargetId === targetId &&
    currentTick - player.lastGmaulAttackTick <= 5;
}

function expireGmaulPreload(player: PlayerEntity, currentTick: number): PlayerEntity {
  if (!player.gmaulPreloaded) return player;
  if (player.gmaulPreloadExpiresAtTick === undefined || currentTick < player.gmaulPreloadExpiresAtTick) {
    return player;
  }
  return {
    ...player,
    queuedSpecialAttacks: 0,
    queuedSpecialTargetId: undefined,
    gmaulPreloadExpiresAtTick: undefined,
    gmaulPreloaded: false,
    specialActive: false
  };
}

function expireVengeance(player: PlayerEntity, currentTick: number): PlayerEntity {
  if (!player.vengeanceActive || player.vengeanceExpiresAtTick === undefined || currentTick < player.vengeanceExpiresAtTick) {
    return player;
  }
  return {
    ...player,
    vengeanceActive: false,
    vengeanceExpiresAtTick: undefined
  };
}

function tickTargetMemory(player: PlayerEntity): PlayerEntity {
  if (player.lastTargetTimeoutTicks <= 0) return player;
  const remaining = player.lastTargetTimeoutTicks - 1;
  if (remaining > 0) return { ...player, lastTargetTimeoutTicks: remaining };
  return { ...player, lastTargetId: undefined, lastTargetTimeoutTicks: 0 };
}

function applyEquipGmaulTiming(
  playerBefore: PlayerEntity,
  playerAfter: PlayerEntity,
  currentTick: number
): PlayerEntity {
  const wasGmaul = isGmaulEquipped(playerBefore);
  const isGmaul = isGmaulEquipped(playerAfter);
  if (!isGmaul) {
    return {
      ...playerAfter,
      queuedSpecialAttacks: wasGmaul ? 0 : playerAfter.queuedSpecialAttacks,
      queuedSpecialTargetId: wasGmaul ? undefined : playerAfter.queuedSpecialTargetId,
      gmaulPreloadExpiresAtTick: wasGmaul ? undefined : playerAfter.gmaulPreloadExpiresAtTick,
      specialActive: wasGmaul ? false : playerAfter.specialActive,
      lastGmaulTargetId: wasGmaul ? undefined : playerAfter.lastGmaulTargetId,
      lastGmaulAttackTick: wasGmaul ? -1000 : playerAfter.lastGmaulAttackTick,
      gmaulEquippedTick: undefined,
      gmaulSpecBarVisibleTick: undefined,
      gmaulPreloaded: false
    };
  }
  const previousWeaponHadVisibleSpecBar = Boolean(playerBefore.equipment.weapon?.special);
  if (wasGmaul) return playerAfter;
  return {
    ...playerAfter,
    queuedSpecialAttacks: 0,
    queuedSpecialTargetId: undefined,
    gmaulPreloadExpiresAtTick: undefined,
    specialActive: false,
    gmaulEquippedTick: currentTick,
    gmaulSpecBarVisibleTick: previousWeaponHadVisibleSpecBar ? currentTick : currentTick + 1,
    gmaulPreloaded: false
  };
}

function decisionFor(state: SimulationState, actor: PlayerEntity, enemy: PlayerEntity) {
  const ai = decideAction(actor, enemy, state.tick);
  if (actor.id !== state.blue.id || !state.humanControl) return ai;

  let targetTile: TilePosition | undefined;
  if (state.humanControl.attackTargetId === enemy.id) {
    targetTile = enemy.tile;
  } else if (state.humanControl.attackTargetId) {
    targetTile =
      state.jungleCamps.find(camp => camp.id === state.humanControl?.attackTargetId)?.tile ??
      state.towers.find(tower => tower.id === state.humanControl?.attackTargetId && tower.alive)?.tile;
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
    // Human prayers/specials arrive through the authoritative client-command queue.
    // AI remains a desired-state system and continues to use its own decision.
    activatePrayer: actor.id === state.blue.id ? undefined : ai.activatePrayer,
    eatItemId: actor.id === state.blue.id ? undefined : ai.eatItemId,
    useSpecial: actor.id === state.blue.id ? actor.specialActive : ai.useSpecial,
    investStat: state.humanControl.investStat,
    buyItemId: state.humanControl.buyItemId,
    buyConsumableId: state.humanControl.buyConsumableId,
    buyConsumableQuantity: state.humanControl.buyConsumableQuantity,
    equipItemId: undefined
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
    const human = state.humanControl;
    // Older tests/callers may still provide one-shot fields. Treat them as
    // commands already received by the blue client on this tick.
    if (human) {
      if (human.equipItemId) queueClientCommand(state, { kind: "equip", itemId: human.equipItemId }, false);
      if (human.consumeItemId) queueClientCommand(state, { kind: "eat", itemId: human.consumeItemId }, false);
      if (human.comboConsumableId) queueClientCommand(state, { kind: "eat", itemId: human.comboConsumableId, combo: true }, false);
      if (human.activatePrayer) queueClientCommand(state, { kind: "prayer", prayerId: human.activatePrayer }, false);
      if (human.useSpecial) queueClientCommand(state, { kind: "special", targetId: human.attackTargetId }, false);
      delete human.equipItemId;
      delete human.consumeItemId;
      delete human.comboConsumableId;
      delete human.activatePrayer;
      delete human.useSpecial;
    }

    // Henke's model gives every player a client-input phase before the NPC
    // phase. Each player's command stream is independent and FIFO.
    for (const actorSnapshot of [...state.players]) {
      const actor = state.players.find(player => player.id === actorSnapshot.id);
      // A player at 0 HP has a queued death and cannot execute fresh client input before it resolves.
      if (!actor || !actor.alive || actor.currentHp <= 0) continue;

      const queue = state.clientCommands[actor.id] ?? [];
      const drained = drainPlayerCommands(queue, state.tick, 10);
      state.clientCommands[actor.id] = drained.queue;
      let current = tickTargetMemory(expireVengeance(expireGmaulPreload(actor, state.tick), state.tick));

      for (const command of drained.commands) {
        switch (command.kind) {
          case "equip": {
            const equipped = equipOwnedItem(current, command.itemId);
            if (equipped !== current) {
              current = applyEquipGmaulTiming(current, equipped, state.tick);
            }
            break;
          }
          case "eat":
            current = applyConsumableAction(state, current, command.itemId, Boolean(command.combo));
            break;
          case "prayer": {
            const active = current.activePrayers.includes(command.prayerId)
              ? current.activePrayers.filter(prayer => prayer !== command.prayerId)
              : compatiblePrayerSet([...current.activePrayers, command.prayerId]);
            current = {
              ...current,
              activePrayers: current.prayerPoints > 0 ? [...active] : [],
              lastPrayerToggleTick: state.tick
            };
            break;
          }
          case "special": {
            const specialWeapon = current.equipment.weapon?.special;
            if (!specialWeapon) {
              log(state, current.id + " has no usable special attack");
              break;
            }

            if (isGmaulEquipped(current)) {
              if (!gmaulSpecBarVisible(current, state.tick)) {
                log(state, current.id + " fails Granite maul special: spec bar not yet visible");
                break;
              }

              const targetId =
                command.targetId ??
                current.queuedSpecialTargetId ??
                state.humanControl?.attackTargetId ??
                current.lastCombatTargetId;
              const target = targetId
                ? state.players.find(player => player.id === targetId && player.alive && player.team !== current.team)
                : undefined;
              const adjacent = target !== undefined &&
                canMeleeReachThisTick({
                  attacker: current.tile,
                  defender: target.tile,
                  attackerFrozen: isFrozen(current.locks, state.tick),
                  attackRange: 1
                }).canReach;

              if (current.gmaulPreloaded) {
                // A second special-bar click arms the double-spec preload.
                // A target click or third bar click releases it only once
                // melee reach is actually established.
                if (adjacent) {
                  const usable = Math.min(2, Math.floor(current.specEnergy / 50));
                  current = {
                    ...current,
                    queuedSpecialAttacks: usable,
                    queuedSpecialTargetId: targetId,
                    specialActive: usable > 0,
                    gmaulPreloaded: false,
                    gmaulPreloadExpiresAtTick: undefined
                  };
                  log(state, current.id + " releases Granite maul double-spec");
                } else {
                  current = {
                    ...current,
                    queuedSpecialTargetId: targetId
                  };
                }
                break;
              }

              if (current.specialActive) {
                current = {
                  ...current,
                  specialActive: false,
                  gmaulPreloaded: true,
                  gmaulPreloadExpiresAtTick: state.tick + 3
                };
                log(state, current.id + " arms Granite maul double-spec preload");
                break;
              }

              current = {
                ...current,
                specialActive: true,
                queuedSpecialTargetId: targetId
              };
              break;
            }

            current = {
              ...current,
              queuedSpecialAttacks: 0,
              queuedSpecialTargetId: undefined,
              specialActive: !current.specialActive
            };
            log(state, current.id + (current.specialActive ? " activates " : " deactivates ") + "special attack");
            break;
          }
          case "vengeance": {
            if (current.vengeanceActive) {
              break;
            }
            const cooldownReady = state.tick >= current.vengeanceCooldownUntilTick;
            if (!cooldownReady) {
              log(state, current.id + " fails Vengeance: cooldown");
              break;
            }
            current = {
              ...current,
              vengeanceActive: true,
              vengeanceCooldownUntilTick: state.tick + 50,
              vengeanceExpiresAtTick: state.tick + 50,
              lastVengeanceCastTick: state.tick
            };
            log(state, current.id + " casts Vengeance");
            break;

          }
          case "attack-target": {
            const validTarget =
              state.players.some(player => player.id === command.targetId && player.alive && player.team !== current.team) ||
              state.jungleCamps.some(camp => camp.id === command.targetId && camp.alive) ||
              state.towers.some(tower => tower.id === command.targetId && tower.alive && tower.team !== current.team);
            if (!validTarget) break;

            current = {
              ...current,
              queuedSpecialTargetId:
                isGmaulEquipped(current) && current.gmaulPreloaded
                  ? command.targetId
                  : current.queuedSpecialTargetId
            };

            if (isGmaulEquipped(current)) {
              const target = state.players.find(
                player => player.id === command.targetId &&
                  player.alive &&
                  player.team !== current.team
              );
              if (current.gmaulPreloaded) {
                // Target interaction is the release command. The player may be
                // out of melee range at the moment of the click; movement then
                // carries the queued special into reach just like a normal
                // PlayerCombat target route.
                const usable = Math.min(2, Math.floor(current.specEnergy / 50));
                current = {
                  ...current,
                  queuedSpecialAttacks: usable,
                  queuedSpecialTargetId: command.targetId,
                  specialActive: false,
                  gmaulPreloaded: false,
                  gmaulPreloadExpiresAtTick: undefined
                };
                log(state, current.id + " releases Granite maul preload on target click");
              } else if (!current.gmaulPreloaded && current.specialActive) {
                current = {
                  ...current,
                  queuedSpecialAttacks: 1,
                  queuedSpecialTargetId: command.targetId,
                  specialActive: false
                };
                log(state, current.id + (
                  gmaulAutoSpecWindowOpen(current, command.targetId, state.tick)
                    ? " auto-releases Granite maul special on recent target"
                    : " releases Granite maul special on target click"
                ));
              }
            }

            current = {
              ...current,
              lastTargetId: command.targetId,
              lastTargetTimeoutTicks: 5
            };
            if (current.id === state.blue.id) {
              state.humanControl = {
                ...(state.humanControl ?? { attackEnabled: true, laneId: current.laneId }),
                attackTargetId: command.targetId
              };
            }
            break;
          }
          case "clear-attack-target":
            if (current.id === state.blue.id && state.humanControl) delete state.humanControl.attackTargetId;
            current = { ...current, queuedSpecialTargetId: undefined };
            break;
          case "move":
            if (current.id === state.blue.id) {
              state.humanControl = {
                ...(state.humanControl ?? { attackEnabled: true, laneId: current.laneId }),
                moveTargetX: Math.max(1, Math.min(39, command.x)),
                moveTargetY: command.y
              };
            }
            break;
          case "stop-movement":
            if (current.id === state.blue.id && state.humanControl) {
              delete state.humanControl.moveTargetX;
              delete state.humanControl.moveTargetY;
              delete state.humanControl.attackTargetId;
            }
            current = { ...current, queuedSpecialTargetId: undefined };
            break;
        }
      }

      setPlayer(state, current);
    }
  }
};

// --- Player-turn substage: movement / target lane routing ---
const movementStage: TickStage<SimulationState> = {
  name: "movement",
  run: state => {
    const actorIds = state.playerTurnId ? [state.playerTurnId] : [...state.players].sort((a, b) => playerPriority(state, a.id) - playerPriority(state, b.id)).map(player => player.id);

    for (const actorId of actorIds) {
      const actor = state.players.find(player => player.id === actorId);
      if (!actor) continue;
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

// --- Player-turn substage: prayer state changes ---
const prayerStage: TickStage<SimulationState> = {
  name: "prayer-state",
  run: state => {
    const actors = state.playerTurnId
      ? state.players.filter(player => player.id === state.playerTurnId)
      : [...state.players];
    for (const actor of actors) {
      if (!actor.alive) continue;
      const enemy = opponentOf(state, actor.id);
      const decision = decisionFor(state, actor, enemy);
      const requested = actor.id === state.blue.id ? undefined : decision.activatePrayer as PrayerId | undefined;
      // Human prayer commands are already applied during client input.
      // AI prayer is a desired state, not a repeated toggle.
      const active = requested
        ? compatiblePrayerSet([...actor.activePrayers, requested])
        : actor.activePrayers;
      setPlayer(state, {
        ...actor,
        activePrayers: actor.prayerPoints > 0 ? [...active] : [],
        lastPrayerToggleTick: requested ? state.tick : actor.lastPrayerToggleTick
      });
    }
  }
};

// Timers are intentionally after the queue. A queued hit must see the prayer
// state for this turn before prayer drain can consume points.
const prayerDrainStage: TickStage<SimulationState> = {
  name: "prayer-drain",
  run: state => {
    const actors = state.playerTurnId
      ? state.players.filter(player => player.id === state.playerTurnId)
      : [...state.players];
    for (const actor of actors) {
      if (!actor.alive) continue;
      const prayerBonus = equipmentBonuses(actor.equipment).prayer_bonus;
      const drainEffect = actor.activePrayers.reduce(
        (sum, prayer) => sum + (prayerDefinitions[prayer]?.drain ?? 0),
        0
      );
      const drainResistance = Math.max(60, 60 + 2 * prayerBonus);
      let drainAccumulator = actor.prayerDrainAccumulator + drainEffect;
      let prayerPoints = actor.prayerPoints;
      while (drainAccumulator >= drainResistance && prayerPoints > 0) {
        drainAccumulator -= drainResistance;
        prayerPoints -= 1;
      }
      setPlayer(state, {
        ...actor,
        activePrayers: prayerPoints > 0 ? actor.activePrayers : [],
        prayerPoints,
        prayerDrainAccumulator: prayerPoints > 0 ? drainAccumulator : 0
      });
    }
  }
};

// --- Player-turn substage: combat / queued impacts ---
function resolvePendingHitsForPlayer(state: SimulationState, targetId: string): void {
  const ready = state.pendingHits
    .filter(hit => hit.targetId === targetId && hit.dueTick <= state.tick)
    .sort(comparePendingHits);
  if (ready.length === 0) return;
  state.pendingHits = state.pendingHits.filter(hit => !(hit.targetId === targetId && hit.dueTick <= state.tick));

  for (const hit of ready) {
    const target = state.players.find(player => player.id === hit.targetId);
    if (!target || !target.alive) continue;
    const attacker = state.players.find(player => player.id === hit.attackerId);

    if (!hit.landed) {
      setPlayer(state, { ...target, lastCombatTick: state.tick });
      pushCombatEvent(state, { tick: state.tick, attackerId: hit.attackerId, targetId: target.id,
        style: eventStyle(hit.style), damage: 0, landed: false, special: Boolean(hit.special) });
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

    if (hit.landed && hit.freezeTicks) {
      resolvedTarget = {
        ...resolvedTarget,
        locks: applyFreeze(resolvedTarget.locks, state.tick, hit.freezeTicks, hit.attackerId)
      };
    }
    if (impactDamage > 0 &&
        resolvedTarget.vengeanceActive &&
        attacker &&
        attacker.id !== resolvedTarget.id &&
        attacker.currentHp > 0) {
      const vengeanceDamage = Math.min(
        attacker.currentHp,
        Math.trunc(impactDamage * 0.75)
      );
      resolvedTarget = {
        ...resolvedTarget,
        vengeanceActive: false,
        vengeanceExpiresAtTick: undefined
      };
      if (vengeanceDamage > 0) {
        const reflected = state.players.find(player => player.id === attacker.id);
        if (reflected && reflected.alive) {
          const reflectedHp = Math.max(0, reflected.currentHp - vengeanceDamage);
          setPlayer(state, {
            ...reflected,
            currentHp: reflectedHp,
            lastCombatTick: state.tick,
            lastDamagedByPlayerId: resolvedTarget.id
          });
          pushCombatEvent(state, {
            tick: state.tick,
            attackerId: resolvedTarget.id,
            targetId: reflected.id,
            style: "melee",
            damage: vengeanceDamage,
            landed: true,
            vengeance: true
          });
          log(state, resolvedTarget.id + " reflects " + vengeanceDamage + " Vengeance damage to " + reflected.id);
          if (reflectedHp <= 0) {
            schedulePlayerDeath(state, reflected.id, resolvedTarget.id);
          }
        }
      }
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
      style: eventStyle(hit.style), damage: impactDamage, landed: true, special: Boolean(hit.special), freezeTicks: hit.freezeTicks });
    log(state, hit.attackerId + " hits " + target.id + " for " + impactDamage +
      " (" + hit.style + " " + hit.attackType + ", tick " + hit.dueTick + ")");
    if (resolvedTarget.currentHp <= 0) {
      schedulePlayerDeath(
        state,
        resolvedTarget.id,
        attacker?.id,
        attacker ? undefined : hit.attackerId
      );
      log(state, resolvedTarget.id + " queues death for tick " + (state.tick + 1));
    }
  }
}

function handleGraniteMaulSpecial(
  state: SimulationState,
  actor: PlayerEntity,
  target: PlayerEntity
): boolean {
  if (actor.equipment.weapon?.id !== "granite_maul" || actor.queuedSpecialAttacks <= 0) return false;
  if (
    actor.gmaulPreloadExpiresAtTick !== undefined &&
    state.tick >= actor.gmaulPreloadExpiresAtTick
  ) {
    setPlayer(state, {
      ...actor,
      queuedSpecialAttacks: 0,
      queuedSpecialTargetId: undefined,
      gmaulPreloadExpiresAtTick: undefined,
      gmaulPreloaded: false
    });
    log(state, actor.id + " Granite maul special queue expires");
    return true;
  }

  const reach = canMeleeReachThisTick({
    attacker: actor.tile,
    defender: target.tile,
    attackerFrozen: isFrozen(actor.locks, state.tick),
    attackRange: 1
  });

  if (!reach.canReach) {
    // Keep the special armed while movement routes the player into melee.
    return false;
  }

  const specialEnergyCost = actor.equipment.weapon.special?.energyCost ?? 50;
  const usable = Math.min(actor.queuedSpecialAttacks, Math.floor(actor.specEnergy / specialEnergyCost));
  if (usable <= 0) {
    setPlayer(state, {
      ...actor,
      queuedSpecialAttacks: 0,
      queuedSpecialTargetId: undefined,
      gmaulPreloadExpiresAtTick: undefined,
      gmaulPreloaded: false
    });
    log(state, actor.id + " fails Granite maul special: not enough energy");
    return true;
  }

  const prayerBoosts = aggregatePrayerBoosts(actor.activePrayers);
  const targetPrayerBoosts = aggregatePrayerBoosts(target.activePrayers);
  const attackBoostMultiplier =
    1 + prayerBoosts.attack + actor.statusEffects
      .filter(effect => effect.style === "crush" || effect.style === "slash")
      .reduce((sum, effect) => sum + effect.amount, 0);
  const strengthBoostMultiplier =
    1 + prayerBoosts.strength + actor.statusEffects
      .filter(effect => effect.style === "crush" || effect.style === "slash")
      .reduce((sum, effect) => sum + effect.amount, 0);
  const defenceBoostMultiplier = 1 + targetPrayerBoosts.defence;

  let hitsQueued = 0;
  for (let strike = 0; strike < usable; strike += 1) {
    const hit = rollAttack({
      style: "crush",
      attackType: actor.attackType,
      attackerLevels: toCombatLevels(actor.stats),
      defenderLevels: toCombatLevels(target.stats),
      attackerBonuses: equipmentBonuses(actor.equipment),
      defenderBonuses: equipmentBonuses(target.equipment),
      defenderPrayers: target.activePrayers,
      attackerIsPlayer: true,
      attackBoostMultiplier,
      strengthBoostMultiplier,
      defenceBoostMultiplier,
      // Granite maul Quick Smash has no accuracy or damage multiplier.
      rng: state.rng
    });
    const hitTick = meleeHitTick(
      state.tick,
      playerPriority(state, actor.id),
      playerPriority(state, target.id)
    );
    enqueuePendingHit(state, {
      id: "gmaul-" + actor.id + "-" + state.tick + "-" + (++projectileSeq),
      dueTick: hitTick,
      attackerId: actor.id,
      targetId: target.id,
      attackerPid: actor.pid,
      targetPid: target.pid,
      style: "crush",
      attackType: actor.attackType,
      landed: hit.landed,
      hitChance: hit.hitChance,
      rawDamage: hit.rawDamage,
      special: true,
      createdTick: state.tick
    });
    hitsQueued += 1;
  }

  setPlayer(state, {
    ...actor,
    specEnergy: Math.max(0, actor.specEnergy - hitsQueued * specialEnergyCost),
    lastSpecEnergyUseTick: state.tick,
    queuedSpecialAttacks: Math.max(0, actor.queuedSpecialAttacks - hitsQueued),
    queuedSpecialTargetId: actor.queuedSpecialAttacks - hitsQueued > 0 ? target.id : undefined,
    gmaulPreloadExpiresAtTick: actor.queuedSpecialAttacks - hitsQueued > 0
      ? actor.gmaulPreloadExpiresAtTick
      : undefined,
    gmaulPreloaded: false,
    specialActive: false,
    lastCombatTick: state.tick,
    lastCombatTargetId: target.id,
    lastGmaulTargetId: target.id,
    lastGmaulAttackTick: state.tick
  });
  log(state, actor.id + " uses Granite maul special on " + target.id + " (" + hitsQueued + " instant attack" + (hitsQueued === 1 ? "" : "s") + ")");
  return true;
}

const combatStage: TickStage<SimulationState> = {
  name: "combat",
  run: state => {
    const actors = state.playerTurnId
      ? state.players.filter(player => player.id === state.playerTurnId)
      : [...state.players].sort((a, b) => playerPriority(state, a.id) - playerPriority(state, b.id));

    for (const snapshot of actors) {
      const actor = state.players.find(player => player.id === snapshot.id);
      if (!actor) continue;
      if (!actor.alive || !actor.equipment.weapon) continue;
      // The PvP test dummy is intentionally active: it supplies incoming
      // attacks so prayer switching, eating, PID trades and freezes can be
      // exercised without needing a second human client. Its decisions remain
      // AI-controlled and it cannot consume the human command stream.

      const queuedSpecialTarget = actor.queuedSpecialTargetId
        ? state.players.find(player => player.id === actor.queuedSpecialTargetId && player.alive && player.team !== actor.team)
        : undefined;
      const enemy = queuedSpecialTarget ?? opponentOf(state, actor.id);
      const decision = decisionFor(state, actor, enemy);

      // An armed Granite maul spec is an explicit combat command. It must be
      // evaluated before the ordinary attack-style gate, otherwise a valid
      // queued special can be stranded by a transient movement/interaction state.
      if (
        actor.equipment.weapon?.id === "granite_maul" &&
        actor.queuedSpecialAttacks > 0 &&
        enemy.alive
      ) {
        if (handleGraniteMaulSpecial(state, actor, enemy)) continue;
      }

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
      if (
        enemy.zone === "lane" &&
        enemy.lastTargetId &&
        enemy.lastTargetId !== actor.id &&
        enemy.lastTargetTimeoutTicks > 0
      ) {
        const previousTarget = state.players.find(player => player.id === enemy.lastTargetId);
        if (previousTarget?.alive && previousTarget.team !== actor.team) continue;
      }

      const weapon = actor.equipment.weapon;
      const attackType = decision.attackType;

      // Granite maul Quick Smash is instant and does not inherit the normal
      // seven-tick attack cooldown. One-click auto-release is only available
      // against a target hit by this Gmaul within the previous five ticks.
      if (weapon.id === "granite_maul") {
        let gmaulActor = state.players.find(player => player.id === actor.id) ?? actor;

        if (
          gmaulActor.specialActive &&
          gmaulActor.queuedSpecialAttacks === 0 &&
          !gmaulActor.gmaulPreloaded &&
          gmaulAutoSpecWindowOpen(gmaulActor, enemy.id, state.tick) &&
          canMeleeReachThisTick({
            attacker: gmaulActor.tile,
            defender: enemy.tile,
            attackerFrozen: isFrozen(gmaulActor.locks, state.tick),
            attackRange: 1
          }).canReach
        ) {
          gmaulActor = {
            ...gmaulActor,
            queuedSpecialAttacks: Math.min(1, Math.floor(gmaulActor.specEnergy / 50)),
            queuedSpecialTargetId: enemy.id
          };
          setPlayer(state, gmaulActor);
        }

        if (gmaulActor.queuedSpecialAttacks > 0) {
          // A released Gmaul special owns the attack interaction until it fires;
          // do not fall through to an ordinary maul swing while movement is
          // still bringing the player into melee range.
          if (handleGraniteMaulSpecial(state, gmaulActor, enemy)) continue;
          continue;
        }
      }

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

      // Standard special attacks consume one queued client special when an
      // eligible attack actually happens. If energy is insufficient the command
      // is discarded and the ordinary attack proceeds instead.
      const specialToggleActive = actor.specialActive || (actor.id !== state.blue.id && decision.useSpecial);
      const special = specialToggleActive &&
        weapon.special &&
        actor.specEnergy >= weapon.special.energyCost
        ? weapon.special
        : undefined;
      const currentEnemy = enemy;
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
        lastCombatTargetId: currentEnemy.id,
        queuedSpecialAttacks: actor.queuedSpecialAttacks,
        queuedSpecialTargetId: actor.queuedSpecialTargetId,
        specialActive: special ? false : actor.specialActive,
        specEnergy: special ? Math.max(0, actor.specEnergy - special.energyCost) : actor.specEnergy,
        lastSpecEnergyUseTick: special ? state.tick : actor.lastSpecEnergyUseTick
      };
      const combatWithHistory: PlayerEntity = {
        ...attackerAfterAttack,
        lastTargetId: currentEnemy.id,
        lastTargetTimeoutTicks: 5,
        ...(weapon.id === "granite_maul"
          ? {
              lastGmaulTargetId: currentEnemy.id,
              lastGmaulAttackTick: state.tick
            }
          : {})
      };
      setPlayer(state, combatWithHistory);
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
          enqueuePendingHit(state, {
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
            rawDamage: claw.rawDamages[strike],
            special: true,
            createdTick: state.tick
          });
        }
        log(state, actor.id + " uses Dragon claws on " + currentEnemy.id + " (" + claw.damages.join("/") + ")");
      } else {
        enqueuePendingHit(state, {
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
          special: Boolean(special),
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
          enqueuePendingHit(state, {
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
            special: Boolean(special),
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
    lastCombatTick: state.tick,
    lastCombatTargetId: tower.id
  });

  if (!hit.landed) {
    log(state, actor.id + " misses " + tower.id);
    return;
  }

  enqueuePendingNpcHit(state, {
    id: `npc-target-hit-${actor.id}-${state.tick}-${state.pendingHitSequence + 1}`,
    dueTick: state.tick + 1,
    attackerId: actor.id,
    targetId: tower.id,
    attackerPid: actor.pid,
    targetPid: -1,
    style,
    attackType,
    landed: hit.landed,
    hitChance: hit.hitChance,
    rawDamage: hit.rawDamage,
    createdTick: state.tick
  });
  log(state, hit.landed
    ? actor.id + " queues " + tower.id + " for " + hit.rawDamage
    : actor.id + " misses " + tower.id);
}

function applyConsumableAction(state: SimulationState, actor: PlayerEntity, itemId: string, combo = false): PlayerEntity {
  const item = findConsumable(itemId);
  if (!item || inventoryCount(actor, item.id) <= 0) return actor;

  const isPotion = item.kind === "potion";
  if (isPotion) {
    // Potions use their own repeat-sip timer, but their 3-tick action/eat delay
    // also blocks a normal food consumed immediately afterwards. The reverse
    // order (food -> potion) is legal, which is what enables common NH chains.
    if (combo || state.tick < actor.potionDelayUntilTick) return actor;
  } else {
    if (combo ? !item.comboFood : state.tick < actor.eatDelayUntilTick) return actor;
  }

  const updated = consumeItem(actor, item, state.tick);
  const currentRemaining = Math.max(
    0,
    actor.attackTimer.lastAttackTick +
      actor.attackTimer.weaponCooldownTicks +
      actor.attackTimer.additiveAttackDelayTicks -
      state.tick
  );
  const additive = item.attackDelayTicks;
  const nextFoodDelay = state.tick + item.eatDelayTicks;

  const next: PlayerEntity = {
    ...updated,
    // Potions have zero combat attack delay. Food adds only while an attack
    // cycle is already live, preserving the "eat before attacking" rule.
    attackTimer: isPotion
      ? actor.attackTimer
      : delayAttack(actor.attackTimer, additive, state.tick),
    attackDelayUntilTick: 0,
    // A potion blocks a following normal food until its action delay expires;
    // a food item retains the normal food timer. Combo foods may bypass the
    // preceding food timer, but still establish the next normal-food delay.
    eatDelayUntilTick: isPotion ? Math.max(actor.eatDelayUntilTick, nextFoodDelay) : nextFoodDelay,
    potionDelayUntilTick: isPotion ? nextFoodDelay : actor.potionDelayUntilTick
  };

  log(
    state,
    actor.id + (isPotion ? " drinks " : " eats ") + item.name +
      " (" + additive + "t attack delay; " + currentRemaining + "t attack cycle remaining)"
  );
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

  setPlayer(state, { ...actor, attackType, attackTimer: gateResult.attackTimer, lastCombatTick: state.tick, lastCombatTargetId: camp.id });
  const index = state.jungleCamps.findIndex(candidate => candidate.id === camp.id);
  if (index < 0) return;
  const currentCamp = state.jungleCamps[index];
  enqueuePendingNpcHit(state, {
    id: `npc-target-hit-${actor.id}-${state.tick}-${state.pendingHitSequence + 1}`,
    dueTick: state.tick + 1,
    attackerId: actor.id,
    targetId: currentCamp.id,
    attackerPid: actor.pid,
    targetPid: -1,
    style,
    attackType,
    landed: hit.landed,
    hitChance: hit.hitChance,
    rawDamage: hit.rawDamage,
    createdTick: state.tick
  });
  log(state, hit.landed
    ? actor.id + " queues " + currentCamp.name + " for " + hit.rawDamage
    : actor.id + " misses " + currentCamp.name);
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

  if (victim.activePrayers.includes("retribution")) {
    // Retribution is an area effect: every eligible nearby enemy player can be
    // hit, not just the final killer. The killer is included naturally.
    const retaliation = Math.floor(maxHitpoints(victim.stats) * 0.1);
    const nearby = state.players.filter(player => {
      if (!player.alive || player.team === victim.team) return false;
      const distance = Math.max(
        Math.abs(victim.tile.x - player.tile.x),
        Math.abs(victim.tile.y - player.tile.y)
      );
      return distance <= 15;
    });
    for (const target of nearby) {
      const current = state.players.find(player => player.id === target.id);
      if (!current) continue;
      setPlayer(state, {
        ...current,
        currentHp: Math.max(0, current.currentHp - retaliation)
      });
      log(state, victim.id + " triggers Retribution on " + target.id + " for " + retaliation);
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
    queuedSpecialAttacks: 0,
    queuedSpecialTargetId: undefined,
    specialActive: false,
    gmaulPreloadExpiresAtTick: undefined,
    gmaulEquippedTick: undefined,
    lastGmaulTargetId: undefined,
    lastGmaulAttackTick: -1000,
    vengeanceActive: false,
    vengeanceExpiresAtTick: undefined,
    vengeanceCooldownUntilTick: Math.max(victim.vengeanceCooldownUntilTick, state.tick),
    lastVengeanceCastTick: victim.lastVengeanceCastTick,
    gmaulSpecBarVisibleTick: undefined,
    gmaulPreloaded: false,
    lastCombatTargetId: undefined,
    lastTargetId: undefined,
    lastTargetTimeoutTicks: 0,
    deaths: victim.deaths + 1
  });
}

// --- 4. Effects / economy ---
const effectsStage: TickStage<SimulationState> = {
  name: "effects",
  run: state => {
    const actors = state.playerTurnId
      ? state.players.filter(player => player.id === state.playerTurnId)
      : [...state.players];
    for (const actor of actors) {
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
        specEnergy: updated.lastSpecEnergyUseTick === state.tick
          ? updated.specEnergy
          : Math.min(100, updated.specEnergy + 0.1),
        gp: updated.gp + gpRewards.passivePerTick
      };
      setPlayer(state, updated);
    }
  }
};

// --- Authoritative OSRS-style player turns ---
// A player turn is deliberately ordered: client input -> prayer state ->
// queued impacts -> movement -> attack/combat interaction -> per-player effects.
// The PID order is refreshed once per simulation tick, then remains fixed for
// every player turn in that tick. This is the important distinction from the
// previous globally-staged movement/combat loop: a player that is killed by a
// queued hit never reaches its own combat action later in the same tick.
const playerTurnStage: TickStage<SimulationState> = {
  name: "player-turns",
  run: state => {
    refreshPid(state);
    const orderedIds = [...state.pidOrder].filter(id => state.players.some(player => player.id === id));
    for (const playerId of orderedIds) {
      const player = state.players.find(player => player.id === playerId);
      if (!player || !player.alive) continue;
      state.playerTurnId = playerId;

      prayerStage.run(state);

      const current = state.players.find(actor => actor.id === playerId);
      if (!current || !current.alive) continue;
      resolvePendingHitsForPlayer(state, playerId);
      resolvePendingDeathForPlayer(state, playerId);
      prayerDrainStage.run(state);

      const afterHit = state.players.find(actor => actor.id === playerId);
      if (!afterHit || !afterHit.alive || afterHit.currentHp <= 0) continue;
      movementStage.run(state);

      const afterMovement = state.players.find(actor => actor.id === playerId);
      if (!afterMovement || !afterMovement.alive) continue;

      // The skilling/attack timer is a live countdown. Once the combined
      // weapon + additive food delay expires, the additive portion is consumed
      // before interaction. Otherwise it would incorrectly persist into every
      // later attack cycle.
      const timerReady = consumeExpiredAttackDelay(afterMovement.attackTimer, state.tick);
      if (timerReady.state !== afterMovement.attackTimer) {
        setPlayer(state, { ...afterMovement, attackTimer: timerReady.state });
      }

      combatStage.run(state);
      effectsStage.run(state);
    }
    delete state.playerTurnId;
  }
};

// --- 5. Six lane towers ---
const towerStage: TickStage<SimulationState> = {
  name: "towers",
  run: state => {
    for (const tower of state.towers) {
      if (state.npcTurnId !== undefined && tower.id !== state.npcTurnId) continue;
      const queued = resolvePendingNpcHits(state, tower.id);
      for (const hit of queued) {
        if (!tower.alive || !hit.landed) continue;
        tower.currentHp = Math.max(0, tower.currentHp - hit.rawDamage);
        log(state, `${hit.attackerId} hits ${tower.id} for ${hit.rawDamage}`);
        if (tower.currentHp <= 0) {
          tower.alive = false;
          log(state, tower.id + " falls");
          const enemyTeam = tower.team;
          const remaining = state.towers.some(other => other.alive && other.team === enemyTeam);
          const winner = state.players.find(player => player.id === hit.attackerId);
          if (!remaining && winner) {
            state.matchResult = winner.team;
            log(state, winner.team + " wins the prototype match");
          }
        }
      }
      if (!tower.alive || !canAttackTimer(tower.attackTimer, state.tick)) continue;

      const enemyMinions = state.minions
        .filter(minion => minion.alive && minion.team !== tower.team && minion.laneId === tower.laneId &&
          Math.abs(minion.tile.x - tower.tile.x) <= tower.attackRange)
        .sort((a, b) => Math.abs(a.tile.x - tower.tile.x) - Math.abs(b.tile.x - tower.tile.x));

      const minion = enemyMinions[0];
      if (minion) {
        tower.attackTimer = { ...tower.attackTimer, lastAttackTick: state.tick, weaponCooldownTicks: 5 };
        const damage = Math.floor(state.rng() * (tower.maxHit + 1));
        enqueuePendingNpcHit(state, {
          id: "npc-target-hit-" + tower.id + "-" + state.tick + "-" + (state.pendingHitSequence + 1),
          dueTick: state.tick,
          attackerId: tower.id,
          targetId: minion.id,
          attackerPid: tower.npcId,
          targetPid: minion.npcId,
          style: "crush",
          attackType: "accurate",
          landed: true,
          hitChance: 1,
          rawDamage: damage,
          createdTick: state.tick
        });
        log(state, tower.id + " queues " + minion.id + " for " + damage + " damage");
        continue;
      }

      const target = state.players.find(player =>
        player.alive && player.team !== tower.team && player.laneId === tower.laneId &&
        Math.abs(player.tile.x - tower.tile.x) <= tower.attackRange
      );
      if (!target) continue;

      tower.attackTimer = { ...tower.attackTimer, lastAttackTick: state.tick, weaponCooldownTicks: 5 };
      const damage = Math.floor(state.rng() * (tower.maxHit + 1));
      enqueuePendingHit(state, {
        id: `npc-hit-${tower.id}-${state.tick}-${state.pendingHitSequence + 1}`,
        dueTick: state.tick,
        attackerId: tower.id,
        targetId: target.id,
        attackerPid: -1,
        targetPid: target.pid,
        style: "crush",
        attackType: "accurate",
        landed: true,
        hitChance: 1,
        rawDamage: damage,
        createdTick: state.tick
      });
      log(state, `${tower.id} queues ${target.id} for ${damage} damage`);
    }
  }
};

function canAttackTimer(timer: { lastAttackTick: number; weaponCooldownTicks: number }, tick: number): boolean {
  return tick - timer.lastAttackTick >= timer.weaponCooldownTicks;
}

// --- 6. Minion waves in all lanes ---
function spawnMinionsIfDue(state: SimulationState): void {
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
              npcId: nextNpcId(),
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
}

const minionStage: TickStage<SimulationState> = {
  name: "minions",
  run: state => {
    const alive = state.minions.filter(minion => minion.alive);
    const sorted = [...alive].sort((a, b) => a.pid - b.pid);

    for (const minion of sorted) {
      if (state.npcTurnId !== undefined && minion.id !== state.npcTurnId) continue;
      const queued = resolvePendingNpcHits(state, minion.id);
      for (const hit of queued) {
        if (!minion.alive || !hit.landed) continue;
        minion.currentHp = Math.max(0, minion.currentHp - hit.rawDamage);
        log(state, `${hit.attackerId} hits ${minion.id} for ${hit.rawDamage}`);
        if (minion.currentHp <= 0) {
          minion.alive = false;
          const killer = state.players.find(player => player.id === hit.attackerId && player.alive);
          if (killer) {
            setPlayer(state, {
              ...killer,
              gp: killer.gp + gpRewards.minionKill,
              stats: grantUnallocatedXp(killer.stats, xpRewards.minionKill)
            });
          }
          log(state, `${minion.id} is destroyed`);
        }
      }
      if (!minion.alive) continue;

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
            enqueuePendingHit(state, {
              id: `npc-hit-${minion.id}-${state.tick}-${state.pendingHitSequence + 1}`,
              dueTick: state.tick,
              attackerId: minion.id,
              targetId: currentTarget.id,
              attackerPid: minion.pid,
              targetPid: currentTarget.pid,
              style: minion.style,
              attackType: "accurate",
              landed: true,
              hitChance: 1,
              rawDamage: damage,
              createdTick: state.tick
            });
            log(state, `${minion.id} queues ${currentTarget.id} for ${damage} damage`);
          } else {
            enqueuePendingNpcHit(state, {
              id: `npc-target-hit-${minion.id}-${state.tick}-${state.pendingHitSequence + 1}`,
              dueTick: state.tick,
              attackerId: minion.id,
              targetId: target.entity.id,
              attackerPid: minion.pid,
              targetPid: -1,
              style: minion.style,
              attackType: "accurate",
              landed: true,
              hitChance: 1,
              rawDamage: damage,
              createdTick: state.tick
            });
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
      if (state.npcTurnId !== undefined && state.jungleCamps[index].id !== state.npcTurnId) continue;
      let camp = state.jungleCamps[index];
      const queued = resolvePendingNpcHits(state, camp.id);
      for (const hit of queued) {
        if (!camp.alive || !hit.landed) continue;
        camp = { ...camp, currentHp: Math.max(0, camp.currentHp - hit.rawDamage), aggroTargetId: hit.attackerId };
        log(state, `${hit.attackerId} hits ${camp.name} for ${hit.rawDamage}`);
        if (camp.currentHp <= 0) {
          camp = {
            ...camp,
            currentHp: 0,
            alive: false,
            aggroTargetId: undefined,
            respawnAtTick: state.tick + camp.respawnTicks
          };
          const rewardPlayer = state.players.find(player => player.id === hit.attackerId && player.alive);
          if (rewardPlayer) {
            setPlayer(state, {
              ...rewardPlayer,
              gp: rewardPlayer.gp + camp.rewardGp,
              stats: grantUnallocatedXp(rewardPlayer.stats, camp.rewardXp)
            });
            if (camp.id === "river-chaos-elemental") {
              state.teamBuffs[rewardPlayer.team] = {
                name: "Elemental surge",
                expiresAtTick: state.tick + 100,
                damageMultiplier: 1.10
              };
            }
          }
          log(state, `${camp.name} is cleared`);
        }
      }
      state.jungleCamps[index] = camp;

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
      enqueuePendingHit(state, {
        id: `npc-hit-${camp.id}-${state.tick}-${state.pendingHitSequence + 1}`,
        dueTick: state.tick,
        attackerId: camp.id,
        targetId: target.id,
        attackerPid: -1,
        targetPid: target.pid,
        style: camp.style,
        attackType: "accurate",
        landed: hit.landed,
        hitChance: hit.landed ? 1 : 0,
        rawDamage: hit.rawDamage,
        createdTick: state.tick
      });
      log(state, hit.landed ? camp.name + " queues " + target.id + " for " + hit.rawDamage : camp.name + " misses " + target.id);
    }
  }
};
// --- Authoritative NPC turns ---
// Henke's model places NPC processing before the PID-ordered player turns.
// Keeping the lane/jungle actors in one explicit stage makes the ordering
// visible and prevents a world actor from being accidentally processed after
// one player but before another player in the same server tick.
const npcTurnStage: TickStage<SimulationState> = {
  name: "npc-turns",
  run: state => {
    spawnMinionsIfDue(state);

    const npcs = [
      ...state.towers.map(npc => ({ id: npc.id, npcId: npc.npcId })),
      ...state.minions.map(npc => ({ id: npc.id, npcId: npc.npcId })),
      ...state.jungleCamps.map(npc => ({ id: npc.id, npcId: npc.npcId }))
    ].sort((a, b) => a.npcId - b.npcId);

    for (const npc of npcs) {
      state.npcTurnId = npc.id;
      towerStage.run(state);
      minionStage.run(state);
      jungleStage.run(state);
    }
    delete state.npcTurnId;
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
  npcTurnStage,
  playerTurnStage,
  pendingHitStage,
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
