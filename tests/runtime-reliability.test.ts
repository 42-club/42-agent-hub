import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCoordinator } from "../server/coordinator-runtime";
import { SharedHubStore, StorageError, type RecordRow, hubEnvironment } from "../server/shared-store";
import type { AgentRunInput } from "../server/agent-process-manager";
import type { RoomRecord } from "../server/store";
import { createGame } from "../src/domain/engine";
import { DEFAULT_OPTIONS } from "../src/domain/types";
import { RequestIdentity } from "../src/lib/idempotency";

const waitFor = async (predicate: () => boolean) => {
  const deadline = Date.now() + 5000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error("Fixture timed out"); await new Promise((r) => setTimeout(r, 5)); }
};
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; };

/** Fake storage transport, real coordinator/engine/HTTP. No provider calls or user database. */
test("runtime reliability: fenced execution, isolation, idempotency, and authoritative recovery", { timeout: 30000 }, async (t) => {
  const rows = new Map<string, RecordRow & { writeId?: string }>();
  const leases = new Map<string, { owner: string; expires: number }>();
  const failures = new Map<string, number>();
  const loseAck = new Set<string>();
  let writes = 0;
  const transport = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    const parts = request.url!.split("/").filter(Boolean);
    const id = parts[parts.indexOf("records") + 1];
    const send = (value: unknown, status = 200) => { response.writeHead(status); response.end(JSON.stringify(value)); };
    if (request.method === "GET" && id === "leases") { send([...leases].filter(([,lease])=>lease.expires<=Date.now()).map(([scope,lease])=>({scope,owner:lease.owner}))); return; }
    if (request.method === "GET") { send(id ? rows.get(id) ?? null : [...rows.values()]); return; }
    let raw = ""; for await (const chunk of request) raw += chunk;
    const input = raw ? JSON.parse(raw) : {};
    if (id === "lease") {
      const scope = parts[parts.indexOf("lease") + 1];
      const previous = leases.get(scope);
      const owner = input.owner ?? parts.at(-1);
      if (request.method === "DELETE") { if (previous && previous.owner === owner) previous.expires = 0; send({ ok: true }); return; }
      if (input.renew ? (!previous || previous.owner !== owner || previous.expires <= Date.now()) : (previous && previous.expires > Date.now())) { send({},409); return; }
      leases.set(scope, { owner, expires: Date.now() + 60000 }); send({ ok: true, previousOwner: previous?.owner ?? null }); return;
    }
    if (failures.has(id)) { if(failures.get(id)===0) response.destroy(); else send({},failures.get(id)); return; }
    const previous = rows.get(id);
    if (input.leaseOwner && (leases.get(id)?.owner !== input.leaseOwner || leases.get(id)!.expires <= Date.now())) { send({},409); return; }
    if (previous?.writeId === input.writeId) { send({ version: previous!.version }); return; }
    if ((previous?.version ?? 0) !== input.version) { send({},409); return; }
    rows.set(id, { ...input, id, version: input.version + 1 }); writes++;
    if (loseAck.delete(id)) { response.destroy(); return; }
    send({ version: input.version + 1 });
  });
  await new Promise<void>((r) => transport.listen(0,"127.0.0.1",r));
  const old = { url: process.env.CLUB_SERVICE_URL, token: process.env.HUB_SERVICE_TOKEN };
  process.env.CLUB_SERVICE_URL = `http://127.0.0.1:${(transport.address() as {port:number}).port}`;
  process.env.HUB_SERVICE_TOKEN = "isolated-reliability-test-token-123456789";
  const organizationId = randomUUID(), userId = randomUUID();
  const runtimes: Awaited<ReturnType<typeof createCoordinator>>[] = [];
  const directories: string[] = [];
  const seed = (human = false) => {
    const id = randomUUID();
    const people = [0,1].map((seat) => ({ id:randomUUID(),agentId:"a",providerId:"p",vendor:"test",modelId:"test",modelName:"Fixture",color:"#123456",seat:seat+1, ...(human ? {kind:"human" as const,userId:seat === 0 ? userId : randomUUID()} : {}) }));
    const room: RoomRecord = { id,organizationId,ownerId:userId,executionGeneration:1,input:{title:"Fixture",topic:"Question",mode:"debate",agentIds:["a","a"],executionMode:"demo",options:DEFAULT_OPTIONS},game:createGame("debate",people,DEFAULT_OPTIONS,"Question"),status:"running",error:null,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString() };
    rows.set(id,{id,organizationId,kind:"room",version:1,data:structuredClone(room)}); return room;
  };
  const runtime = async (cloud = true) => {
    const calls: AgentRunInput[] = [];
    const gates: ReturnType<typeof deferred>[] = [];
    const manager = { run: async (input: AgentRunInput) => { calls.push(input); const gate = deferred(); gates.push(gate); await gate.promise; }, closeRoom:async()=>{},cancelRoom:async()=>{},close:async()=>{for(const gate of gates)gate.resolve();} };
    const dataDir = await mkdtemp(join(tmpdir(),"42-reliability-")); directories.push(dataDir);
    const token = randomUUID();
    const store = await new SharedHubStore().initialize();
    const coordinator = await createCoordinator({token,dataDir,store,cloud,manager}); runtimes.push(coordinator);
    await new Promise<void>((r) => coordinator.server.listen(0,"127.0.0.1",r));
    const base = `http://127.0.0.1:${(coordinator.server.address() as {port:number}).port}`;
    const api = async (id: string, action: string, input?: unknown, extra: Record<string,string> = {}, method = "POST") => fetch(`${base}/api/rooms/${id}/${action}`,{method,headers:{authorization:`Bearer ${token}`,"content-type":"application/json","x-hub-user-id":userId,"x-hub-organization-id":organizationId,"x-hub-role":"owner","idempotency-key":randomUUID(),...extra},body:input === undefined ? undefined : JSON.stringify(action === "control" ? {generation:(rows.get(id)!.data as RoomRecord).executionGeneration ?? 0,...input as object} : input)});
    return {coordinator,store,calls,gates,api};
  };
  try {
    await t.test("local startup leaves another owner's running room byte-for-byte unchanged", async()=>{
      const room=seed(); leases.set(room.id,{owner:randomUUID(),expires:Date.now()+60000});
      const before=structuredClone(rows.get(room.id)); const count=writes;
      await runtime(false);
      assert.deepEqual(rows.get(room.id),before); assert.equal(writes,count);
    });
    await t.test("restart recovers only the recorded expired owner and never invokes a model",async()=>{
      const room=seed(); const owner=randomUUID();
      (rows.get(room.id)!.data as RoomRecord).cloudAttempt={phaseVersion:1,participantIds:[room.game.participants[0].id],owner,generation:1};
      leases.set(room.id,{owner,expires:0});
      const restored=await runtime(false);
      assert.equal((rows.get(room.id)!.data as RoomRecord).status,"paused"); assert.equal(restored.calls.length,0);
      const unknown=seed(); (rows.get(unknown.id)!.data as RoomRecord).cloudAttempt={phaseVersion:1,participantIds:[unknown.game.participants[0].id],owner:randomUUID(),generation:1};
      await runtime(false); assert.equal((rows.get(unknown.id)!.data as RoomRecord).status,"running");
    });
    for (const action of ["pause","stop"]) await t.test(`slow model allows ${action}; late action cannot cross generation`,async()=>{
      const room=seed(); const worker=await runtime(); const control=await runtime();
      const tick=worker.coordinator.tick(room.id,1); await waitFor(()=>worker.calls.length>0);
      const before=Date.now(); const result=await control.api(room.id,"control",{action,generation:1},{"idempotency-key":randomUUID()});
      assert.equal(result.status,200); assert.ok(Date.now()-before<1000);
      assert.equal(worker.gates.length,1,"slow model has not returned");
      await waitFor(()=>worker.calls[0].signal!.aborted);
      if(action==="pause") assert.equal((await control.api(room.id,"control",{action:"resume",generation:2},{"idempotency-key":randomUUID()})).status,200);
      await assert.rejects(worker.calls[0].onAction("send_group_message",{content:"late",channelId:"public"},randomUUID()));
      worker.gates.forEach((gate)=>gate.resolve()); await tick;
      const state=rows.get(room.id)!.data as RoomRecord;
      assert.equal(state.game.events.some((event)=>event.content==="late"),false);
      assert.equal(state.status,action==="stop"?"completed":"running");
    });
    await t.test("confirmed model action survives stop and stream interruption",async()=>{
      const room=seed(); const worker=await runtime(); const control=await runtime();
      const tick=worker.coordinator.tick(room.id,1); await waitFor(()=>worker.calls.length>0);
      const call=worker.calls[0]; await call.onAction("send_group_message",{content:"confirmed",channelId:"public"},randomUUID());
      assert.equal((await control.api(room.id,"control",{action:"stop"})).status,200);
      worker.gates.forEach((gate)=>gate.resolve()); await tick;
      assert.equal((rows.get(room.id)!.data as RoomRecord).game.events.filter((event)=>event.content==="confirmed").length,1);
    });
    await t.test("duplicate workflows and expired executor never dispatch the same action twice",async()=>{
      const room=seed(); const first=await runtime(); const duplicate=await runtime();
      const tick=first.coordinator.tick(room.id,1); await waitFor(()=>first.calls.length>0);
      await duplicate.coordinator.tick(room.id,1); assert.equal(duplicate.calls.length,0);
      leases.get(room.id)!.expires=0;
      await duplicate.coordinator.tick(room.id,1);
      assert.equal(duplicate.calls.length,0); assert.equal((rows.get(room.id)!.data as RoomRecord).status,"paused");
      await assert.rejects(first.calls[0].onAction("send_group_message",{content:"expired",channelId:"public"},randomUUID()));
      first.gates.forEach((gate)=>gate.resolve()); await tick;
      assert.equal((rows.get(room.id)!.data as RoomRecord).status,"paused");
    });
    await t.test("one room failure is isolated; transport replay commits once without another model call",async()=>{
      const a=seed(),b=seed(); const store=await new SharedHubStore().initialize();
      failures.set(a.id,403); store.saveRoom({...a,status:"paused"}); await assert.rejects(store.flush(a.id),(e:StorageError)=>e.kind==="permission");
      store.saveRoom({...b,status:"paused"}); await store.flush(b.id); assert.equal(store.getCommittedRoom(b.id)?.status,"paused");
      failures.delete(a.id); await store.refresh(a.id); const room=store.getRoom(a.id)!;
      loseAck.add(a.id); const count=writes; room.status="paused"; store.saveRoom(room); await store.flush(a.id); assert.equal(writes,count+1);
      const c=seed(); const worker=await runtime(); const tick=worker.coordinator.tick(c.id,1); await waitFor(()=>worker.calls.length>0);
      loseAck.add(c.id); await worker.calls[0].onAction("send_group_message",{content:"only once",channelId:"public"},randomUUID());
      worker.gates.forEach((gate)=>gate.resolve()); await tick;
      assert.equal(worker.calls.length,1); assert.equal((rows.get(c.id)!.data as RoomRecord).game.events.filter((event)=>event.content==="only once").length,1);
    });
    await t.test("permanent network failure preserves attempt for recovery without rebilling",async()=>{
      const room=seed(); const worker=await runtime(); const tick=worker.coordinator.tick(room.id,1);
      await waitFor(()=>worker.calls.length>0); failures.set(room.id,0);
      await assert.rejects(worker.calls[0].onAction("send_group_message",{content:"uncertain",channelId:"public"},randomUUID()),(e:StorageError)=>e.kind==="network");
      worker.gates.forEach((gate)=>gate.resolve()); await tick; failures.delete(room.id);
      const recovery=await runtime(); await recovery.coordinator.tick(room.id,1);
      assert.equal(worker.calls.length,1); assert.equal(recovery.calls.length,0);
      assert.equal((rows.get(room.id)!.data as RoomRecord).status,"paused");
    });
    await t.test("concurrent human action retries, seats, controls and organization authorization",async()=>{
      const room=seed(true); const a=await runtime(),b=await runtime();
      const action={toolName:"send_group_message",args:{content:"human",channelId:"public"},actionId:randomUUID(),phaseVersion:1};
      const responses=await Promise.all([a.api(room.id,"actions",action),b.api(room.id,"actions",action)]);
      assert.ok(responses.every((r)=>[200,409].includes(r.status)));
      assert.equal((await b.api(room.id,"actions",action)).status,200);
      assert.equal((rows.get(room.id)!.data as RoomRecord).game.events.filter((event)=>event.content==="human").length,1);
      assert.equal((await a.api(room.id,"actions",{...action,actionId:randomUUID()})).status,409,"turn cannot repeat using a new ID");
      assert.equal((await a.api(room.id,"control",{action:"stop"},{"x-hub-user-id":randomUUID()})).status,403);
      assert.equal((await a.api(room.id,"control",{action:"stop"},{"x-hub-role":"viewer"})).status,403);
      assert.equal((await a.api(room.id,"control",{action:"stop"},{"x-hub-organization-id":randomUUID()})).status,404);
      const key=randomUUID(); const input={action:"pause",generation:1};
      assert.equal((await a.api(room.id,"control",input,{"idempotency-key":key})).status,200);
      assert.equal((await b.api(room.id,"control",input,{"idempotency-key":key})).status,200);
      assert.equal((rows.get(room.id)!.data as RoomRecord).executionGeneration,2);
      assert.equal((await a.api(room.id,"actions",action)).status,200,"confirmed replay is acknowledged after pause");
      assert.equal((await a.api(room.id,"actions",{...action,args:{content:"changed"}})).status,409);
      const waiting=seed(); (rows.get(waiting.id)!.data as RoomRecord).status="waiting";
      const seatKey=randomUUID(); await Promise.all([a.api(waiting.id,"seat",{},{"idempotency-key":seatKey}),b.api(waiting.id,"seat",{},{"idempotency-key":seatKey})]);
      assert.equal((await a.api(waiting.id,"seat",{},{"idempotency-key":seatKey})).status,200);
      assert.equal((rows.get(waiting.id)!.data as RoomRecord).game.participants.filter((p)=>p.userId===userId).length,1);
      const noop=randomUUID(); assert.equal((await a.api(waiting.id,"seat",{},{"idempotency-key":noop})).status,200);
      assert.equal((await a.api(waiting.id,"seat",undefined,{},"DELETE")).status,200);
      assert.equal((await b.api(waiting.id,"seat",{},{"idempotency-key":noop})).status,200);
      assert.equal((rows.get(waiting.id)!.data as RoomRecord).game.participants.filter((p)=>p.userId===userId).length,0,"replayed no-op cannot reoccupy a seat");
    });
  } finally {
    for (const runtime of runtimes) await runtime.close();
    for (const directory of directories) await rm(directory,{recursive:true,force:true});
    await new Promise<void>((r)=>transport.close(()=>r()));
    if(old.url===undefined)delete process.env.CLUB_SERVICE_URL;else process.env.CLUB_SERVICE_URL=old.url;
    if(old.token===undefined)delete process.env.HUB_SERVICE_TOKEN;else process.env.HUB_SERVICE_TOKEN=old.token;
  }
});

test("client keys survive uncertain responses and change only for new intent",()=>{
  const keys=new RequestIdentity(); const first=keys.key("pause:1"); assert.equal(keys.key("pause:1"),first);
  assert.notEqual(keys.key("pause:2"),first); keys.confirmed(); assert.notEqual(keys.key("pause:1"),first);
});

test("development cannot identify itself as production from deployment flag alone",()=>{
  const previous={node:process.env.NODE_ENV,deploy:process.env.HUB_DEPLOYMENT_ENV,vercel:process.env.VERCEL_ENV};
  try { Object.assign(process.env,{NODE_ENV:"development"});process.env.HUB_DEPLOYMENT_ENV="production";assert.equal(hubEnvironment(),"development");Object.assign(process.env,{NODE_ENV:"production"});process.env.VERCEL_ENV="preview";assert.equal(hubEnvironment(),"development"); }
  finally { for(const [key,value]of Object.entries({NODE_ENV:previous.node,HUB_DEPLOYMENT_ENV:previous.deploy,VERCEL_ENV:previous.vercel}))if(value===undefined)delete process.env[key];else process.env[key]=value; }
});
