import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { validateHubRuntime } from './runtime-config.mjs';
import { accessPolicy } from './access-policy.mjs';
import { serviceRequest } from './service-request.mjs';

// Explicit isolated-preview acceptance. Creates ONE labelled live room and
// preserves its evidence. Never automatically repeats uncertain model actions.
const config = validateHubRuntime();
assert.equal(config.environment, 'development', 'Live acceptance must use an isolated development-labelled database');
assert.equal(process.env.HUB_VERIFY_TARGET, 'isolated-preview', 'Set HUB_VERIFY_TARGET=isolated-preview after confirming resource isolation');
const required = ['HUB_VERIFY_URL', 'HUB_VERIFY_EMAIL', 'HUB_VERIFY_PASSWORD', 'HUB_VERIFY_ORGANIZATION_ID', 'HUB_VERIFY_AGENT_ID'];
for (const key of required) assert.ok(process.env[key], `Missing ${key}`);
const policy = accessPolicy();
assert.equal(policy.mode, 'self-service');
const organizationId = process.env.HUB_VERIFY_ORGANIZATION_ID;

const base = new URL(process.env.HUB_VERIFY_URL);
assert.equal(base.protocol, 'https:');
assert.ok(!base.username && !base.password && !base.search && !base.hash);
const cookies = new Map();
const hubBypass = process.env.HUB_VERIFY_PROTECTION_BYPASS?.trim();
let roomId, completed = false;
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
async function api(path, method = 'GET', body, headers = {}) {
  const response = await fetch(new URL(path, base), { method, redirect: 'error', signal: AbortSignal.timeout(30_000), headers: { 'content-type': 'application/json', origin: base.origin, cookie: [...cookies].map(([key,value]) => `${key}=${value}`).join('; '), ...headers, ...(hubBypass ? { 'x-vercel-protection-bypass': hubBypass } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  for (const value of response.headers.getSetCookie()) { const pair = value.split(';')[0], at = pair.indexOf('='); cookies.set(pair.slice(0,at), pair.slice(at+1)); }
  if (!response.ok) throw new Error(`Acceptance request failed (${response.status}) at ${path}; inspect the labelled test room and server logs`);
  return response.json();
}
try {
  // Verify DB environment BEFORE creating a room or invoking a provider.
  const { response: preflight } = await serviceRequest('/internal/hub/records', { signal: AbortSignal.timeout(20_000), headers: { authorization: `Bearer ${process.env.HUB_SERVICE_TOKEN}`, 'x-hub-protocol': '2', 'x-hub-environment': 'development' } });
  assert.ok(preflight.ok, 'Preview storage/environment preflight failed');
  await api('/api/auth/login', 'POST', { email: process.env.HUB_VERIFY_EMAIL, password: process.env.HUB_VERIFY_PASSWORD });
  let session = await api('/api/auth/session');
  assert.ok(session.organizations.some((org) => org.id === organizationId && policy.allows(org)), 'Test account is not a member of the test organization');
  if (session.activeOrganization?.id !== organizationId) await api(`/api/organizations/${organizationId}/switch`, 'POST', {});
  session = await api('/api/auth/session');
  assert.equal(session.activeOrganization.id, organizationId);
  const dashboard = await api('/api/dashboard');
  const agent = dashboard.agents.find((item) => item.id === process.env.HUB_VERIFY_AGENT_ID);
  assert.ok(agent && dashboard.providers.some((provider) => provider.id === agent.providerId && provider.configured), 'Prepare a configured preset Agent first');
  const created = await api('/api/rooms', 'POST', { title: `P0 acceptance ${new Date().toISOString()}`, topic: '每位参与者用一句话讨论：一个可靠的 demo 应该具备什么？', mode: 'debate', agentIds: [agent.id, agent.id], joinAsParticipant: true, executionMode: 'live', options: { rounds: 2 } });
  roomId = created.id;
  console.log(`Acceptance room: ${base.origin}/rooms/${roomId}`);
  let room = await api(`/api/rooms/${roomId}`);
  await api(`/api/rooms/${roomId}/control`, 'POST', { action: 'start', generation: room.executionGeneration }, { 'idempotency-key': randomUUID() });
  const submitted = new Set();
  const deadline = Date.now() + 8 * 60_000;
  while (Date.now() < deadline) {
    room = await api(`/api/rooms/${roomId}`);
    if (room.status === 'completed') { completed = true; break; }
    if (['paused', 'error'].includes(room.status)) throw new Error('Acceptance stopped; inspect the preserved room before deciding whether to retry paid work');
    const phase = room.self?.phaseVersion;
    if (room.self?.tools.some((tool) => tool.name === 'send_group_message') && !submitted.has(phase)) {
      submitted.add(phase);
      await api(`/api/rooms/${roomId}/actions`, 'POST', { toolName: 'send_group_message', args: { channelId: 'public', content: '可靠的 demo 应当可复现，并能解释和恢复失败。' }, phaseVersion: phase, actionId: randomUUID() });
    }
    await delay(1500);
  }
  assert.ok(completed, 'Acceptance timed out');
  const replay = await api(`/api/rooms/${roomId}/export`);
  assert.equal(replay.room.status, 'completed');
  assert.equal(replay.room.events.filter((event) => event.type === 'message').length, 6);
  assert.equal((await api(`/api/rooms/${roomId}`)).status, 'completed');
  console.log('PASS: signed-in isolated preview, cloud execution, real provider actions, two human turns, persisted result and export.');
  console.log('Manual acceptance still required: real registration email, invitation of a second account, browser refresh/reconnect and UI review.');
} finally {
  if (roomId && !completed) {
    try {
      const room = await api(`/api/rooms/${roomId}`);
      if (room.status === 'running') await api(`/api/rooms/${roomId}/control`, 'POST', { action: 'pause', generation: room.executionGeneration }, { 'idempotency-key': randomUUID() });
    } catch { console.error('Could not confirm pause. The test owner must inspect the preserved acceptance room.'); }
  }
}
