import assert from 'node:assert/strict';
import { validateHubRuntime } from './runtime-config.mjs';
import { serviceRequest } from './service-request.mjs';

// Read-only preflight. No registration, writes, Workflow or model calls.
const config = validateHubRuntime();
const hub = process.env.HUB_VERIFY_URL;
if (!hub) throw new Error('Set HUB_VERIFY_URL to the candidate Hub deployment');
async function read(path, headers = {}) {
  const { response, data } = await serviceRequest(path, { headers, signal: AbortSignal.timeout(20_000) });
  assert.ok(response.ok, `Preflight endpoint returned ${response.status}`);
  return data;
}
const health = await read('/health');
assert.equal(health.database, 'up');
const records = await read('/internal/hub/records', { authorization: `Bearer ${process.env.HUB_SERVICE_TOKEN}`, 'x-hub-protocol': '2', 'x-hub-environment': config.environment });
assert.ok(Array.isArray(records), 'Invalid internal Hub contract');
const hubBypass = process.env.HUB_VERIFY_PROTECTION_BYPASS?.trim();
const guest = await fetch(`${hub.replace(/\/$/, '')}/api/dashboard`, { headers: hubBypass ? { 'x-vercel-protection-bypass': hubBypass } : {}, redirect: 'error', signal: AbortSignal.timeout(20_000) });
assert.equal(guest.status, 401, 'Anonymous business requests must be rejected');
assert.equal((await guest.json()).error, '请先登录 42 账号', 'Expected the Hub application login check; verify HUB_VERIFY_PROTECTION_BYPASS if Vercel blocked the request');
console.log(`PASS: ${config.environment} Service health, authenticated protocol 2 storage read, database environment and anonymous Hub rejection.`);
console.log('NOT VERIFIED: signed-in discussion, real email, cloud Workflow, paid model or existing production migration compatibility.');
