import { levelForXp, xpForLevel } from "./xp";
import type { CombatLevels } from "../combat/formulas";

export type StatId = "attack" | "strength" | "defence" | "ranged" | "magic" | "hitpoints" | "prayer";

export const statIds: readonly StatId[] = ["attack", "strength", "defence", "ranged", "magic", "hitpoints", "prayer"];

export type StatXp = Readonly<Record<StatId, number>>;

export const startingXp: StatXp = {
  // Combat-ready prototype account. The progression system remains live and can be
  // tuned back toward level-1 starts once the vertical slice is fun to play.
  attack: xpForLevel(40),
  strength: xpForLevel(40),
  defence: xpForLevel(40),
  ranged: xpForLevel(40),
  magic: xpForLevel(40),
  hitpoints: xpForLevel(40),
  prayer: xpForLevel(43)
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

export function maxPrayerPoints(block: StatBlock): number {
  return levelOf(block, "prayer");
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
