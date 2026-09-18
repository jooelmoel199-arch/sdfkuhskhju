export interface Tile { x: number; y: number; }

export const MAP_WIDTH = 30;
export const MAP_HEIGHT = 20;

// Small deterministic collision map used by the prototype. The same abstraction
// can later be backed by decoded OSRS map collision flags without changing the
// movement/combat API.
const blocked = new Set<string>();
for (let y=0;y<MAP_HEIGHT;y++) {
  if (y===0 || y===MAP_HEIGHT-1) for (let x=0;x<MAP_WIDTH;x++) blocked.add(`${x},${y}`);
}
for (let x=0;x<MAP_WIDTH;x++) if (x===0 || x===MAP_WIDTH-1) for (let y=0;y<MAP_HEIGHT;y++) blocked.add(`${x},${y}`);

export function isWalkable(x:number,y:number):boolean {
  return x>=0 && y>=0 && x<MAP_WIDTH && y<MAP_HEIGHT && !blocked.has(`${x},${y}`);
}

export function findPath(start:Tile, goal:Tile):Tile[] {
  if (!isWalkable(goal.x,goal.y)) return [];
  if (start.x===goal.x && start.y===goal.y) return [];
  const key=(t:Tile)=>`${t.x},${t.y}`;
  const queue:Tile[]=[start];
  const came=new Map<string,string>();
  const seen=new Set<string>([key(start)]);
  for(let i=0;i<queue.length;i++){
    const cur=queue[i];
    const nexts=[
      {x:cur.x+1,y:cur.y},{x:cur.x-1,y:cur.y},{x:cur.x,y:cur.y+1},{x:cur.x,y:cur.y-1},
      {x:cur.x+1,y:cur.y+1},{x:cur.x+1,y:cur.y-1},{x:cur.x-1,y:cur.y+1},{x:cur.x-1,y:cur.y-1}
    ];
    for(const next of nexts){
      const diagonal=next.x!==cur.x&&next.y!==cur.y;
      // Do not cut through a blocked corner when walking diagonally.
      if(diagonal&&(!isWalkable(next.x,cur.y)||!isWalkable(cur.x,next.y))) continue;
      const nk=key(next); if(seen.has(nk)||!isWalkable(next.x,next.y)) continue;
      seen.add(nk); came.set(nk,key(cur));
      if(next.x===goal.x&&next.y===goal.y){
        const path:Tile[]=[]; let k=nk;
        while(k!==key(start)){const [x,y]=k.split(',').map(Number);path.push({x,y});k=came.get(k)!;}
        path.reverse(); return path;
      }
      queue.push(next);
    }
  }
  return [];
}

export function stepToward(start:Tile, goal:Tile):Tile {
  const path=findPath(start,goal);
  return path[0] ?? start;
}
