import fs from 'node:fs';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
const f=JSON.parse(fs.readFileSync('/tmp/42-hub-verification-fixture.json'));let cookie;
async function api(path,method='GET',body){const r=await fetch(f.base+path,{method,headers:{'content-type':'application/json',origin:f.base,cookie:cookie||''},body:body?JSON.stringify(body):undefined});if(r.headers.getSetCookie().length)cookie=r.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');const data=await r.json();assert.ok(r.ok,JSON.stringify(data));return data;}
await api('/api/auth/login','POST',{email:f.email,password:f.password});const d=await api('/api/dashboard');const original=await api('/api/rooms/'+f.roomId);
for(const mode of ['undercover','werewolf']){
 const {id}=await api('/api/rooms','POST',{title:`真人 ${mode} 全流程验证`,topic:'',mode,agentIds:Array(mode==='werewolf'?5:3).fill(d.agents[0].id),joinAsParticipant:true,executionMode:'demo',options:{...original.options,maxRounds:2,civilianWord:'咖啡',undercoverWord:'奶茶'}});
 await api(`/api/rooms/${id}/control`,'POST',{action:'start'});let room,actions=0;const end=Date.now()+100000;
 while(Date.now()<end){room=await api('/api/rooms/'+id);if(room.status==='completed')break;assert.notEqual(room.status,'error',room.error);
 const tools=room.self.tools;const tool=tools.find(t=>!['send_private_message','send_group_message'].includes(t.name)) || tools.find(t=>t.name==='send_group_message');
 if(tool){const args={};for(const [name,property] of Object.entries(tool.inputSchema.properties))args[name]=name==='content'?`真人按规则提交第 ${room.round} 轮行动`:property.enum[0];await api(`/api/rooms/${id}/actions`,'POST',{toolName:tool.name,args,phaseVersion:room.self.phaseVersion,actionId:randomUUID()});actions++;}
 await new Promise(r=>setTimeout(r,180));}
 assert.equal(room.status,'completed',JSON.stringify(room));assert.ok(actions>0);assert.ok(room.events.some(e=>e.senderId===room.self.participantId));console.log(`PASS: ${mode} human seat completed ${actions} speech/vote/role/recap actions through shared backend.`);
}
