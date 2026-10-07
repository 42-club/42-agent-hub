import { cookies } from "next/headers";

export interface Organization { id: string; name: string; domain: string; role: "owner" | "admin" | "member" | "viewer" }
export interface ClubUser { id: string; email: string; displayName: string; activeOrganizationId?: string | null }
export interface ClubSession { user: ClubUser; accessToken: string; activeOrganizationId: string | null; organizations: Organization[] }
export class ClubError extends Error { constructor(public status: number, message: string) { super(message); } }
export const CLUB_COOKIE = "42_club_session";
export async function clubRequest<T>(path: string, options: { token?: string; method?: string; body?: unknown } = {}): Promise<T> {
  const base = (process.env.CLUB_SERVICE_URL || "http://127.0.0.1:4242/api/v1").replace(/\/$/, "");
  const response = await fetch(`${base}${path}`, { method: options.method ?? "GET", headers: { "content-type": "application/json", ...(options.token ? { authorization: `Bearer ${options.token}` } : {}) }, body: options.body === undefined ? undefined : JSON.stringify(options.body), cache: "no-store", signal: AbortSignal.timeout(15000) });
  const data = await response.json();
  if (!response.ok) throw new ClubError(response.status, Array.isArray(data.message) ? data.message.join("；") : data.message || data.error?.message || data.error || "共享账号服务暂时不可用");
  return data;
}
export async function setClubSession(session: ClubSession) {
  // The backend signs the expiry. This is only cookie lifetime, never an authorization decision.
  const payload = JSON.parse(Buffer.from(session.accessToken.split(".")[1], "base64url").toString());
  (await cookies()).set(CLUB_COOKIE, session.accessToken, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: Math.max(0, Number(payload.exp) - Math.floor(Date.now() / 1000)) });
}
export async function currentClubSession() {
  const token = (await cookies()).get(CLUB_COOKIE)?.value;
  if (!token) return null;
  try {
    const { user } = await clubRequest<{ user: ClubUser }>("/auth/me", { token });
    const organizations = await clubRequest<Organization[]>("/organizations", { token });
    const activeOrganization = organizations.find((org) => org.id === user.activeOrganizationId) ?? null;
    return { user: { ...user, profile: { display_name: user.displayName } }, token, organizations, activeOrganization };
  } catch (error) {
    if (error instanceof ClubError && error.status === 401) { (await cookies()).delete(CLUB_COOKIE); return null; }
    throw error;
  }
}
