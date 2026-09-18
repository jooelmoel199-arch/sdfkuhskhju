/**
 * Stat-XP curve for the MOBA. This is a purpose-built curve, not OSRS's
 * real one: OSRS's curve (~13M xp to 99) is built for hundreds of hours of
 * play and cannot fit inside a 20-40 minute match. We keep the OSRS *feel*
 * (progressively more expensive per level, 99 as the effective cap) via a
 * simple polynomial: xpForLevel(n) = C * n^EXPONENT.
 *
 * Tuned so a single kill's unallocated xp (see economy.ts xpRewards) buys
 * roughly a level-18 stat, five kills roughly level 36, and reaching 99 in
 * one stat costs close to a full match's total income — i.e. reachable,
 * but only by committing most of your XP to it. Retune XP_TO_99 (and the
 * per-event rewards in economy.ts) to change overall match pacing.
 */

const MAX_LEVEL = 99;
const EXPONENT = 2.2;
const XP_TO_99 = 14000;
const CURVE_CONSTANT = XP_TO_99 / MAX_LEVEL ** EXPONENT;

function buildXpTable(): number[] {
  const table = [0, 0]; // index 0 unused, level 1 = 0 xp
  let previous = 0;
  for (let level = 1; level < MAX_LEVEL; level += 1) {
    const raw = Math.floor(CURVE_CONSTANT * level ** EXPONENT);
    const value = Math.max(previous + 1, raw);
    table.push(value);
    previous = value;
  }
  return table;
}

/** xpTable[level] = total cumulative xp required to reach that level. */
export const xpTable: readonly number[] = buildXpTable();

export function levelForXp(xp: number): number {
  let level = 1;
  for (let candidate = MAX_LEVEL; candidate >= 1; candidate -= 1) {
    if (xp >= xpTable[candidate]) {
      level = candidate;
      break;
    }
  }
  return level;
}

export function xpForLevel(level: number): number {
  return xpTable[Math.max(1, Math.min(MAX_LEVEL, level))];
}

export function xpToNextLevel(xp: number): number {
  const level = levelForXp(xp);
  if (level >= MAX_LEVEL) {
    return 0;
  }
  return xpForLevel(level + 1) - xp;
}

/** Overall "account level" the way OSRS combines skills — used for game-level milestones (pure/zerker/med/main). */
export function accountLevelFromXp(stats: {
  readonly attack: number;
  readonly strength: number;
  readonly defence: number;
  readonly ranged: number;
  readonly magic: number;
  readonly hitpoints: number;
}): number {
  const base =
    0.25 *
    (levelForXp(stats.attack) +
      levelForXp(stats.strength) +
      levelForXp(stats.defence) +
      (3 / 8) * (levelForXp(stats.ranged) * 2) +
      (3 / 8) * (levelForXp(stats.magic) * 2)) +
    0.25 * levelForXp(stats.hitpoints);
  return Math.floor(base);
}
