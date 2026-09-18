export type AttackType = "melee" | "ranged" | "magic";
export type MeleeAttackStyle = "accurate" | "aggressive" | "defensive" | "controlled";

export interface WeaponDefinition {
  id: string;
  attackSpeed: number;
  attackRange: number;
  attackType: AttackType;
  attackBonus: number;
  strengthBonus: number;
  specialCost: number;
  specialMultiplier: number;
  slashBonus?: number;
  stabBonus?: number;
  crushBonus?: number;
}

export const WEAPONS: Record<string, WeaponDefinition> = {
  rune_scimitar: {
    id: "rune_scimitar",
    attackSpeed: 4,
    attackRange: 1,
    attackType: "melee",
    attackBonus: 45,
    strengthBonus: 44,
    specialCost: 50,
    specialMultiplier: 1.25,
    slashBonus: 45,
    stabBonus: 7,
    crushBonus: -2,
  },
};

export const MELEE_STYLE_BONUS: Record<MeleeAttackStyle, { attack: number; strength: number; defence: number }> = {
  accurate: { attack: 3, strength: 0, defence: 0 },
  aggressive: { attack: 0, strength: 3, defence: 0 },
  defensive: { attack: 0, strength: 0, defence: 3 },
  controlled: { attack: 1, strength: 1, defence: 1 },
};

export function weaponAttackBonus(weapon: WeaponDefinition, style: MeleeAttackStyle): number {
  // A weapon's stance selects the relevant melee accuracy bonus. The prototype
  // currently models the common slash stance used by the rune scimitar.
  if (style === "aggressive" || style === "defensive" || style === "controlled") {
    return weapon.slashBonus ?? weapon.attackBonus;
  }
  return weapon.slashBonus ?? weapon.attackBonus;
}
