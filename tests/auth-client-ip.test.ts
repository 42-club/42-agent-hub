import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { authClientHeaders } from '../server/auth-client-ip';

test('only explicitly trusted ingress IPs are signed, with the exact Service endpoint', () => {
  const previous = { header: process.env.HUB_TRUSTED_CLIENT_IP_HEADER, token: process.env.HUB_SERVICE_TOKEN };
  const endpoint = new URL('https://service.example/api/v1/auth/register');
  const secret = 'trusted-ingress-test-secret-123456789012345';
  try {
    process.env.HUB_SERVICE_TOKEN = secret;
    delete process.env.HUB_TRUSTED_CLIENT_IP_HEADER;
    assert.deepEqual(authClientHeaders(new Request('https://hub.example', { headers: { 'x-forwarded-for': '203.0.113.11' } }), endpoint), {});
    process.env.HUB_TRUSTED_CLIENT_IP_HEADER = 'x-ingress-ip';
    assert.deepEqual(authClientHeaders(new Request('https://hub.example', { headers: { 'x-ingress-ip': '203.0.113.11, attacker' } }), endpoint), {});
    const headers = authClientHeaders(new Request('https://hub.example', { headers: { 'x-ingress-ip': '203.0.113.11' } }), endpoint);
    const expected = createHmac('sha256', secret).update(`${headers['x-hub-client-time']}\nPOST\n/api/v1/auth/register\n203.0.113.11`).digest('hex');
    assert.equal(headers['x-hub-client-signature'], expected);
  } finally {
    for (const [key, value] of Object.entries({ HUB_TRUSTED_CLIENT_IP_HEADER: previous.header, HUB_SERVICE_TOKEN: previous.token })) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
