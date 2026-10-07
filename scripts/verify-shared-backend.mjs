import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
const base = process.env.HUB_VERIFY_URL || 'http://127.0.0.1:3019';
const suffix = Date.now();
const password = 'Hub-verification-only-2026';
function client() {
  let cookies = new Map();
  return async (path, method = 'GET', body, expected = 200) => {
    const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', origin: base, cookie: [...cookies].map(([k,v]) => `${k}=${v}`).join('; ') }, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const cookie of res.headers.getSetCookie()) { const pair = cookie.split(';')[0]; const at = pair.indexOf('='); cookies.set(pair.slice(0,at), pair.slice(at+1)); }
    const result = await res.json();
    assert.equal(res.status, expected, `${method} ${path}: ${JSON.stringify(result)}`);
    assert.equal(JSON.stringify(result).includes('accessToken'), false, 'JWT leaked into JSON');
    return result;
  };
}
const owner = client(), member = client(), outsider = client(), guest = client();
async function register(api, name) {
  const email = `hub-${randomUUID().slice(0,8)}-${suffix}@example.com`;
  await api('/api/auth/register', 'POST', { email, displayName: name, password });
  await api('/api/auth/verify-email', 'POST', { email, code: process.env.HUB_VERIFY_CODE || '424242' });
  const { user } = await api('/api/auth/session');
  assert.ok(user.id); return { email, user };
}
async function until(read, predicate, timeout = 20000) {
  const end = Date.now()+timeout;
  while(Date.now()<end){ const value=await read(); if(predicate(value))return value; await new Promise(r=>setTimeout(r,120)); }
  throw new Error('Timed out waiting for turn');
}
await guest('/api/dashboard', 'GET', undefined, 401);
const a = await register(owner, '圆桌主人');
const b = await register(member, '圆桌成员');
await register(outsider, '其他组织');
await owner('/api/organizations', 'POST', { name: '42 验证组织', domain: `hub-${suffix}.example.com` });
await outsider('/api/organizations', 'POST', { name: '隔离组织', domain: `outside-${suffix}.example.com` });
let session = await owner('/api/auth/session');
const org = session.activeOrganization;
assert.ok(org.id);
await owner(`/api/organizations/${org.id}/invitations`, 'POST', { email: b.email });
const invites = await member('/api/organizations/invitations');
await member(`/api/organizations/invitations/${invites[0].id}/accept`, 'POST', {});
assert.equal((await member('/api/auth/session')).activeOrganization.id, org.id);
const members = await owner(`/api/organizations/${org.id}/members`);
assert.equal(members.length, 2);
await outsider(`/api/organizations/${org.id}/members`, 'GET', undefined, 403);
const provider = await owner('/api/providers', 'POST', { name:'Integration demo', kind:'openrouter', baseUrl:'https://openrouter.ai/api/v1' });
const agent = await owner('/api/agents', 'POST', { providerId:provider.id, vendor:'OpenAI', modelId:'openai/gpt-5.4', modelName:'验证 Agent' });
await member('/api/providers', 'POST', { name:'Forbidden', kind:'openrouter', baseUrl:'https://openrouter.ai/api/v1' },403);
const options = { rounds:2, allowPrivateMessages:true, undercoverCount:1, civilianWord:'咖啡', undercoverWord:'奶茶', werewolfCount:2, hasSeer:true, hasWitch:true, hasHunter:false, hasGuard:false, hasBomber:false, hasWolfKing:false, maxRounds:2, revealRolesAtStart:false };
const { id } = await owner('/api/rooms', 'POST', { title:'真人轮次与共享组织验证', topic:'每一种声音都应被听见', mode:'debate', agentIds:[agent.id], joinAsParticipant:true, executionMode:'demo', options },201);
await member(`/api/rooms/${id}/seat`, 'POST', {});
await member(`/api/rooms/${id}/seat`, 'POST', {},409);
await outsider(`/api/rooms/${id}`, 'GET',undefined,404);
await outsider(`/api/rooms/${id}/seat`, 'POST',{},404);
await member(`/api/rooms/${id}/control`, 'POST',{action:'start'},403);
await owner(`/api/rooms/${id}/control`, 'POST',{action:'start'});
await member(`/api/rooms/${id}/seat`, 'DELETE', undefined,409);
let room = await member(`/api/rooms/${id}`);
await member(`/api/rooms/${id}/actions`, 'POST',{toolName:'send_group_message',args:{channelId:'public',content:'插队应被拒绝'},actionId:randomUUID(),phaseVersion:room.self.phaseVersion},409);
for(let round=1;round<=2;round++) {
  room = await until(()=>owner(`/api/rooms/${id}`), r=>r.self.tools.some(t=>t.name==='send_group_message'));
  assert.equal(room.round,round);
  const ownId = room.self.participantId;
  if(round===1){
    const recipient = room.participants.find(p=>p.userId===b.user.id).id;
    await owner(`/api/rooms/${id}/actions`,'POST',{toolName:'send_private_message',args:{recipientId:recipient,content:'ONLY_THESE_TWO'},phaseVersion:room.self.phaseVersion,actionId:randomUUID()});
    assert.equal((await member(`/api/rooms/${id}`)).privateMessages.length,1);
  }
  const action={toolName:'send_group_message',args:{channelId:'public',content:`主人第 ${round} 轮`},phaseVersion:room.self.phaseVersion,actionId:randomUUID()};
  await owner(`/api/rooms/${id}/actions`,'POST',action);
  const after = await owner(`/api/rooms/${id}/actions`,'POST',action);
  assert.equal(after.events.filter(e=>e.senderId===ownId&&e.round===round).length,1);
  room=await until(()=>member(`/api/rooms/${id}`),r=>r.self.tools.some(t=>t.name==='send_group_message'));
  await member(`/api/rooms/${id}/actions`,'POST',{toolName:'send_group_message',args:{channelId:'public',content:`成员第 ${round} 轮`},phaseVersion:room.self.phaseVersion,actionId:randomUUID()});
}
room=await until(()=>owner(`/api/rooms/${id}`),r=>r.status==='completed');
assert.equal(room.events.filter(e=>e.type==='message').length,6);
assert.equal(room.events.some(e=>e.content.includes('ONLY_THESE_TWO')),false);
assert.equal((await outsider('/api/dashboard')).rooms.length,0);
const wolf=await owner('/api/rooms','POST',{title:'真人隐藏身份验证',topic:'',mode:'werewolf',agentIds:Array(6).fill(agent.id),joinAsParticipant:true,executionMode:'demo',options:{...options,revealRolesAtStart:true}},201);
const before=await member(`/api/rooms/${wolf.id}`);
assert.ok(before.participants.every(p=>!p.role));
assert.equal(before.self,undefined);
await owner('/api/auth/logout','POST',{});
await owner('/api/dashboard','GET',undefined,401);
await owner('/api/auth/login','POST',{email:a.email,password});
assert.equal((await owner(`/api/rooms/${id}`)).status,'completed');
writeFileSync('/tmp/42-hub-verification-fixture.json',JSON.stringify({ base,email:a.email,password,memberEmail:b.email,roomId:id,wolfRoomId:wolf.id,organizationId:org.id }),{mode:0o600});
console.log('PASS: registration, verification, login/logout, shared members, invitations, organization isolation, admin controls, seats, sequential turns, idempotency, private visibility, hidden roles, persisted replay.');
