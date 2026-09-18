import type { BonusTable, CombatStyle } from "../combat/formulas";
import { zeroBonuses } from "../combat/formulas";

export type ShopSlot = "weapon" | "shield" | "body" | "legs" | "head" | "cape" | "amulet" | "ring";

export interface ShopItem {
  readonly id: string;
  readonly name: string;
  readonly cost: number;
  readonly slot: ShopSlot;
  readonly style?: CombatStyle;
  readonly cooldownTicks?: number;
  readonly attackRange?: number;
  readonly twoHanded?: boolean;
  readonly bonuses: Partial<BonusTable>;
  readonly special?: { readonly energyCost: number; readonly damageMultiplier: number; readonly accuracyMultiplier: number };
}

/** Small starting itemisation. Extend this list progressively per the design doc. */
export const shopCatalog: readonly ShopItem[] = [
  // Melee
  { id: "rune_scimitar", name: "Rune scimitar", cost: 150, slot: "weapon", style: "slash", cooldownTicks: 4, attackRange: 1, bonuses: { slash_attack_bonus: 45, melee_strength_bonus: 44 } },
  { id: "abyssal_whip", name: "Abyssal whip", cost: 600, slot: "weapon", style: "slash", cooldownTicks: 4, attackRange: 1, bonuses: { slash_attack_bonus: 82, melee_strength_bonus: 82 } },
  { id: "dragon_claws", name: "Dragon claws", cost: 1400, slot: "weapon", style: "slash", cooldownTicks: 4, attackRange: 1, bonuses: { slash_attack_bonus: 65, melee_strength_bonus: 61 },
    special: { energyCost: 50, damageMultiplier: 2.5, accuracyMultiplier: 1.2 } },
  { id: "armadyl_godsword", name: "Armadyl godsword", cost: 1600, slot: "weapon", style: "slash", cooldownTicks: 6, attackRange: 1, twoHanded: true, bonuses: { slash_attack_bonus: 132, melee_strength_bonus: 114 },
    special: { energyCost: 50, damageMultiplier: 1.375, accuracyMultiplier: 1.375 } },
  { id: "rune_defender", name: "Rune defender", cost: 120, slot: "shield", bonuses: { stab_defence_bonus: 24, slash_defence_bonus: 24, crush_defence_bonus: 24, melee_strength_bonus: 6 } },
  { id: "fighter_torso", name: "Fighter torso", cost: 250, slot: "body", bonuses: { stab_defence_bonus: 24, slash_defence_bonus: 25, crush_defence_bonus: 26, melee_strength_bonus: 4 } },
  { id: "rune_platelegs", name: "Rune platelegs", cost: 180, slot: "legs", bonuses: { stab_defence_bonus: 31, slash_defence_bonus: 29, crush_defence_bonus: 28 } },
  { id: "berserker_helm", name: "Berserker helm", cost: 130, slot: "head", bonuses: { melee_strength_bonus: 4, stab_defence_bonus: 9, slash_defence_bonus: 9, crush_defence_bonus: 9 } },
  // Ranged
  { id: "magic_shortbow", name: "Magic shortbow", cost: 200, slot: "weapon", style: "ranged", cooldownTicks: 4, attackRange: 7, bonuses: { range_attack_bonus: 69 } },
  { id: "toxic_blowpipe", name: "Toxic blowpipe", cost: 1500, slot: "weapon", style: "ranged", cooldownTicks: 2, attackRange: 5, bonuses: { range_attack_bonus: 30, ranged_strength_bonus: 30 } },
  { id: "armadyl_crossbow", name: "Armadyl crossbow", cost: 1700, slot: "weapon", style: "ranged", cooldownTicks: 6, attackRange: 8, bonuses: { range_attack_bonus: 94, ranged_strength_bonus: 5 },
    special: { energyCost: 40, damageMultiplier: 1.1, accuracyMultiplier: 1.5 } },
  { id: "black_dhide_body", name: "Black d'hide body", cost: 220, slot: "body", bonuses: { range_defence_bonus: 65 } },
  { id: "archer_helm", name: "Archer helm", cost: 130, slot: "head", bonuses: { range_attack_bonus: 3, ranged_strength_bonus: 6 } },
  // Magic
  { id: "ancient_staff", name: "Ancient staff", cost: 250, slot: "weapon", style: "magic", cooldownTicks: 5, attackRange: 6, bonuses: { magic_attack_bonus: 15 } },
  { id: "kodai_wand", name: "Kodai wand", cost: 1800, slot: "weapon", style: "magic", cooldownTicks: 5, attackRange: 6, bonuses: { magic_attack_bonus: 27, magic_damage_bonus: 15 } },
  { id: "mystic_robe_top", name: "Mystic robe top", cost: 200, slot: "body", bonuses: { magic_attack_bonus: 6, magic_defence_bonus: 8 } },
  { id: "ancestral_hat", name: "Ancestral hat", cost: 900, slot: "head", bonuses: { magic_attack_bonus: 3, magic_damage_bonus: 6 } },
  // Utility
  { id: "amulet_of_glory", name: "Amulet of glory", cost: 90, slot: "amulet", bonuses: { stab_attack_bonus: 10, slash_attack_bonus: 10, crush_attack_bonus: 10, range_attack_bonus: 10, magic_attack_bonus: 10, melee_strength_bonus: 3 } },
  { id: "berserker_ring", name: "Berserker ring", cost: 200, slot: "ring", bonuses: { melee_strength_bonus: 4 } }
];

export interface ConsumableDef {
  readonly id: string;
  readonly name: string;
  readonly cost: number;
  readonly healAmount?: number;
  readonly restorePrayer?: number;
  readonly attackDelayTicks: number; // ticks lost from the attack cycle when eaten (OSRS: food=3, karambwan=2/1)
  readonly boostStat?: { readonly style: CombatStyle | "prayer"; readonly amount: number; readonly durationTicks: number };
}

export const consumableCatalog: readonly ConsumableDef[] = [
  { id: "shark", name: "Shark", cost: 60, healAmount: 20, attackDelayTicks: 3 },
  { id: "anglerfish", name: "Anglerfish", cost: 90, healAmount: 22, attackDelayTicks: 3 },
  { id: "karambwan", name: "Karambwan", cost: 70, healAmount: 18, attackDelayTicks: 2 },
  { id: "prayer_potion", name: "Prayer potion", cost: 80, restorePrayer: 24, attackDelayTicks: 3 },
  { id: "super_restore", name: "Super restore", cost: 110, restorePrayer: 25, attackDelayTicks: 3 },
  { id: "super_combat_potion", name: "Super combat potion", cost: 100, attackDelayTicks: 3, boostStat: { style: "slash", amount: 0.19, durationTicks: 500 } },
  { id: "ranging_potion", name: "Ranging potion", cost: 100, attackDelayTicks: 3, boostStat: { style: "ranged", amount: 0.15, durationTicks: 500 } },
  { id: "magic_potion", name: "Magic potion", cost: 100, attackDelayTicks: 3, boostStat: { style: "magic", amount: 0.15, durationTicks: 500 } }
];

/** GP income sources, tunable independently of combat balance. */
export const gpRewards = {
  minionKill: 25,
  playerKill: 150,
  playerAssist: 60,
  towerDestroy: 300,
  jungleCampClear: 120,
  passivePerTick: 1
};

/** Unallocated combat-XP rewards (spent via stats.ts investXp). */
export const xpRewards = {
  minionKill: 40,
  playerKill: 300,
  playerAssist: 120,
  towerDestroy: 500,
  jungleCampClear: 220
};

export function emptyEquipmentBonuses(): BonusTable {
  return { ...zeroBonuses };
}
