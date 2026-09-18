# Third-party code notice

The following files are adapted (in most cases copied near-verbatim) from the
[NH Trainer](https://github.com/NotCoco/nh-trainer) project, MIT licensed,
Copyright (c) 2026 NH Trainer contributors:

- `src/combat/formulas.ts` — OSRS-style accuracy roll / max-hit maths
- `src/combat/timers.ts` — weapon attack-cooldown timer state machine
- `src/entity/locks.ts` — freeze/stun/root/full-lock entity state
- `src/world/movement.ts` — tile distance + melee reach rules
- `src/prayer/prayers.ts` — prayer definitions, drain groups, protection prayers
- `src/engine/tick.ts` — generic ordered tick-stage runner

These modules are generic, engine-agnostic combat maths and were not written
to be specific to any single duel format, so they carry over cleanly into a
different game shell. Anything with "NH"/"Nh" in a comment refers to the
source project's internal name for the OSRS server codebase it models
against and is left in place for traceability.

Everything under `src/moba/` and `src/index.ts` is new code written for this
MOBA prototype and is not derived from NH Trainer.

This is a fan-made concept project. It reuses combat *maths*, not any Jagex
game assets, names, or branding — those still need to be original if this is
ever published.
