export type CombatStyle = "stab" | "slash" | "crush" | "magic" | "ranged";

export type BonusKey =
  | "stab_attack_bonus"
  | "slash_attack_bonus"
  | "crush_attack_bonus"
  | "magic_attack_bonus"
  | "range_attack_bonus"
  | "stab_defence_bonus"
  | "slash_defence_bonus"
  | "crush_defence_bonus"
  | "magic_defence_bonus"
  | "range_defence_bonus"
  | "melee_strength_bonus"
  | "ranged_strength_bonus"
  | "magic_damage_bonus"
  | "prayer_bonus";

export type BonusTable = Readonly<Record<BonusKey, number>>;

export interface CombatLevels {
  readonly attack: number;
  readonly strength: number;
  readonly defence: number;
  readonly ranged: number;
  readonly magic: number;
}

export interface StyleEvInput {
  readonly style: CombatStyle;
  readonly attackerLevels: CombatLevels;
  readonly defenderLevels: CombatLevels;
  readonly attackerBonuses: BonusTable;
  readonly defenderBonuses: BonusTable;
  readonly attackType?: "accurate" | "aggressive" | "controlled" | "rapid_ranged" | "long_ranged";
  readonly attackBoostMultiplier?: number;
  readonly defenceBoostMultiplier?: number;
  readonly magicDefenceBoostMultiplier?: number;
  readonly strengthBoostMultiplier?: number;
  readonly accuracyModifier?: number;
  readonly maxMagicDamage?: number;
}

export interface StyleEvEstimate {
  readonly style: CombatStyle;
  readonly attackRoll: number;
  readonly defenceRoll: number;
  readonly hitChance: number;
  readonly maxDamage: number;
  readonly expectedDamage: number;
}

export const zeroBonuses: BonusTable = {
  stab_attack_bonus: 0,
  slash_attack_bonus: 0,
  crush_attack_bonus: 0,
  magic_attack_bonus: 0,
  range_attack_bonus: 0,
  stab_defence_bonus: 0,
  slash_defence_bonus: 0,
  crush_defence_bonus: 0,
  magic_defence_bonus: 0,
  range_defence_bonus: 0,
  melee_strength_bonus: 0,
  ranged_strength_bonus: 0,
  magic_damage_bonus: 0,
  prayer_bonus: 0
};

export const NH_PVP_MAGIC_ACCURACY_MODIFIER = 1.22;
export const NH_PVP_MELEE_ACCURACY_MODIFIER = 1.12;

export function aggregateBonuses(items: readonly { readonly bonuses: Partial<BonusTable> }[]): BonusTable {
  const total: Record<BonusKey, number> = { ...zeroBonuses };

  for (const item of items) {
    for (const key of Object.keys(zeroBonuses) as BonusKey[]) {
      total[key] += item.bonuses[key] ?? 0;
    }
  }

  return total;
}

export function attackBonusKey(style: CombatStyle): BonusKey {
  if (style === "ranged") {
    return "range_attack_bonus";
  }
  if (style === "magic") {
    return "magic_attack_bonus";
  }
  return `${style}_attack_bonus` as BonusKey;
}

export function defenceBonusKey(style: CombatStyle): BonusKey {
  if (style === "ranged") {
    return "range_defence_bonus";
  }
  if (style === "magic") {
    return "magic_defence_bonus";
  }
  return `${style}_defence_bonus` as BonusKey;
}

export function effectiveAttackLevel(
  levels: CombatLevels,
  style: CombatStyle,
  attackType: StyleEvInput["attackType"] = "accurate",
  multiplier = 1
): number {
  const base = style === "ranged" ? levels.ranged : style === "magic" ? levels.magic : levels.attack;
  return base * multiplier + accuracyStyleBonus(style, attackType) + 8;
}

export function effectiveDefenceLevel(
  levels: CombatLevels,
  style: CombatStyle,
  attackType: StyleEvInput["attackType"] = "accurate",
  defenceMultiplier = 1,
  magicMultiplier = 1
): number {
  const defenceLevel = levels.defence * defenceMultiplier + defenceStyleBonus(attackType) + 8;
  if (style === "magic") {
    return defenceLevel * 0.3 + levels.magic * magicMultiplier * 0.7;
  }
  return defenceLevel;
}

export function attackRoll(
  levels: CombatLevels,
  bonuses: BonusTable,
  style: CombatStyle,
  attackType: StyleEvInput["attackType"] = "accurate",
  multiplier = 1
): number {
  return effectiveAttackLevel(levels, style, attackType, multiplier) * (bonuses[attackBonusKey(style)] + 64);
}

export function defenceRoll(
  levels: CombatLevels,
  bonuses: BonusTable,
  style: CombatStyle,
  attackType: StyleEvInput["attackType"] = "accurate",
  defenceMultiplier = 1,
  magicMultiplier = 1
): number {
  return (
    effectiveDefenceLevel(levels, style, attackType, defenceMultiplier, magicMultiplier) *
    (bonuses[defenceBonusKey(style)] + 64)
  );
}

export function hitChance(attack: number, defence: number): number {
  if (attack <= 0) {
    return 0;
  }
  if (attack > defence) {
    return clamp01(1 - (defence + 2) / (2 * (attack + 1)));
  }
  return clamp01(attack / (2 * (defence + 1)));
}

export function maxDamage(input: StyleEvInput): number {
  if (input.style === "magic") {
    const base = input.maxMagicDamage ?? 30;
    return Math.floor(base * (1 + input.attackerBonuses.magic_damage_bonus / 100));
  }

  const stat = input.style === "ranged" ? input.attackerLevels.ranged : input.attackerLevels.strength;
  const strengthBonus =
    input.style === "ranged"
      ? input.attackerBonuses.ranged_strength_bonus
      : input.attackerBonuses.melee_strength_bonus;
  const styleBonus = strengthStyleBonus(input.style, input.attackType);
  const effectiveStrength = Math.ceil(stat * (input.strengthBoostMultiplier ?? 1)) + styleBonus;

  return Math.floor(
    1.3 + effectiveStrength / 10 + strengthBonus / 80 + (effectiveStrength * strengthBonus) / 640
  );
}

export function estimateStyleEv(input: StyleEvInput): StyleEvEstimate {
  const attack =
    attackRoll(
      input.attackerLevels,
      input.attackerBonuses,
      input.style,
      input.attackType,
      input.attackBoostMultiplier ?? 1
    ) * (input.accuracyModifier ?? 1);
  const defence = defenceRoll(
    input.defenderLevels,
    input.defenderBonuses,
    input.style,
    input.attackType,
    input.defenceBoostMultiplier ?? 1,
    input.magicDefenceBoostMultiplier ?? 1
  );
  const chance = hitChance(attack, defence);
  const max = maxDamage(input);

  return {
    style: input.style,
    attackRoll: attack,
    defenceRoll: defence,
    hitChance: chance,
    maxDamage: max,
    expectedDamage: chance * (max / 2)
  };
}

export function bestStyleByEv(estimates: readonly StyleEvEstimate[]): StyleEvEstimate | undefined {
  return [...estimates].sort((left, right) => right.expectedDamage - left.expectedDamage)[0];
}

export function styleAdvantage(
  candidate: StyleEvEstimate,
  alternatives: readonly StyleEvEstimate[]
): number {
  const bestAlternative = bestStyleByEv(alternatives.filter((estimate) => estimate.style !== candidate.style));
  return candidate.expectedDamage - (bestAlternative?.expectedDamage ?? 0);
}

function strengthStyleBonus(
  style: CombatStyle,
  attackType: StyleEvInput["attackType"] = "accurate"
): number {
  if (style === "ranged") {
    if (attackType === "accurate") {
      return 3;
    }
    if (attackType === "long_ranged") {
      return 1;
    }
    return 0;
  }

  if (attackType === "aggressive") {
    return 3;
  }
  if (attackType === "controlled") {
    return 1;
  }
  return 0;
}

function accuracyStyleBonus(
  style: CombatStyle,
  attackType: StyleEvInput["attackType"] = "accurate"
): number {
  if (attackType === "accurate") {
    return 3;
  }
  if (style === "magic") {
    return attackType === undefined ? 0 : 1;
  }
  if (attackType === "controlled" || attackType === "long_ranged") {
    return 1;
  }
  return 0;
}

function defenceStyleBonus(attackType: StyleEvInput["attackType"] = "accurate"): number {
  if (attackType === "controlled" || attackType === "long_ranged") {
    return 1;
  }
  return 0;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
