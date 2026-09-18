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
  /** Raw pre-prayer damage for each hitsplat. Prayer is resolved at impact. */
  readonly rawDamages: readonly number[];
  /** Convenience view retained for callers/tests that want launch-time prayer math. */
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
    if (rng() < chance) {
      firstSuccessfulStrike = strike;
      break;
    }
  }

  const ordinaryMax = Math.max(1, Math.floor(maxDamage({
    ...input,
    style: "slash",
    damageMultiplier: 1
  })));

  let damages: number[];
  if (firstSuccessfulStrike < 0) {
    // Four failed accuracy rolls can still produce a 2, split randomly across
    // two hitsplats. The live game uses this as a small fallback.
    if (rng() < 2 / 3) {
      const pairs = [[0, 1], [2, 3], [0, 2], [1, 3]];
      const pair = pairs[Math.floor(rng() * pairs.length)];
      damages = [0, 0, 0, 0];
      damages[pair[0]] = 1;
      damages[pair[1]] = 1;
    } else {
      damages = [0, 0, 0, 0];
    }
  } else if (firstSuccessfulStrike === 0) {
    // 4-2-1-1. The first hit rolls from half max to max-1, then the
    // following hits are derived from it.
    const first = Math.floor(ordinaryMax / 2) +
      Math.floor(rng() * Math.max(1, ordinaryMax - Math.floor(ordinaryMax / 2)));
    const second = Math.floor(first / 2);
    const third = Math.floor(second / 2);
    damages = [first, second, third, third + 1];
  } else if (firstSuccessfulStrike === 1) {
    // 0-4-2-2. The second hit rolls from 3/8 to 7/8 of ordinary max.
    const min = Math.floor(ordinaryMax * 3 / 8);
    const max = Math.floor(ordinaryMax * 7 / 8);
    const second = min + Math.floor(rng() * Math.max(1, max - min + 1));
    const third = Math.floor(second / 2);
    damages = [0, second, third, third + 1];
  } else if (firstSuccessfulStrike === 2) {
    // 0-0-3-3.
    const min = Math.floor(ordinaryMax / 4);
    const max = Math.floor(ordinaryMax * 3 / 4);
    const third = min + Math.floor(rng() * Math.max(1, max - min + 1));
    damages = [0, 0, third, third + 1];
  } else {
    // 0-0-0-5.
    const min = Math.floor(ordinaryMax / 4);
    const max = Math.floor(ordinaryMax * 5 / 4);
    const fourth = min + Math.floor(rng() * Math.max(1, max - min + 1));
    damages = [0, 0, 0, fourth];
  }

  const protectedDamages = damages.map(damage => applyProtectionDamageReduction({
    damage,
    attackStyle: "slash",
    defenderPrayers: input.defenderPrayers ?? [],
    attackerIsPlayer: input.attackerIsPlayer
  }));

  return {
    landed: damages.some(damage => damage > 0),
    rawDamages: damages,
    damages: protectedDamages,
    firstSuccessfulStrike
  };
}
