import { createServer } from "node:http";
import { createGame, step, type GameState } from "./game";

const state:GameState=createGame();
const clients=new Set<import("node:http").ServerResponse>();
function json(res:import("node:http").ServerResponse,status:number,value:unknown){res.writeHead(status,{"content-type":"application/json","access-control-allow-origin":"*"});res.end(JSON.stringify(value));}
function snapshot(){return {tick:state.tick,players:state.players,events:state.events.slice(-20)};}

const server=createServer((req,res)=>{
  if(req.method==="OPTIONS"){res.writeHead(204,{"access-control-allow-origin":"*","access-control-allow-methods":"GET,POST,OPTIONS","access-control-allow-headers":"content-type"});return res.end();}
  if(req.url==="/state"&&req.method==="GET") return json(res,200,snapshot());
  if(req.url==="/tick"&&req.method==="POST"){step(state);return json(res,200,snapshot());}
  if(req.url==="/events"&&req.method==="GET"){clients.add(res);req.on("close",()=>clients.delete(res));res.writeHead(200,{"content-type":"text/event-stream","cache-control":"no-cache","access-control-allow-origin":"*"});res.write(`data: ${JSON.stringify(snapshot())}\\n\\n`);return;}
  json(res,404,{error:"not found"});
});

let last=Date.now();
setInterval(()=>{
  const now=Date.now();
  if(now-last>=600){const ticks=Math.min(4,Math.floor((now-last)/600));for(let i=0;i<ticks;i++)step(state);last+=ticks*600;
    const payload=`data: ${JSON.stringify(snapshot())}\\n\\n`; for(const c of clients)c.write(payload);
  }
},50);
server.listen(8080,()=>console.log("OSRS private-server prototype listening on http://localhost:8080"));
