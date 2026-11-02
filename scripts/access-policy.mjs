import { deploymentEnvironment } from "./runtime-config.mjs";

export function accessPolicy(env = process.env) {
  const production = deploymentEnvironment(env) === "production";
  const mode = env.HUB_ACCESS_MODE || (production ? "invite-only" : "open");
  if (!["open", "invite-only"].includes(mode)) throw new Error("HUB_ACCESS_MODE must be open or invite-only");
  const organizationIds = (env.HUB_ALLOWED_ORGANIZATION_IDS || "").split(",").map((id) => id.trim().toLowerCase()).filter(Boolean);
  if (organizationIds.some((id) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id))) throw new Error("Invalid HUB_ALLOWED_ORGANIZATION_IDS");
  if (mode === "invite-only" && !organizationIds.length) throw new Error("Invite-only Hub requires HUB_ALLOWED_ORGANIZATION_IDS");
  if (production && mode !== "invite-only") throw new Error("This demo requires invite-only access in production");
  return { mode, canCreateOrganization: mode === "open", allows: (id) => mode === "open" || organizationIds.includes(String(id).toLowerCase()) };
}
