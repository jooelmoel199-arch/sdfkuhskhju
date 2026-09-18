import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  createGame,
  enqueueInput,
  step,
  type GameState,
  type InputCommand
} from "./game";

const state: GameState = createGame();
const clientHtml = resolve(process.cwd(), "web/private-server.html");
const clients = new Set<import("node:http").ServerResponse>();

function json(
  res: import("node:http").ServerResponse,
  status: number,
  value: unknown
) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*"
  });
  res.end(JSON.stringify(value));
}

function snapshot() {
  return {
    tick: state.tick,
    players: state.players,
    events: state.events.slice(-40),
    queuedInputs: state.pendingInputs.length
  };
}

function broadcast() {
  const payload = `data: ${JSON.stringify(snapshot())}\n\n`;
  for (const client of clients) client.write(payload);
}

async function body(req: import("node:http").IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function isInput(value: unknown): value is InputCommand {
  if (!value || typeof value !== "object") return false;
  const command = value as Record<string, unknown>;

  switch (command.type) {
    case "attack":
      return typeof command.targetId === "string";
    case "move":
      return typeof command.x === "number" && Number.isFinite(command.x);
    case "prayer":
      return (
        command.prayer === null ||
        command.prayer === "protect_melee" ||
        command.prayer === "protect_mage" ||
        command.prayer === "protect_range"
      );
    case "eat":
    case "special":
    case "stop_attack":
      return true;
    default:
      return false;
  }
}

const server = createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type"
    });
    return res.end();
  }

  if ((req.url === "/" || req.url === "/private-server.html") && req.method === "GET") {\n    try {\n      const html = await readFile(clientHtml, "utf8");\n      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });\n      return res.end(html);\n    } catch {\n      return json(res, 500, { error: "client not found" });\n    }\n  }\n\n  if (req.url === "/state" && req.method === "GET") {
    return json(res, 200, snapshot());
  }

  if (req.url === "/input" && req.method === "POST") {
    try {
      const value: unknown = JSON.parse(await body(req));
      if (!isInput(value)) return json(res, 400, { error: "invalid input" });

      enqueueInput(state, value);
      return json(res, 202, {
        accepted: true,
        tick: state.tick,
        queuedInputs: state.pendingInputs.length
      });
    } catch {
      return json(res, 400, { error: "invalid JSON" });
    }
  }

  if (req.url === "/tick" && req.method === "POST") {
    step(state);
    broadcast();
    return json(res, 200, snapshot());
  }

  if (req.url === "/events" && req.method === "GET") {
    clients.add(res);
    req.on("close", () => clients.delete(res));
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "access-control-allow-origin": "*"
    });
    res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
    return;
  }

  return json(res, 404, { error: "not found" });
});

let last = Date.now();
setInterval(() => {
  const now = Date.now();
  if (now - last >= 600) {
    const ticks = Math.min(4, Math.floor((now - last) / 600));
    for (let i = 0; i < ticks; i++) step(state);
    last += ticks * 600;
    broadcast();
  }
}, 50);

server.listen(8080, () =>
  console.log("Private-server prototype listening on http://localhost:8080")
);
