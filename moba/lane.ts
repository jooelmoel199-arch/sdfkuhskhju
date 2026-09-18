import type { TilePosition } from "../world/movement";
import type { ZoneKind, Team } from "./entities";

export type LaneId = "top" | "middle" | "bottom";
export const LANES: readonly LaneId[] = ["top", "middle", "bottom"];
export const LANE_LENGTH = 40;
export const LANE_CORE_START = 2;
export const LANE_CORE_END = LANE_LENGTH - 2;
export const BLUE_BASE_X = 0;
export const RED_BASE_X = LANE_LENGTH;
export const BLUE_TOWER_X = 6;
export const RED_TOWER_X = LANE_LENGTH - 6;

export const LANE_Y: Record<LaneId, number> = { top: 0, middle: 10, bottom: 20 };

export function laneIndex(lane: LaneId): number {
  return LANES.indexOf(lane);
}

export function nearestLane(y: number): LaneId {
  return LANES.reduce((best, lane) =>
    Math.abs(y - LANE_Y[lane]) < Math.abs(y - LANE_Y[best]) ? lane : best,
    "middle" as LaneId
  );
}

export function tileForLane(team: Team, lane: LaneId): TilePosition {
  return {
    x: team === "blue" ? BLUE_BASE_X + 2 : RED_BASE_X - 2,
    y: LANE_Y[lane]
  };
}

export function zoneAt(tile: TilePosition): ZoneKind {
  const lane = nearestLane(tile.y);
  const laneOffset = Math.abs(tile.y - LANE_Y[lane]);
  if (tile.x <= 1 || tile.x >= LANE_LENGTH - 1) return "base";
  if (laneOffset <= 1 && tile.x >= LANE_CORE_START && tile.x <= LANE_CORE_END) return "lane";
  return "river";
}

export function isSingles(zone: ZoneKind): boolean {
  return zone === "lane" || zone === "base";
}

export function isMulti(zone: ZoneKind): boolean {
  return zone === "river" || zone === "jungle";
}

export const ENGAGEMENT_TICKS = 8;

export interface JoinFightInput {
  readonly zone: ZoneKind;
  readonly currentAttackerTeam?: string;
  readonly incomingTeam: string;
  readonly defenderLastCombatTick: number;
  readonly currentTick: number;
}

export function canJoinFight(input: JoinFightInput): boolean {
  if (isMulti(input.zone)) return true;
  if (input.currentAttackerTeam === undefined) return true;
  if (input.currentTick - input.defenderLastCombatTick > ENGAGEMENT_TICKS) return true;
  return input.incomingTeam === input.currentAttackerTeam;
}
