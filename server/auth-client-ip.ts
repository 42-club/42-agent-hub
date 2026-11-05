import { createHmac } from "node:crypto";
import { isIP } from "node:net";

export function authClientHeaders(request: Request, endpoint: URL): Record<string, string> {
  // Configure only a header overwritten by the trusted hosting ingress. There is
  // intentionally no default trust in browser-controlled X-Forwarded-For.
  const header = process.env.HUB_TRUSTED_CLIENT_IP_HEADER;
  const ip = header ? request.headers.get(header)?.trim() : undefined;
  if (!ip || !isIP(ip)) return {};
  const secret = process.env.HUB_SERVICE_TOKEN?.trim();
  if (!secret || secret.length < 32) throw new Error("Configure HUB_SERVICE_TOKEN for authenticated client attribution");
  const timestamp = String(Date.now());
  return { "x-hub-client-ip": ip, "x-hub-client-time": timestamp, "x-hub-client-signature": createHmac("sha256", secret).update(`${timestamp}\nPOST\n${endpoint.pathname}${endpoint.search}\n${ip}`).digest("hex") };
}
