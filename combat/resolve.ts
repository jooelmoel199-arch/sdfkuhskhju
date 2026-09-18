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

export interface ClawSpecialResult {
  readonly landed: boolean;
  readonly damages: readonly number[];
  readonly firstSuccessfulStrike: number;
}

export function rollDragonClawsSpecial(input: HitRollInput): ClawSpecialResult {
  const rng = input.rng ?? Math.random;
  const attack =
    attackRoll(input.attackerLevels, input.attackerBonuses, "slash", input.attackType, input.attackBoostMultiplier ?? 1);
  const defence =
    defenceRoll(input.defenderLevels, input.defenderBonuses, "slash", input.attackType, input.defenceBoostMultiplier ?? 1, 1);
  const chance = hitChance(attack, defence);

  let firstSuccessfulStrike = -1;
  for (let strike = 0; strike < 4; strike += 1) {
    if (firstSuccessfulStrike >= 0 || rng() < chance) {
      firstSuccessfulStrike = firstSuccessfulStrike >= 0 ? firstSuccessfulStrike : strike;
      break;
    }
  }

  if (firstSuccessfulStrike < 0) {
    // OSRS claws can still produce a tiny 0/2 result after four failed accuracy rolls.
    const fallback = rng() < 0.5 ? 0 : 2;
    return { landed: fallback > 0, damages: fallback ? [fallback, 0, 0, 0] : [0, 0, 0, 0], firstSuccessfulStrike: -1 };
  }

  const ordinaryMax = Math.max(1, maxDamage({
    ...input,
    style: "slash",
    damageMultiplier: 1
  }));

  const maxMultiplier = [2, 1.75, 1.5, 1.25][firstSuccessfulStrike];
  const minMultiplier = [1, 0.75, 0.5, 0.25][firstSuccessfulStrike];
  const totalMax = Math.max(1, Math.floor(ordinaryMax * maxMultiplier));
  const totalMin = Math.floor(ordinaryMax * minMultiplier);
  const total = totalMin + Math.floor(rng() * Math.max(1, totalMax - totalMin + 1));
  const hits = Math.max(1, firstSuccessfulStrike + 1);
  const damages = Array.from({ length: 4 }, (_, index) => {
    if (index >= hits) return 0;
    const base = Math.floor(total / hits);
    const remainder = total % hits;
    return base + (index < remainder ? 1 : 0);
  });

  return { landed: true, damages, firstSuccessfulStrike };
}
