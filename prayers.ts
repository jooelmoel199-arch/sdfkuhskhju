import type { CombatStyle } from "../combat/formulas";

export type PrayerId =
  | "thick_skin"
  | "burst_of_strength"
  | "clarity_of_thought"
  | "rock_skin"
  | "superhuman_strength"
  | "improved_reflexes"
  | "rapid_restore"
  | "rapid_heal"
  | "protect_item"
  | "steel_skin"
  | "ultimate_strength"
  | "incredible_reflexes"
  | "protect_from_magic"
  | "protect_from_missiles"
  | "protect_from_melee"
  | "retribution"
  | "smite"
  | "redemption"
  | "sharp_eye"
  | "mystic_will"
  | "hawk_eye"
  | "mystic_lore"
  | "mystic_might"
  | "eagle_eye"
  | "chivalry"
  | "piety"
  | "rigour"
  | "augury"
  | "preserve";

export type ProtectionPrayerId = "protect_from_magic" | "protect_from_missiles" | "protect_from_melee";
export type OverheadPrayerId = ProtectionPrayerId | "retribution" | "smite" | "redemption";

export interface PrayerBoosts {
  readonly attack: number;
  readonly strength: number;
  readonly defence: number;
  readonly rangedAttack: number;
  readonly rangedStrength: number;
  readonly magic: number;
}

export interface PrayerDefinition {
  readonly id: PrayerId;
  readonly level: number;
  readonly drain: number;
  readonly headIcon?: number;
  readonly boosts: PrayerBoosts;
  readonly disallowGroup:
    | "defence"
    | "strength"
    | "attack"
    | "ranged"
    | "magic"
    | "mixed"
    | "overhead"
    | "none";
}

export const pvpProtectionDamageMultiplier = 0.6;

const noBoosts: PrayerBoosts = {
  attack: 0,
  strength: 0,
  defence: 0,
  rangedAttack: 0,
  rangedStrength: 0,
  magic: 0
};

export const prayerDefinitions: Readonly<Record<PrayerId, PrayerDefinition>> = {
  thick_skin: definePrayer("thick_skin", 1, 3, "defence", { defence: 0.05 }),
  burst_of_strength: definePrayer("burst_of_strength", 4, 3, "strength", { strength: 0.05 }),
  clarity_of_thought: definePrayer("clarity_of_thought", 7, 3, "attack", { attack: 0.05 }),
  rock_skin: definePrayer("rock_skin", 10, 6, "defence", { defence: 0.1 }),
  superhuman_strength: definePrayer("superhuman_strength", 13, 6, "strength", { strength: 0.1 }),
  improved_reflexes: definePrayer("improved_reflexes", 16, 6, "attack", { attack: 0.1 }),
  rapid_restore: definePrayer("rapid_restore", 19, 1, "none", {}),
  rapid_heal: definePrayer("rapid_heal", 22, 2, "none", {}),
  protect_item: definePrayer("protect_item", 25, 2, "none", {}),
  steel_skin: definePrayer("steel_skin", 28, 12, "defence", { defence: 0.15 }),
  ultimate_strength: definePrayer("ultimate_strength", 31, 12, "strength", { strength: 0.15 }),
  incredible_reflexes: definePrayer("incredible_reflexes", 34, 12, "attack", { attack: 0.15 }),
  protect_from_magic: definePrayer("protect_from_magic", 37, 12, "overhead", {}, 2),
  protect_from_missiles: definePrayer("protect_from_missiles", 40, 12, "overhead", {}, 1),
  protect_from_melee: definePrayer("protect_from_melee", 43, 12, "overhead", {}, 0),
  retribution: definePrayer("retribution", 46, 3, "overhead", {}, 3),
  smite: definePrayer("smite", 52, 18, "overhead", {}, 4),
  redemption: definePrayer("redemption", 49, 6, "overhead", {}, 5),
  sharp_eye: definePrayer("sharp_eye", 8, 3, "ranged", { rangedAttack: 0.05, rangedStrength: 0.05 }),
  mystic_will: definePrayer("mystic_will", 9, 3, "magic", { magic: 0.05 }),
  hawk_eye: definePrayer("hawk_eye", 26, 6, "ranged", { rangedAttack: 0.1, rangedStrength: 0.1 }),
  mystic_lore: definePrayer("mystic_lore", 27, 6, "magic", { magic: 0.1 }),
  mystic_might: definePrayer("mystic_might", 45, 12, "magic", { magic: 0.15 }),
  eagle_eye: definePrayer("eagle_eye", 44, 12, "ranged", { rangedAttack: 0.15, rangedStrength: 0.15 }),
  chivalry: definePrayer("chivalry", 60, 24, "mixed", { attack: 0.15, strength: 0.18, defence: 0.2 }),
  piety: definePrayer("piety", 70, 24, "mixed", { attack: 0.2, strength: 0.23, defence: 0.25 }),
  rigour: definePrayer("rigour", 74, 24, "mixed", {
    rangedAttack: 0.2,
    rangedStrength: 0.23,
    defence: 0.25
  }),
  augury: definePrayer("augury", 77, 24, "mixed", { magic: 0.25, defence: 0.25 }),
  preserve: definePrayer("preserve", 55, 3, "none", {})
};

export function protectPrayerForStyle(style: CombatStyle): ProtectionPrayerId {
  if (style === "magic") {
    return "protect_from_magic";
  }
  if (style === "ranged") {
    return "protect_from_missiles";
  }
  return "protect_from_melee";
}

export function protectsAgainstStyle(prayer: PrayerId | undefined, style: CombatStyle | undefined): boolean {
  return prayer !== undefined && style !== undefined && prayer === protectPrayerForStyle(style);
}

export function activeProtectionPrayer(activePrayers: readonly PrayerId[]): ProtectionPrayerId | undefined {
  if (activePrayers.includes("protect_from_magic")) {
    return "protect_from_magic";
  }
  if (activePrayers.includes("protect_from_missiles")) {
    return "protect_from_missiles";
  }
  if (activePrayers.includes("protect_from_melee")) {
    return "protect_from_melee";
  }
  return undefined;
}

export function activeOverheadPrayer(activePrayers: readonly PrayerId[]): OverheadPrayerId | undefined {
  const protection = activeProtectionPrayer(activePrayers);
  if (protection) {
    return protection;
  }
  if (activePrayers.includes("retribution")) {
    return "retribution";
  }
  if (activePrayers.includes("redemption")) {
    return "redemption";
  }
  if (activePrayers.includes("smite")) {
    return "smite";
  }
  return undefined;
}

export function applyProtectionDamageReduction(input: {
  readonly damage: number;
  readonly attackStyle: CombatStyle;
  readonly defenderPrayers: readonly PrayerId[];
  readonly attackerIsPlayer: boolean;
  readonly ignorePrayer?: boolean;
}): number {
  if (input.ignorePrayer) {
    return Math.trunc(input.damage);
  }

  const protectedAgainst = protectsAgainstStyle(activeProtectionPrayer(input.defenderPrayers), input.attackStyle);
  if (!protectedAgainst) {
    return Math.trunc(input.damage);
  }

  return input.attackerIsPlayer ? Math.trunc(input.damage * pvpProtectionDamageMultiplier) : 0;
}

export function compatiblePrayerSet(prayers: readonly PrayerId[]): readonly PrayerId[] {
  const selected: PrayerId[] = [];

  for (const prayer of prayers) {
    const definition = prayerDefinitions[prayer];
    if (!definition) {
      continue;
    }

    const disallowedGroups = disallowedPrayerGroups(definition.disallowGroup);
    for (let index = selected.length - 1; index >= 0; index -= 1) {
      const selectedGroup = prayerDefinitions[selected[index]].disallowGroup;
      if (disallowedGroups.has(selectedGroup)) {
        selected.splice(index, 1);
      }
    }
    selected.push(prayer);
  }

  return selected;
}

export function aggregatePrayerBoosts(prayers: readonly PrayerId[]): PrayerBoosts {
  return compatiblePrayerSet(prayers).reduce<PrayerBoosts>(
    (boosts, prayer) => {
      const definition = prayerDefinitions[prayer];
      return {
        attack: boosts.attack + definition.boosts.attack,
        strength: boosts.strength + definition.boosts.strength,
        defence: boosts.defence + definition.boosts.defence,
        rangedAttack: boosts.rangedAttack + definition.boosts.rangedAttack,
        rangedStrength: boosts.rangedStrength + definition.boosts.rangedStrength,
        magic: boosts.magic + definition.boosts.magic
      };
    },
    { ...noBoosts }
  );
}

function definePrayer(
  id: PrayerId,
  level: number,
  drain: number,
  disallowGroup: PrayerDefinition["disallowGroup"],
  boosts: Partial<PrayerBoosts>,
  headIcon?: number
): PrayerDefinition {
  return {
    id,
    level,
    drain,
    headIcon,
    disallowGroup,
    boosts: {
      ...noBoosts,
      ...boosts
    }
  };
}

function disallowedPrayerGroups(
  group: PrayerDefinition["disallowGroup"]
): ReadonlySet<PrayerDefinition["disallowGroup"]> {
  if (group === "defence") {
    return new Set(["defence", "mixed"]);
  }
  if (group === "strength") {
    return new Set(["strength", "ranged", "magic", "mixed"]);
  }
  if (group === "attack") {
    return new Set(["attack", "ranged", "magic", "mixed"]);
  }
  if (group === "ranged") {
    return new Set(["ranged", "strength", "attack", "magic", "mixed"]);
  }
  if (group === "magic") {
    return new Set(["magic", "strength", "attack", "ranged", "mixed"]);
  }
  if (group === "mixed") {
    return new Set(["mixed", "defence", "strength", "attack", "ranged", "magic"]);
  }
  if (group === "overhead") {
    return new Set(["overhead"]);
  }
  return new Set();
}
