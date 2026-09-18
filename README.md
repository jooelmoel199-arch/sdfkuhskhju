# OSRS-style combat prototype

A clean-room browser/server prototype for experimenting with tick-based RuneScape-style game semantics.

## Run locally

```bash
npm install
npm run server
```

Open http://localhost:8080.

## Current prototype

- 600ms authoritative server tick
- Mouse-driven world movement and interaction
- Persistent attack interaction with melee pathing
- Four attack styles
- Inventory/equipment scaffold and food
- Prayer state and server-side drain
- Special-attack queue
- Ordered player turns
- FIFO client-input cap of ten commands per tick
- Server-side combat rolls and queued hits
- PID/turn-order-sensitive melee hit timing
- Browser minimap, target highlighting, health bars, context menu and combat feedback
- RuneScript combat hook

The combat loop is intentionally being expanded toward modern OSRS semantics rather than treating old RS2-era code as the mechanical authority.
