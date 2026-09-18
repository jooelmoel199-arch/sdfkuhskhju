import type { EntityLockState } from "../entity/locks";
import { createEntityLockState } from "../entity/locks";
import type { AttackTimerState } from "../combat/timers";
import { createAttackTimerState } from "../combat/timers";
import type { TilePosition } from "../world/movement";
import type { PrayerId } from "../prayer/prayers";
import type { LaneId } from "./lane";
import type { StatBlock } from "./stats";
import { createStatBlock, maxHitpoints } from "./stats";
import type { BonusTable, CombatLevels, CombatStyle } from "../combat/formulas";
import { emptyEquipmentBonuses } from "./economy";
import type { ShopItem, ConsumableDef } from "./economy";

export type Team = "blue" | "red";
export type ZoneKind = "lane" | "river" | "jungle" | "base";
export type PlayerRole = "top" | "jungle" | "middle" | "bottom" | "support";

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

export type AttackType = "accurate" | "aggressive" | "controlled" | "rapid_ranged" | "long_ranged";

export interface PlayerEntity {
  readonly id: string;
  readonly kind: "player";
  readonly team: Team;
  readonly laneId: LaneId;
  readonly role: PlayerRole;
  readonly pid: number; // deterministic per-tick processing order
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
  specEnergy: number;
  locks: EntityLockState;
  attackTimer: AttackTimerState;
  statusEffects: StatusEffect[];
  attackDelayUntilTick: number; // from eating, blocks attacking but not the underlying weapon cooldown
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
    prayerPoints: 30,
    specEnergy: 100,
    locks: createEntityLockState(),
    attackTimer: createAttackTimerState(),
    statusEffects: [],
    attackDelayUntilTick: 0,
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
  const prayerPoints = item.restorePrayer ? player.prayerPoints + item.restorePrayer : player.prayerPoints;
  const statusEffects = item.boostStat
    ? [...player.statusEffects, { ...item.boostStat, expiresAtTick: currentTick + item.boostStat.durationTicks }]
    : player.statusEffects;
  const inventory = player.inventory
    .map(entry => entry.id === item.id ? { ...entry, quantity: entry.quantity - 1 } : entry)
    .filter(entry => entry.quantity > 0);
  return { ...player, inventory, currentHp, prayerPoints, statusEffects };
}
