# PvP Demo Test Plan

The browser prototype is a 600ms-tick RuneScape-combat test lane. The goal of this checklist is to verify the parts that make the demo feel like an OSRS-style PvP encounter before expanding the wider MOBA systems.

## Launch

```bash
npm install
npm run check
npm run web
```

Open the Vite URL and use the **PvP test lane**.

## Controls

- Click an enemy: select and chase/attack it.
- Space: toggle attacking.
- P: Protect from Melee.
- M: Protect from Magic.
- N: Protect from Missiles.
- F: shark.
- G: karambwan.
- C: prayer restore.
- X: special attack.
- T: cycle the equipped weapon's attack style.
- 4/5/6/7: Ice Rush/Burst/Blitz/Barrage.
- J/K/L: spend available XP on Attack/Strength/Defence.
- 1/2/3: move to top/middle/bottom lane.
- R: reset the test.

The inventory/equipment panel also exposes weapon switches, prayers, specials and spells without requiring hotkeys.

## Combat smoke tests

### 1. Gear switch into attack

1. Reset.
2. Put the dummy within melee range.
3. Equip AGS or Dragon claws from the inventory panel.
4. Attack immediately.

Expected:
- The weapon changes on the authoritative tick.
- The switch does not consume an attack cycle.
- The selected weapon's default attack style is applied.

### 2. Projectile travel

1. Equip the Magic shortbow or Armadyl crossbow.
2. Attack from different distances.
3. Watch the projectile travel before the hit splat/log entry.

Expected:
- Ranged travel uses the OSRS-style distance bands.
- A lower-PID projectile gets the additional processing-order tick.
- Prayer can be changed before impact and affects the impact damage.

### 3. Ice spell and freeze

1. Equip the Ancient staff.
2. Select Ice Barrage/Burst/Blitz/Rush.
3. Attack the dummy.
4. Move while the spell is travelling.

Expected:
- Magic is represented as a projectile.
- A landed ice spell freezes the target.
- A missed spell does not freeze.
- Freeze prevents movement until the freeze expires, with a short immunity window afterwards.

### 4. Protection prayer switching

1. Let a ranged or magic projectile travel toward you.
2. Activate the matching protection prayer before impact.
3. Observe the hit.

Expected:
- The projectile's raw damage is retained until impact.
- The prayer active at impact determines protection.
- Protection reduces player-vs-player damage rather than changing the launch roll.

### 5. Dragon claws special

1. Equip Dragon claws.
2. Ensure 50+ special energy.
3. Use the special.
4. Repeat with Protect from Melee active before the hits land.

Expected:
- Four claws hitsplats are queued together.
- The special consumes 50% energy.
- Raw claws damage is retained until impact so protection is evaluated at impact.

### 6. Combo eating

1. Take damage.
2. Eat a shark.
3. Immediately use a karambwan.
4. Observe the attack timer.

Expected:
- Both items can be consumed in the same combo window.
- Shark adds 3 ticks to the attack cycle.
- Karambwan adds 2 more.
- The next attack is delayed by the combined 5 ticks.

### 7. PID stack

The test suite includes same-tick melee and projectile cases.

Expected:
- The higher-priority player can process melee damage on the current tick.
- The lower-priority player gets the one-tick processing-order delay.
- Projectile distance delay is added before the PID delay.

## Automated regression coverage

`tests/simulation.test.ts` covers:

- PvP test fixture shape.
- One-shot prayer commands.
- Queued hit resolution on the target's PID turn.
- Same-tick gear switching.
- Food and karambwan attack delays.
- Minion wave cadence.
- Ranged and magic projectile delay bands.
- Player magic accuracy/defence formulas.
- Dragon claws four-hit generation.
- Protection prayer at impact.
- Missed freezes.
- Redemption on lethal damage.
- Jungle camp respawn.

When changing combat timing, update or add a regression test before changing the browser UI.
