import type { PlayerEntity } from "./entities";
import { levelOf } from "./stats";
import { shopCatalog, consumableCatalog } from "./economy";
import type { CombatStyle } from "../combat/formulas";
import { LANE_CORE_START, LANE_CORE_END } from "./lane";

/**
 * Prototype-1 scripted opponent. This is intentionally simple (not the
 * NH Trainer neural policy, which is trained specifically for a single 1v1
 * NH duel format and is not a drop-in fit here) — good enough to validate
 * whether the fight *feels* right inside a lane. Swap this out for a real
 * bot once the vertical slice proves out.
 */
export interface AiDecision {
  readonly moveDelta: -1 | 0 | 1;
  readonly attackStyle: CombatStyle | undefined;
  readonly activatePrayer: string | undefined;
  readonly eatItemId: string | undefined;
  readonly useSpecial: boolean;
  readonly investStat: "attack" | "strength" | "defence" | "ranged" | "magic" | "hitpoints" | undefined;
  readonly buyItemId: string | undefined;
}

export function decideAction(self: PlayerEntity, enemy: PlayerEntity, currentTick: number): AiDecision {
  // Stay inside the lane core (singles zone) rather than wandering into the river.
  const towardEnemy = self.tile.x < enemy.tile.x ? 1 : self.tile.x > enemy.tile.x ? -1 : 0;
  const wouldLeaveCore = self.tile.x + towardEnemy < LANE_CORE_START || self.tile.x + towardEnemy > LANE_CORE_END;
  const moveDelta = wouldLeaveCore ? 0 : (towardEnemy as -1 | 0 | 1);

  const hpFraction = self.currentHp / Math.max(1, levelOf(self.stats, "hitpoints"));
  const eatItemId = hpFraction < 0.5 ? "shark" : self.prayerPoints < 8 ? "prayer_potion" : undefined;

  const weapon = self.equipment.weapon;
  const attackStyle = weapon?.style;
  const useSpecial = Boolean(weapon?.special) && self.specEnergy >= (weapon?.special?.energyCost ?? 101) && hpFraction < 0.6;

  const activatePrayer = attackStyle
    ? attackStyle === "magic"
      ? "protect_from_magic"
      : attackStyle === "ranged"
        ? "protect_from_missiles"
        : "protect_from_melee"
    : undefined;

  // Very simple build heuristic: pures stay 1 defence; this bot plays a
  // "med" style build that reacts to incoming damage by buying some defence.
  const investStat = self.stats.unallocatedXp > 0 ? (hpFraction < 0.4 ? "defence" : "strength") : undefined;

  let buyItemId: string | undefined;
  if (self.gp > 0 && self.tile.x <= 2) {
    const affordable = shopCatalog.filter((item) => item.cost <= self.gp && !self.equipment[item.slot]);
    buyItemId = affordable.sort((a, b) => b.cost - a.cost)[0]?.id;
  }

  return { moveDelta, attackStyle, activatePrayer, eatItemId, useSpecial, investStat, buyItemId };
}

export function findConsumable(id: string) {
  return consumableCatalog.find((item) => item.id === id);
}
