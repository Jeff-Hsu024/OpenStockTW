import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MongoClient } from "mongodb";
import { runDueOnce } from "@/scripts/agent-worker.mjs";

const uri=process.env.OPENSTOCK_INTEGRATION_MONGODB_URI;
describe.skipIf(!uri)("Durable read-only agent watch executor",()=>{
  let client: MongoClient;
  let db: ReturnType<MongoClient["db"]>;
  beforeAll(async()=>{
    client=new MongoClient(uri!);
    await client.connect();
    db=client.db();
  });
  beforeEach(async()=>{
    await db.collection("agentwatches").deleteMany({});
    await db.collection("agentobservations").deleteMany({});
  });
  afterAll(async()=>{ await client.close(); });

  it("claims one due watch, stores an observation and schedules next run",async()=>{
    const now=new Date("2026-11-19T01:00:00Z");
    const {insertedId}=await db.collection("agentwatches").insertOne({
      userId:"test",symbol:"TWSE:2330",active:true,intervalMinutes:15,nextRunAt:now
    });
    const fetchImpl=vi.fn(async(_url:RequestInfo | URL,init?:RequestInit)=>{
      const body=JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        jsonrpc:"2.0",id:body.id,
        result:body.method==="initialize" ? {serverInfo:{name:"openstocktw"}} :
          {content:[{type:"text",text:JSON.stringify({quote:{c:100,t:1795059600}})}]}
      }),{status:200,headers:{"content-type":"application/json"}});
    });
    const executed=await runDueOnce({db,now,owner:"agent-test",token:"test-secret",endpoint:"http://localhost/api/mcp",fetchImpl});
    expect(executed?.status).toBe("ok");
    expect((await db.collection("agentobservations").countDocuments({watchId:String(insertedId)}))).toBe(1);
    expect((await db.collection("agentwatches").findOne({_id:insertedId}))?.nextRunAt).toEqual(new Date(now.getTime()+15*60000));
    expect(await runDueOnce({db,now,owner:"agent-second",token:"test-secret",endpoint:"http://localhost/api/mcp",fetchImpl})).toBe(null);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("won't duplicate an observation after crash between write and scheduling",async()=>{
    const now=new Date("2026-11-19T01:00:00Z");
    const id=(await db.collection("agentwatches").insertOne({
      userId:"test",symbol:"TWSE:2330",active:true,intervalMinutes:15,nextRunAt:now
    })).insertedId;
    await db.collection("agentobservations").insertOne({
      watchId:String(id),scheduledAt:now,status:"ok",quote:{c:80}
    });
    const fetchImpl=vi.fn();
    const result=await runDueOnce({db,now,owner:"agent-test",token:"token",endpoint:"http://localhost/api/mcp",fetchImpl});
    expect(result?.status).toBe("already_recorded");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await db.collection("agentobservations").countDocuments({watchId:String(id)})).toBe(1);
  });

  it("records request failures without causing a tight retry loop",async()=>{
    const now=new Date("2026-11-19T01:00:00Z");
    const id=(await db.collection("agentwatches").insertOne({
      userId:"test",symbol:"TPEX:5483",active:true,intervalMinutes:15,nextRunAt:now
    })).insertedId;
    const result=await runDueOnce({
      db,now,owner:"agent-test",token:"token",endpoint:"http://localhost/api/mcp",
      fetchImpl:vi.fn(async()=>new Response("upstream failed",{status:500}))
    });
    expect(result?.status).toBe("failed");
    expect((await db.collection("agentwatches").findOne({_id:id}))?.nextRunAt.getTime()).toBeGreaterThan(now.getTime());
    expect((await db.collection("agentobservations").findOne({watchId:String(id)}))?.status).toBe("failed");
  });
});
