import assert from 'node:assert/strict';
import { fork, spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

// No inherited database/provider credentials; all data is in a disposable local fixture.
const serviceDirectory = resolve(process.env.HUB_SERVICE_SOURCE || '../42-agent-service');
const directory = await mkdtemp(join(tmpdir(), 'hub-smoke-'));
const children = [];
let diagnostics = '';
let modelServer;
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const port = async () => {
  const server = createServer(); await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const value = server.address().port; await new Promise((done) => server.close(done)); return value;
};
const secret = () => randomBytes(32).toString('hex');
const env = { ...process.env, NODE_ENV: 'test', DATABASE_DRIVER: 'sqljs', DATABASE_PATH: ':memory:', DB_SYNCHRONIZE: 'false', JWT_SECRET: secret(), APP_ENCRYPTION_KEY: secret(), AUTH_EMAIL_RATE_LIMIT_SECRET: secret(), HUB_SERVICE_TOKEN: secret(), EMAIL_VERIFICATION_TEST_CODE: '424242', AUTH_EMAIL_RATE_LIMIT_DISABLED: 'true', AUTH_ATTEMPT_RATE_LIMIT_DISABLED: 'true' };
for (const key of ['VERCEL', 'VERCEL_ENV', 'HUB_DEPLOYMENT_ENV', 'DATABASE_URL', 'RESEND_API_KEY', 'OPENROUTER_API_KEY', 'OPENROUTER_BASE_URL', 'OPENROUTER_MODEL', 'DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'DEEPSEEK_MODEL', 'HUB_STORAGE', 'HUB_EXECUTION', 'HUB_TRUSTED_CLIENT_IP_HEADER', 'CLUB_SERVICE_PROTECTION_BYPASS', 'HUB_VERIFY_PROTECTION_BYPASS', 'VERCEL_AUTOMATION_BYPASS_SECRET']) delete env[key];
function observe(child) {
  children.push(child);
  for (const stream of [child.stdout, child.stderr]) stream?.on('data', (data) => { diagnostics = (diagnostics + data).slice(-10000); });
  return child;
}
function client(base) {
  const cookies = new Map();
  return async (path, method = 'GET', body, expected = 200, extra = {}) => {
    const response = await fetch(`${base}${path}`, { method, signal: AbortSignal.timeout(60_000), headers: { 'content-type': 'application/json', origin: base, cookie: [...cookies].map(([k,v]) => `${k}=${v}`).join('; '), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const cookie of response.headers.getSetCookie()) { const pair = cookie.split(';')[0], at = pair.indexOf('='); cookies.set(pair.slice(0, at), pair.slice(at + 1)); }
    const data = await response.json();
    assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(data)}`);
    if (!base.endsWith('/api/v1')) assert.equal(JSON.stringify(data).includes('accessToken'), false, 'Browser JSON leaked JWT');
    return data;
  };
}
async function until(read, predicate, timeout = 90_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const data = await read(); if (predicate(data)) return data; await delay(150); }
  throw new Error('Demo smoke timed out');
}
try {
  const service = observe(fork(join(serviceDirectory, 'scripts/test-hub-server.cjs'), [], { cwd: serviceDirectory, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true }));
  const servicePort = await new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error('Service startup timed out')), 30_000);
    service.once('message', (message) => { clearTimeout(timer); done(message.port); });
    service.once('exit', () => { clearTimeout(timer); reject(new Error('Service fixture exited')); });
  });
  const serviceBase = `http://127.0.0.1:${servicePort}/api/v1`;
  const backend = client(serviceBase);
  const password = secret();
  const emails = ['owner', 'member', 'outsider'].map((name) => `${name}-${randomUUID()}@example.com`);
  const sessions = [];
  for (const email of [emails[0], emails[2]]) {
    await backend('/auth/register', 'POST', { email, password, displayName: email.split('-')[0] }, 201);
    sessions.push(await backend('/auth/verify-email', 'POST', { email, code: '424242' }, 201));
  }
  const auth = (session) => ({ authorization: `Bearer ${session.accessToken}` });
  const organizationId = sessions[0].activeOrganizationId;
  assert.ok(organizationId, 'Verification must create and select a default organization');
  const organization = { session: sessions[0] };
  await backend(`/organizations/${organizationId}/invitations`, 'POST', { email: emails[1] }, 201, auth(organization.session));
  modelServer = createHttpServer(async (request, response) => {
    assert.equal(request.url, '/chat/completions');
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    assert.deepEqual(body.thinking, { type: 'disabled' });
    const tool = body.tools.find((item) => item.function.name === 'send_group_message');
    assert.ok(tool);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ choices: [{ message: { tool_calls: [{ id: randomUUID(), type: 'function', function: { name: tool.function.name, arguments: JSON.stringify({ channelId: 'public', content: 'Isolated mock provider response' }) } }] } }] }));
  });
  await new Promise((done) => modelServer.listen(0, '127.0.0.1', done));
  const webPort = await port(), coordinatorPort = await port();
  const hubEnv = { ...env, NODE_ENV: 'production', HUB_DEPLOYMENT_ENV: 'development', CLUB_SERVICE_URL: serviceBase, HUB_INTERNAL_TOKEN: secret(), HUB_COORDINATOR_URL: `http://127.0.0.1:${coordinatorPort}`, HUB_COORDINATOR_PORT: String(coordinatorPort), HUB_DATA_DIR: directory, DEEPSEEK_API_KEY: secret(), DEEPSEEK_MODEL: 'isolated-mock', DEEPSEEK_BASE_URL: `http://127.0.0.1:${modelServer.address().port}` };
  observe(spawn(process.execPath, ['--import', 'tsx', 'server/coordinator.ts'], { env: { ...hubEnv, NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }));
  observe(spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(webPort)], { env: hubEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }));
  const base = `http://127.0.0.1:${webPort}`;
  await until(async () => { try { return (await fetch(`${base}/api/auth/session`, { signal: AbortSignal.timeout(3000) })).ok; } catch { return false; } }, Boolean);
  const owner = client(base), member = client(base), outsider = client(base), guest = client(base);
  await guest('/api/dashboard', 'GET', undefined, 401);
  for (const [index, api] of [[0, owner], [2, outsider]]) await api('/api/auth/login', 'POST', { email: emails[index], password });
  await member('/api/auth/register', 'POST', { email: emails[1], password, displayName: 'Invited newcomer' });
  await member('/api/auth/verify-email', 'POST', { email: emails[1], code: '424242' });
  const invitation = (await member('/api/organizations/invitations'))[0];
  await member(`/api/organizations/invitations/${invitation.id}/accept`, 'POST', {});
  assert.equal((await member('/api/auth/session')).activeOrganization.id, organizationId);
  await member('/api/organizations', 'POST', { name: 'Forbidden', domain: 'forbidden.example.com' }, 403);
  const outsiderSession = await outsider('/api/auth/session');
  assert.ok(outsiderSession.activeOrganization);
  assert.notEqual(outsiderSession.activeOrganization.id, organizationId);
  await outsider(`/api/organizations/${organizationId}/switch`, 'POST', {}, 403);
  const initialDashboard = await owner('/api/dashboard');
  assert.equal(initialDashboard.agents.length, 4);
  assert.equal('providers' in initialDashboard, false);
  const agent = initialDashboard.agents[0];
  await owner('/api/providers', 'POST', { apiKey: 'forbidden' }, 404);
  const personal = await owner('/api/agents', 'POST', { name: 'Personal smoke Agent', instructions: 'Use concrete examples.' });
  assert.equal(personal.source, 'personal');
  assert.equal((await owner('/api/dashboard')).agents.length, 5);
  assert.equal((await member('/api/dashboard')).agents.length, 4);
  await member(`/api/agents/${personal.id}`, 'DELETE', undefined, 404);
  const { id } = await owner('/api/rooms', 'POST', { title: 'Demo acceptance', topic: 'A reproducible handover', mode: 'debate', agentIds: [agent.id, agent.id], joinAsParticipant: true, executionMode: 'live', options: { rounds: 2 } }, 201);
  await outsider(`/api/rooms/${id}`, 'GET', undefined, 404);
  const control = async (action, roomId = id) => {
    const room = await owner(`/api/rooms/${roomId}`);
    return owner(`/api/rooms/${roomId}/control`, 'POST', { action, generation: room.executionGeneration }, 200, { 'idempotency-key': randomUUID() });
  };
  await control('start');
  for (let round = 1; round <= 2; round++) {
    const room = await until(() => owner(`/api/rooms/${id}`), (r) => r.self?.tools.some((t) => t.name === 'send_group_message'));
    const body = { toolName: 'send_group_message', args: { channelId: 'public', content: `Human round ${round}` }, actionId: randomUUID(), phaseVersion: room.self.phaseVersion };
    await owner(`/api/rooms/${id}/actions`, 'POST', body);
    await owner(`/api/rooms/${id}/actions`, 'POST', body);
  }
  const completed = await until(() => owner(`/api/rooms/${id}`), (r) => r.status === 'completed');
  assert.equal(completed.events.filter((e) => e.type === 'message').length, 6);
  assert.equal((await owner(`/api/rooms/${id}/export`)).room.status, 'completed');
  const pausedRoom = await owner('/api/rooms', 'POST', { title: 'Recovery', topic: 'Pause safely', mode: 'debate', agentIds: [agent.id], joinAsParticipant: true, executionMode: 'live', options: { rounds: 1 } }, 201);
  const forbiddenRoom = await member(`/api/rooms/${pausedRoom.id}`);
  await member(`/api/rooms/${pausedRoom.id}/control`, 'POST', { action: 'start', generation: forbiddenRoom.executionGeneration }, 403, { 'idempotency-key': randomUUID() });
  await control('start', pausedRoom.id);
  const awaitingHuman = await until(() => owner(`/api/rooms/${pausedRoom.id}`), (room) => room.self?.tools.some((tool) => tool.name === 'send_group_message'));
  const savedMessages = awaitingHuman.events.filter((event) => event.type === 'message').length;
  assert.equal((await control('pause', pausedRoom.id)).status, 'paused');
  assert.equal((await control('resume', pausedRoom.id)).status, 'running');
  assert.equal((await control('stop', pausedRoom.id)).status, 'completed');
  assert.equal((await owner(`/api/rooms/${pausedRoom.id}`)).events.filter((event) => event.type === 'message').length, savedMessages);
  await owner('/api/auth/logout', 'POST', {});
  await owner('/api/dashboard', 'GET', undefined, 401);
  await owner('/api/auth/login', 'POST', { email: emails[0], password });
  assert.equal((await owner(`/api/rooms/${id}`)).status, 'completed');
  console.log('PASS: production-built Next → Service → encrypted storage → independent workers + isolated mock model HTTP; registration, invitation access, two-round human discussion, idempotency, replay, ownership, pause/resume/stop, logout and restore.');
  console.log('NOT VERIFIED: real email, cloud Workflow delivery, paid model calls, existing production schema compatibility.');
} catch (error) {
  console.error(diagnostics);
  throw error;
} finally {
  for (const child of children.reverse()) {
    if (child.exitCode !== null) continue;
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else child.kill('SIGTERM');
  }
  if (modelServer) { modelServer.closeAllConnections(); await new Promise((done) => modelServer.close(done)); }
  await delay(300);
  await rm(directory, { recursive: true, force: true });
}
