import type { TilePosition } from "../world/movement";
import type { ZoneKind } from "./entities";

/**
 * Prototype 1 map: a single 1-dimensional lane, x in [0, LANE_LENGTH].
 * Blue base/tower sit near x=0, red base/tower near x=LANE_LENGTH.
 * The middle band is the river (multi-combat); the outer bands nearest each
 * base are jungle-adjacent (also multi) once we add prototype 2's jungle —
 * for prototype 1 we keep the whole non-lane-core area as "river" so the
 * singles-vs-multi distinction is testable end to end.
 */
export const LANE_LENGTH = 40;
// Prototype 1 has no river/jungle yet (that's prototype 2 per the staged
// build plan) — the whole lane between the two bases is singles combat.
// Shrink LANE_CORE_START/grow LANE_CORE_END, or add a real multi-combat
// river band, when building prototype 2.
export const LANE_CORE_START = 2;
export const LANE_CORE_END = LANE_LENGTH - 2;

export const BLUE_BASE_X = 0;
export const RED_BASE_X = LANE_LENGTH;
export const BLUE_TOWER_X = 6;
export const RED_TOWER_X = LANE_LENGTH - 6;

export function zoneAt(tile: TilePosition): ZoneKind {
  if (tile.x <= 1 || tile.x >= LANE_LENGTH - 1) {
    return "base";
  }
  if (tile.x >= LANE_CORE_START && tile.x <= LANE_CORE_END) {
    return "lane";
  }
  return "river";
}

export function isSingles(zone: ZoneKind): boolean {
  return zone === "lane" || zone === "base";
}

export function isMulti(zone: ZoneKind): boolean {
  return zone === "river" || zone === "jungle";
}

/**
 * Engagement (PJ) timer, game-specific and shorter than OSRS's traditional
 * ~2-tick-friendly / long-standing PJ rule. In a singles zone, once a fight
 * is active between A and B, a third player cannot attack either of them
 * until ENGAGEMENT_TICKS have passed since the *defender's* last combat
 * timestamp — but a teammate of one side counts as a legal "takeover" the
 * moment their teammate lands a hit, allowing rotations/swaps without ever
 * opening the fight to unrestricted piling.
 */
export const ENGAGEMENT_TICKS = 8; // 8 ticks * 600ms = 4.8s, well under OSRS's ~40s PJ timer

export interface JoinFightInput {
  readonly zone: ZoneKind;
  /** Team currently locked in combat with the defender, if any (undefined = no active fight). */
  readonly currentAttackerTeam?: string;
  /** Team of the player trying to join in on the defender. */
  readonly incomingTeam: string;
  readonly defenderLastCombatTick: number;
  readonly currentTick: number;
}

export function canJoinFight(input: JoinFightInput): boolean {
  if (isMulti(input.zone)) {
    return true;
  }
  if (input.currentAttackerTeam === undefined) {
    return true; // nobody engaged yet, first attacker always legal
  }
  if (input.currentTick - input.defenderLastCombatTick > ENGAGEMENT_TICKS) {
    return true; // fight has gone cold, singles zone reopens
  }
  // A teammate of the side already fighting may rotate/swap in (takeover) freely.
  return input.incomingTeam === input.currentAttackerTeam;
}
