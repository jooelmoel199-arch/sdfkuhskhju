import { levelForXp, xpForLevel } from "./xp";
import type { CombatLevels } from "../combat/formulas";

export type StatId = "attack" | "strength" | "defence" | "ranged" | "magic" | "hitpoints";

export const statIds: readonly StatId[] = ["attack", "strength", "defence", "ranged", "magic", "hitpoints"];

export type StatXp = Readonly<Record<StatId, number>>;

export const startingXp: StatXp = {
  attack: xpForLevel(1),
  strength: xpForLevel(1),
  defence: xpForLevel(1),
  ranged: xpForLevel(1),
  magic: xpForLevel(1),
  hitpoints: xpForLevel(10) // OSRS-style: everyone starts at HP 10
};

/**
 * The core "no fixed classes" mechanic: XP earned from kills/minions/objectives
 * lands in an unallocated pool. The player spends it into whichever stat(s)
 * they choose, at any time, reacting to the current matchup. This is the
 * in-match analogue of "training" a stat in OSRS, just compressed to be a
 * player decision made mid-fight instead of an offline grind.
 */
export interface StatBlock {
  readonly xp: StatXp;
  readonly unallocatedXp: number;
}

export function createStatBlock(): StatBlock {
  return { xp: startingXp, unallocatedXp: 0 };
}

export function grantUnallocatedXp(block: StatBlock, amount: number): StatBlock {
  return { ...block, unallocatedXp: block.unallocatedXp + Math.max(0, amount) };
}

/** Player-directed investment: spend `amount` of unallocated xp into one stat. */
export function investXp(block: StatBlock, stat: StatId, amount: number): StatBlock {
  const spend = Math.max(0, Math.min(amount, block.unallocatedXp));
  if (spend <= 0) {
    return block;
  }
  return {
    unallocatedXp: block.unallocatedXp - spend,
    xp: { ...block.xp, [stat]: block.xp[stat] + spend }
  };
}

export function levelOf(block: StatBlock, stat: StatId): number {
  return levelForXp(block.xp[stat]);
}

export function maxHitpoints(block: StatBlock): number {
  return levelOf(block, "hitpoints");
}

export function toCombatLevels(block: StatBlock): CombatLevels {
  return {
    attack: levelOf(block, "attack"),
    strength: levelOf(block, "strength"),
    defence: levelOf(block, "defence"),
    ranged: levelOf(block, "ranged"),
    magic: levelOf(block, "magic")
  };
}
