import type { EntityLockState } from "../entity/locks";
import { createEntityLockState } from "../entity/locks";
import type { AttackTimerState } from "../combat/timers";
import { createAttackTimerState } from "../combat/timers";
import type { TilePosition } from "../world/movement";
import type { PrayerId } from "../prayer/prayers";
import type { LaneId } from "./lane";
import type { PendingHit } from "../combat/pendingHits";
import type { StatBlock } from "./stats";
import { createStatBlock, levelOf, maxHitpoints, maxPrayerPoints } from "./stats";
import type { BonusTable, CombatLevels, CombatStyle } from "../combat/formulas";
import { emptyEquipmentBonuses } from "./economy";
import type { ShopItem, ConsumableDef } from "./economy";
import { shopCatalog } from "./economy";

export type Team = "blue" | "red";
export type ZoneKind = "lane" | "river" | "jungle" | "base";
export type PlayerRole = "top" | "jungle" | "middle" | "bottom" | "support";

export interface CombatBoostState {
  readonly attack: number;
  readonly strength: number;
  readonly defence: number;
  readonly ranged: number;
  readonly magic: number;
  /** Next one-point decay boundary. OSRS temporary stat boosts decay once per 60 seconds. */
  readonly nextDecayTick: number;
}

export interface StatusEffect {
  readonly style: CombatStyle | "prayer";
  readonly amount: number;
  readonly expiresAtTick: number;
}

export interface InventoryEntry {
  readonly id: string;
  readonly quantity: number;
}

export interface Equipment {
  weapon?: ShopItem;
  shield?: ShopItem;
  body?: ShopItem;
  legs?: ShopItem;
  head?: ShopItem;
  amulet?: ShopItem;
  ring?: ShopItem;
  cape?: ShopItem;
}

export type AttackType = "accurate" | "aggressive" | "defensive" | "controlled" | "rapid_ranged" | "long_ranged";

export interface PlayerEntity {
  readonly id: string;
  readonly kind: "player";
  readonly team: Team;
  readonly laneId: LaneId;
  readonly role: PlayerRole;
  readonly pid: number; // stable entity identity; PvP processing priority is maintained by SimulationState
  tile: TilePosition;
  zone: ZoneKind;
  currentHp: number;
  stats: StatBlock;
  gp: number;
  inventory: InventoryEntry[];
  equipment: Equipment;
  activePrayers: PrayerId[];
  attackType: AttackType;
  prayerPoints: number;
  prayerDrainAccumulator: number;
  specEnergy: number;
  combatBoosts: CombatBoostState;
  locks: EntityLockState;
  attackTimer: AttackTimerState;
  statusEffects: StatusEffect[];
  attackDelayUntilTick: number; // from eating, blocks attacking but not the underlying weapon cooldown
  eatDelayUntilTick: number; // food consumption timer; potions use a separate timer
  potionDelayUntilTick: number; // non-barbarian potion consumption timer
  /** Discrete client commands waiting to be consumed by the combat interaction. */
  queuedSpecialAttacks: number;
  queuedSpecialTargetId?: string;
  specialActive: boolean;
  gmaulEquippedTick?: number;
  gmaulSpecBarVisibleTick?: number;
  gmaulPreloaded: boolean;
  gmaulPreloadExpiresAtTick?: number;
  lastCombatTargetId?: string;
  lastTargetId?: string;
  lastTargetTimeoutTicks: number;
  lastGmaulTargetId?: string;
  lastGmaulAttackTick: number;
  vengeanceActive: boolean;
  vengeanceCooldownUntilTick: number;
  vengeanceExpiresAtTick?: number;
  lastVengeanceCastTick: number;
  lastSpecEnergyUseTick: number;
  lastPrayerToggleTick: number;
  lastCombatTick: number; // for PJ/engagement timer + assist windows
  lastDamagedByPlayerId?: string;
  alive: boolean;
  respawnAtTick?: number;
  kills: number;
  deaths: number;
}

export interface MinionEntity {
  readonly id: string;
  readonly kind: "minion";
  readonly npcId: number;
  readonly team: Team;
  readonly laneId: LaneId;
  readonly pid: number;
  tile: TilePosition;
  currentHp: number;
  maxHp: number;
  attackBonus: number;
  maxHit: number;
  style: CombatStyle;
  attackTimer: AttackTimerState;
  targetId?: string;
  alive: boolean;
}

export interface ProjectileEntity {
  readonly id: string;
  readonly kind: "projectile";
  readonly attackerId: string;
  readonly targetId: string;
  readonly style: CombatStyle;
  readonly attackType: AttackType;
  readonly attackerLevels: CombatLevels;
  readonly attackerBonuses: BonusTable;
  readonly attackBoostMultiplier: number;
  readonly strengthBoostMultiplier: number;
  readonly damageMultiplier: number;
  readonly accuracyMultiplier: number;
  readonly createdTick: number;
  readonly hitTick: number;
  readonly fromTile: TilePosition;
  readonly toTile: TilePosition;
}
export interface NeutralCampEntity {
  readonly id: string;
  readonly kind: "neutral_camp";
  readonly npcId: number;
  readonly name: string;
  readonly tile: TilePosition;
  currentHp: number;
  readonly maxHp: number;
  readonly maxHit: number;
  readonly attackRange: number;
  attackTimer: AttackTimerState;
  readonly combatLevels: CombatLevels;
  readonly bonuses: BonusTable;
  readonly style: CombatStyle;
  readonly rewardGp: number;
  readonly rewardXp: number;
  readonly respawnTicks: number;
  respawnAtTick?: number;
  alive: boolean;
  aggroTargetId?: string;
}
export interface TowerEntity {
  readonly id: string;
  readonly kind: "tower";
  readonly npcId: number;
  readonly team: Team;
  readonly laneId: LaneId;
  readonly tile: TilePosition;
  currentHp: number;
  maxHp: number;
  attackBonus: number;
  maxHit: number;
  attackRange: number;
  attackTimer: AttackTimerState;
  alive: boolean;
}

let pidCounter = 0;
export function nextPid(): number {
  pidCounter += 1;
  return pidCounter;
}

let npcIdCounter = 0;
export function nextNpcId(): number {
  npcIdCounter += 1;
  return npcIdCounter;
}

export function createPlayer(
  id: string,
  team: Team,
  spawnTile: TilePosition,
  laneId: LaneId = "middle",
  role: PlayerRole = "middle"
): PlayerEntity {
  const stats = createStatBlock();
  return {
    id,
    kind: "player",
    team,
    laneId,
    role,
    pid: nextPid(),
    tile: spawnTile,
    zone: "base",
    currentHp: maxHitpoints(stats),
    stats,
    gp: 0,
    inventory: [],
    equipment: {},
    activePrayers: [],
    attackType: "accurate",
    prayerPoints: maxPrayerPoints(stats),
    prayerDrainAccumulator: 0,
    specEnergy: 100,
    combatBoosts: {
      attack: 0,
      strength: 0,
      defence: 0,
      ranged: 0,
      magic: 0,
      nextDecayTick: 0
    },
    locks: createEntityLockState(),
    attackTimer: createAttackTimerState(),
    statusEffects: [],
    attackDelayUntilTick: 0,
    eatDelayUntilTick: 0,
    potionDelayUntilTick: 0,
    queuedSpecialAttacks: 0,
    queuedSpecialTargetId: undefined,
    specialActive: false,
    gmaulEquippedTick: undefined,
    gmaulSpecBarVisibleTick: undefined,
    gmaulPreloaded: false,
    gmaulPreloadExpiresAtTick: undefined,
    lastCombatTargetId: undefined,
    lastTargetId: undefined,
    lastTargetTimeoutTicks: 0,
    lastGmaulTargetId: undefined,
    lastGmaulAttackTick: -1000,
    vengeanceActive: false,
    vengeanceCooldownUntilTick: 0,
    vengeanceExpiresAtTick: undefined,
    lastVengeanceCastTick: -1000,
    lastSpecEnergyUseTick: -1000,
    lastPrayerToggleTick: -1000,
    lastCombatTick: -1000,
    alive: true,
    kills: 0,
    deaths: 0
  };
}

export function equipmentBonuses(equipment: Equipment): BonusTable {
  const rows = Object.values(equipment).filter((item): item is ShopItem => item !== undefined);
  const total = emptyEquipmentBonuses() as Record<string, number>;
  for (const item of rows) {
    for (const [key, value] of Object.entries(item.bonuses)) {
      total[key] = (total[key] ?? 0) + (value ?? 0);
    }
  }
  return total as BonusTable;
}

export function equipItem(player: PlayerEntity, item: ShopItem): PlayerEntity {
  const equipment: Equipment = { ...player.equipment, [item.slot]: item };
  if (item.slot === "weapon" && item.twoHanded) {
    equipment.shield = undefined;
  }
  return { ...player, gp: player.gp - item.cost, equipment };
}

export function equipOwnedItem(player: PlayerEntity, itemId: string): PlayerEntity {
  const item = shopCatalog.find(candidate => candidate.id === itemId);
  if (!item || inventoryCount(player, itemId) <= 0) return player;

  let inventory = player.inventory
    .map(entry => entry.id === itemId ? { ...entry, quantity: entry.quantity - 1 } : entry)
    .filter(entry => entry.quantity > 0);
  let equipment: Equipment = { ...player.equipment };

  const displaced = equipment[item.slot];
  if (displaced) {
    inventory = inventory.some(entry => entry.id === displaced.id)
      ? inventory.map(entry => entry.id === displaced.id ? { ...entry, quantity: entry.quantity + 1 } : entry)
      : [...inventory, { id: displaced.id, quantity: 1 }];
  }

  if (item.twoHanded && equipment.shield) {
    const shield = equipment.shield;
    inventory = inventory.some(entry => entry.id === shield.id)
      ? inventory.map(entry => entry.id === shield.id ? { ...entry, quantity: entry.quantity + 1 } : entry)
      : [...inventory, { id: shield.id, quantity: 1 }];
    equipment = { ...equipment, shield: undefined };
  }

  equipment = { ...equipment, [item.slot]: item };
  const supportedStyles = item.attackTypes ?? ["accurate"];
  const attackType = item.defaultAttackType && supportedStyles.includes(item.defaultAttackType)
    ? item.defaultAttackType
    : supportedStyles.includes(player.attackType) ? player.attackType : supportedStyles[0];
  return { ...player, inventory, equipment, attackType };
}

export function inventoryCount(player: PlayerEntity, itemId: string): number {
  return player.inventory.find(entry => entry.id === itemId)?.quantity ?? 0;
}

export function addInventoryItem(player: PlayerEntity, itemId: string, quantity = 1): PlayerEntity {
  if (quantity <= 0) return player;
  const existing = inventoryCount(player, itemId);
  const inventory = existing > 0
    ? player.inventory.map(entry => entry.id === itemId ? { ...entry, quantity: entry.quantity + quantity } : entry)
    : [...player.inventory, { id: itemId, quantity }];
  return { ...player, inventory };
}

export function consumeItem(player: PlayerEntity, item: ConsumableDef, currentTick: number): PlayerEntity {
  if (inventoryCount(player, item.id) <= 0) return player;
  const maxHp = maxHitpoints(player.stats);
  const currentHp = item.healAmount ? Math.min(maxHp, player.currentHp + item.healAmount) : player.currentHp;
  const prayerPoints = item.restorePrayer ? Math.min(maxPrayerPoints(player.stats), player.prayerPoints + item.restorePrayer) : player.prayerPoints;
  const inventory = player.inventory
    .map(entry => entry.id === item.id ? { ...entry, quantity: entry.quantity - 1 } : entry)
    .filter(entry => entry.quantity > 0);
  return { ...player, inventory, currentHp, prayerPoints };
}
