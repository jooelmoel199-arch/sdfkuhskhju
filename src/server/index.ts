import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createGame, enqueueInput, step, type GameState, type InputCommand } from "./game";

const state:GameState=createGame();
const clientHtml=resolve(process.cwd(),"web/private-server.html");
const clients=new Set<import("node:http").ServerResponse>();

function json(res:import("node:http").ServerResponse,status:number,value:unknown){
  res.writeHead(status,{"content-type":"application/json; charset=utf-8","access-control-allow-origin":"*"});
  res.end(JSON.stringify(value));
}
function snapshot(){return {tick:state.tick,players:state.players,events:state.events.slice(-50),queuedInputs:state.pendingInputs.length};}
function broadcast(){const payload=`data: ${JSON.stringify(snapshot())}

`;for(const c of clients)c.write(payload);}
async function body(req:import("node:http").IncomingMessage){const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));return Buffer.concat(chunks).toString("utf8");}
function isInput(value:unknown):value is InputCommand{
 if(!value||typeof value!=="object")return false;const c=value as Record<string,unknown>;
 switch(c.type){
  case "attack":return typeof c.targetId==="string";
  case "move":return typeof c.x==="number"&&Number.isFinite(c.x)&&typeof c.y==="number"&&Number.isFinite(c.y);
  case "prayer":return c.prayer===null||c.prayer==="protect_melee"||c.prayer==="protect_mage"||c.prayer==="protect_range"||c.prayer==="eagle_eye"||c.prayer==="mystic_might";
  case "attack_style":return c.style==="accurate"||c.style==="aggressive"||c.style==="defensive"||c.style==="controlled";
  case "ranged_style":return c.style==="accurate"||c.style==="rapid"||c.style==="longrange";
  case "magic_style":return c.style==="standard"||c.style==="defensive";
  case "item_action":return Number.isInteger(c.slot)&&c.slot>=0&&c.slot<28&&(c.action==="eat"||c.action==="equip"||c.action==="unequip");
  case "eat":case "special":case "stop_attack":return true;
  default:return false;
 }
}
const server=createServer(async(req,res)=>{
 if(req.method==="OPTIONS"){res.writeHead(204,{"access-control-allow-origin":"*","access-control-allow-methods":"GET,POST,OPTIONS","access-control-allow-headers":"content-type"});return res.end();}
 if((req.url==="/"||req.url==="/private-server.html")&&req.method==="GET"){
  try{const html=await readFile(clientHtml,"utf8");res.writeHead(200,{"content-type":"text/html; charset=utf-8"});return res.end(html);}
  catch{return json(res,500,{error:"client not found"});}
 }
 if(req.url==="/state"&&req.method==="GET")return json(res,200,snapshot());
 if(req.url==="/input"&&req.method==="POST"){
  try{const value:unknown=JSON.parse(await body(req));if(!isInput(value))return json(res,400,{error:"invalid input"});enqueueInput(state,value);return json(res,202,{accepted:true,tick:state.tick,sequence:state.nextInputSequence-1,queuedInputs:state.pendingInputs.length});}
  catch{return json(res,400,{error:"invalid JSON"});}
 }
 if(req.url==="/tick"&&req.method==="POST"){step(state);broadcast();return json(res,200,snapshot());}
 if(req.url==="/events"&&req.method==="GET"){
  clients.add(res);req.on("close",()=>clients.delete(res));res.writeHead(200,{"content-type":"text/event-stream; charset=utf-8","cache-control":"no-cache",connection:"keep-alive","access-control-allow-origin":"*"});res.write(`data: ${JSON.stringify(snapshot())}

`);return;
 }
 return json(res,404,{error:"not found"});
});
let last=Date.now();
setInterval(()=>{const now=Date.now();if(now-last>=600){const ticks=Math.min(4,Math.floor((now-last)/600));for(let i=0;i<ticks;i++)step(state);last+=ticks*600;broadcast();}},50);
server.listen(8080,()=>console.log("Private-server prototype listening on http://localhost:8080"));
