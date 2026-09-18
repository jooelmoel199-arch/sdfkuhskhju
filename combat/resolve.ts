import {
  attackRoll,
  defenceRoll,
  hitChance,
  maxDamage,
  type BonusTable,
  type CombatLevels,
  type CombatStyle
} from "./formulas";
import { applyProtectionDamageReduction, type PrayerId } from "../prayer/prayers";

export interface HitRollInput {
  readonly style: CombatStyle;
  readonly attackType?: "accurate" | "aggressive" | "defensive" | "controlled" | "rapid_ranged" | "long_ranged";
  readonly attackerLevels: CombatLevels;
  readonly defenderLevels: CombatLevels;
  readonly attackerBonuses: BonusTable;
  readonly defenderBonuses: BonusTable;
  readonly attackBoostMultiplier?: number;
  readonly strengthBoostMultiplier?: number;
  readonly defenceBoostMultiplier?: number;
  readonly maxMagicDamage?: number;
  readonly accuracyMultiplier?: number; // specs
  readonly damageMultiplier?: number; // specs
  readonly defenderPrayers?: readonly PrayerId[];
  readonly attackerIsPlayer: boolean;
  readonly rng?: () => number;
}

export interface HitResult {
  readonly hitChance: number;
  readonly landed: boolean;
  readonly maxHit: number;
  readonly rawDamage: number;
  readonly finalDamage: number;
}

/** A single OSRS-style attack: roll to hit, then roll 0..maxHit uniformly, then apply prayer mitigation. */
export function rollAttack(input: HitRollInput): HitResult {
  const rng = input.rng ?? Math.random;
  const attack =
    attackRoll(input.attackerLevels, input.attackerBonuses, input.style, input.attackType, input.attackBoostMultiplier ?? 1) *
    (input.accuracyMultiplier ?? 1);
  const defence = defenceRoll(input.defenderLevels, input.defenderBonuses, input.style, input.attackType, input.defenceBoostMultiplier ?? 1, 1);
  const chance = hitChance(attack, defence);
  const landed = rng() < chance;

  const max = Math.max(
    0,
    Math.floor(
      maxDamage({
        style: input.style,
        attackerLevels: input.attackerLevels,
        defenderLevels: input.defenderLevels,
        attackerBonuses: input.attackerBonuses,
        defenderBonuses: input.defenderBonuses,
        attackType: input.attackType,
        strengthBoostMultiplier: input.strengthBoostMultiplier ?? 1,
        maxMagicDamage: input.maxMagicDamage
      }) * (input.damageMultiplier ?? 1)
    )
  );

  if (!landed) {
    return { hitChance: chance, landed, maxHit: max, rawDamage: 0, finalDamage: 0 };
  }

  const raw = Math.floor(rng() * (max + 1));
  const finalDamage = applyProtectionDamageReduction({
    damage: raw,
    attackStyle: input.style,
    defenderPrayers: input.defenderPrayers ?? [],
    attackerIsPlayer: input.attackerIsPlayer
  });

  return { hitChance: chance, landed, maxHit: max, rawDamage: raw, finalDamage };
}
