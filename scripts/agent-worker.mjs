/**
 * Durable read-only market watcher. No trading action or tool accepts a
 * decision here; only quote snapshots and diagnostics are persisted.
 * Run: OPENSTOCK_AGENT_ENABLE=true node scripts/agent-worker.mjs
 */
import { config } from "dotenv";
import { MongoClient } from "mongodb";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const parseRpcResponse = async (response) => {
  const body=await response.text();
  if (!response.ok) throw new Error("MCP transport HTTP " + response.status + ": " + body.slice(0,250));
  if ((response.headers.get("content-type")??"").includes("text/event-stream")) {
    const event=body.split(/\r?\n/).find(line=>line.startsWith("data: "));
    if (!event) throw new Error("No MCP SSE response");
    return JSON.parse(event.slice(6));
  }
  return JSON.parse(body);
};
async function rpc(endpoint,token,method,params,id,fetchImpl) {
  const response=await fetchImpl(endpoint,{
    method:"POST",
    headers:{
      Authorization:"Bearer "+token,
      Accept:"application/json, text/event-stream",
      "Content-Type":"application/json",
      "MCP-Protocol-Version":"2025-06-18"
    },
    body:JSON.stringify({jsonrpc:"2.0",id,method,params}),
    signal:AbortSignal.timeout(20000)
  });
  const parsed=await parseRpcResponse(response);
  if (parsed.error) throw new Error("MCP "+method+": "+JSON.stringify(parsed.error));
  if (parsed.result?.isError) throw new Error("MCP tool failed: "+parsed.result?.content?.[0]?.text);
  return parsed.result;
}

export async function runDueOnce({
  db,owner=String(randomUUID()),now=new Date(),token,endpoint="http://127.0.0.1:3000/api/mcp",
  fetchImpl=fetch,leaseMs=60000
}) {
  if (!token) throw new Error("OPENSTOCK_MCP_TOKEN is required");
  const watches=db.collection("agentwatches"), observations=db.collection("agentobservations");
  const watch=await watches.findOneAndUpdate({
    active:true,nextRunAt:{$lte:now},
    $or:[{leaseUntil:{$exists:false}},{leaseUntil:null},{leaseUntil:{$lte:now}}]
  },{
    $set:{leaseOwner:owner,leaseUntil:new Date(now.getTime()+leaseMs)}
  },{sort:{nextRunAt:1},returnDocument:"after"});
  if (!watch) return null;
  const scheduledAt=new Date(watch.nextRunAt);
  const identity={watchId:String(watch._id),scheduledAt};
  let status="ok",quote,detail,observedAt=new Date();
  try {
    const prior=await observations.findOne(identity);
    if (prior) { status="already_recorded"; }
    else {
      await rpc(endpoint,token,"initialize",{
        protocolVersion:"2025-06-18",capabilities:{},
        clientInfo:{name:"openstocktw-agent-watch",version:"0.1.0"}
      },1,fetchImpl);
      const result=await rpc(endpoint,token,"tools/call",{
        name:"stock_get_quote",arguments:{symbol:watch.symbol}
      },2,fetchImpl);
      const parsed=JSON.parse(result?.content?.find(x=>x.type==="text")?.text??"{}");
      if (!parsed.quote || !Number.isFinite(parsed.quote.c) || parsed.quote.c <= 0) throw new Error("Indicative quote unavailable");
      quote=parsed.quote;
    }
  } catch(e) {status="failed";detail=String(e instanceof Error?e.message:e).slice(0,500);}
  if (status!=="already_recorded") {
    await observations.updateOne(identity,{
      $setOnInsert:{
        ...identity,userId:watch.userId,symbol:watch.symbol,
        status,quote,detail,observedAt
      }
    },{upsert:true});
  }
  const minutes=status==="failed" ? Math.min(5,Math.max(1,watch.intervalMinutes)) : watch.intervalMinutes;
  await watches.updateOne({_id:watch._id,leaseOwner:owner},{
    $set:{
      nextRunAt:new Date(now.getTime()+minutes*60000),
      lastRunAt:observedAt,lastStatus:status==="already_recorded"?"ok":status,
      lastError:status==="failed"?detail:null
    },
    $unset:{leaseOwner:"",leaseUntil:""}
  });
  return {status,watchId:String(watch._id),symbol:watch.symbol,price:quote?.c,detail};
}

async function main() {
  config({path:".env.local",quiet:true});
  if (process.env.OPENSTOCK_AGENT_ENABLE!=="true" && !process.argv.includes("--run")) {
    throw new Error("Read-only agent runner disabled: set OPENSTOCK_AGENT_ENABLE=true");
  }
  if (!process.env.MONGODB_URI || !process.env.OPENSTOCK_MCP_TOKEN) {
    throw new Error("MONGODB_URI and OPENSTOCK_MCP_TOKEN must be set");
  }
  const client=new MongoClient(process.env.MONGODB_URI,{serverSelectionTimeoutMS:5000});
  await client.connect();
  const db=client.db();
  await db.collection("agentobservations").createIndex(
    {watchId:1,scheduledAt:1},{unique:true});
  await db.collection("agentworkerheartbeats").createIndex(
    {lastSeenAt:1},{expireAfterSeconds:86400});
  const owner="agent-"+randomUUID();
  console.log("OpenStockTW observation worker ready",owner);
  const pollMs=Math.max(1000,Math.min(120000,Number(process.env.OPENSTOCK_AGENT_POLL_MS||30000)));
  let alive=true;
  process.once("SIGINT",()=>{alive=false;});
  process.once("SIGTERM",()=>{alive=false;});
  try {
    do {
      let hadWork=false;
      try {
        await db.collection("agentworkerheartbeats").updateOne({owner},{
          $set:{owner,lastSeenAt:new Date(),kind:"read-only",pollMs}
        },{upsert:true});
        const result=await runDueOnce({
          db,owner,token:process.env.OPENSTOCK_MCP_TOKEN,
          endpoint:process.env.OPENSTOCK_MCP_URL||"http://127.0.0.1:3000/api/mcp"
        });
        if (result) console.log(JSON.stringify({time:new Date().toISOString(),...result}));
        hadWork=Boolean(result);
      } catch(error) {
        console.error("Agent watch loop failed:",error instanceof Error?error.message:error);
        if (process.argv.includes("--once")) throw error;
      }
      if (process.argv.includes("--once")) break;
      if (!hadWork) await new Promise(resolve=>setTimeout(resolve,pollMs));
    } while(alive);
  } finally {await client.close();}
}
if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  main().catch((error)=>{console.error(error);process.exitCode=1;});
}
