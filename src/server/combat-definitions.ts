export type AttackType = "melee" | "ranged" | "magic";
export type MeleeAttackStyle = "accurate" | "aggressive" | "defensive" | "controlled";
export type MeleeAttackType = "stab" | "slash" | "crush";
export interface CombatStance { name: string; attackType: MeleeAttackType; style: MeleeAttackStyle; }

export interface AmmoDefinition { id:string; rangedStrength:number; projectileSpeed:number; }
export interface SpellDefinition { id:string; maxHit:number; attackSpeed:number; attackRange:number; magicAttackBonus:number; runes:Record<string,number>; projectileSpeed:number; }

export interface WeaponDefinition {
  id: string;
  attackSpeed: number;
  attackRange: number;
  attackType: AttackType;
  attackBonus: number;
  strengthBonus: number;
  rangedStrengthBonus?: number;
  magicAttackBonus?: number;
  projectileSpeed?: number;
  specialCost: number;
  specialMultiplier: number;
  slashBonus?: number;
  stabBonus?: number;
  crushBonus?: number;
  stances: CombatStance[];
}

export const AMMUNITION: Record<string, AmmoDefinition> = {
  bronze_arrow:{id:"bronze_arrow",rangedStrength:7,projectileSpeed:10},
};

export const SPELLS: Record<string, SpellDefinition> = {
  fire_strike:{id:"fire_strike",maxHit:8,attackSpeed:5,attackRange:10,magicAttackBonus:0,runes:{fire_rune:1,air_rune:3},projectileSpeed:10},
};

export const WEAPONS: Record<string, WeaponDefinition> = {
  shortbow: { id:"shortbow", attackSpeed:4, attackRange:8, attackType:"ranged", attackBonus:29, strengthBonus:10, rangedStrengthBonus:7, projectileSpeed:10, specialCost:100, specialMultiplier:1.0, stances:[] },
  fire_strike: { id:"fire_strike", attackSpeed:5, attackRange:10, attackType:"magic", attackBonus:0, strengthBonus:0, magicAttackBonus:0, specialCost:0, specialMultiplier:1.0, stances:[] },
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
    stances: [
      { name: "Chop", attackType: "slash", style: "accurate" },
      { name: "Slash", attackType: "slash", style: "aggressive" },
      { name: "Lunge", attackType: "stab", style: "controlled" },
      { name: "Block", attackType: "slash", style: "defensive" },
    ],
  },
};

export const MELEE_STYLE_BONUS: Record<MeleeAttackStyle, { attack: number; strength: number; defence: number }> = {
  accurate: { attack: 3, strength: 0, defence: 0 },
  aggressive: { attack: 0, strength: 3, defence: 0 },
  defensive: { attack: 0, strength: 0, defence: 3 },
  controlled: { attack: 1, strength: 1, defence: 1 },
};

export function weaponStance(weapon: WeaponDefinition, style: MeleeAttackStyle): CombatStance {
  return weapon.stances.find(s => s.style === style) ?? weapon.stances[0];
}

export function weaponAttackBonus(weapon: WeaponDefinition, style: MeleeAttackStyle): number {
  const type = weaponStance(weapon, style).attackType;
  if (type === "stab") return weapon.stabBonus ?? weapon.attackBonus;
  if (type === "crush") return weapon.crushBonus ?? weapon.attackBonus;
  return weapon.slashBonus ?? weapon.attackBonus;
}
