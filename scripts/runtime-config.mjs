// Runtime validation, shared by the launcher and server. Build does not need secrets.
export function deploymentEnvironment(env = process.env) {
  if (env.HUB_DEPLOYMENT_ENV && !["development", "production"].includes(env.HUB_DEPLOYMENT_ENV)) throw new Error("HUB_DEPLOYMENT_ENV must be development or production");
  if (env.VERCEL_ENV === "production" && env.HUB_DEPLOYMENT_ENV !== "production") throw new Error("Production requires HUB_DEPLOYMENT_ENV=production");
  return env.NODE_ENV === "production" && env.HUB_DEPLOYMENT_ENV === "production" && (!env.VERCEL_ENV || env.VERCEL_ENV === "production") ? "production" : "development";
}

export function serviceUrl(env = process.env) {
  const deployed = env.NODE_ENV === "production" || Boolean(env.VERCEL);
  const value = env.CLUB_SERVICE_URL?.trim() || (deployed ? "" : "http://127.0.0.1:4242/api/v1");
  if (!value) throw new Error("CLUB_SERVICE_URL is required for deployed Hub instances");
  let url;
  try { url = new URL(value); } catch { throw new Error("CLUB_SERVICE_URL must be a valid URL"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Invalid CLUB_SERVICE_URL");
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((deployed && !local && url.protocol !== "https:") || (deploymentEnvironment(env) === "production" && local)) throw new Error("Production Service must use an explicit remote HTTPS URL");
  return value.replace(/\/$/, "");
}

export function validateHubRuntime(env = process.env) {
  const environment = deploymentEnvironment(env);
  const url = serviceUrl(env);
  const token = env.HUB_SERVICE_TOKEN?.trim();
  if (!token || token.length < 32 || /^(replace-|<)/.test(token)) throw new Error("Configure an independent HUB_SERVICE_TOKEN of at least 32 characters");
  if (environment === "production" && env.HUB_STORAGE === "local-test") throw new Error("Production cannot use test storage");
  return { environment, url };
}
