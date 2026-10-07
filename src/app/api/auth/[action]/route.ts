import { cookies } from "next/headers";
import { CLUB_COOKIE, ClubError, clubRequest, currentClubSession, setClubSession, type ClubSession } from "@/lib/club-service";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
export async function GET(_request: Request, context: { params: Promise<{ action: string }> }) {
  if ((await context.params).action !== "session") return json({ error: "接口不存在" }, 404);
  try { const session = await currentClubSession(); return json(session ? { user: session.user, organizations: session.organizations, activeOrganization: session.activeOrganization } : { user: null, organizations: [], activeOrganization: null }); }
  catch { return json({ error: "共享账号服务暂时不可用" }, 503); }
}
export async function POST(request: Request, context: { params: Promise<{ action: string }> }) {
  const origin = request.headers.get("origin");
  if ((origin && new URL(origin).host !== request.headers.get("host")) || request.headers.get("sec-fetch-site") === "cross-site") return json({ error: "请求来源无效" }, 403);
  try {
    const { action } = await context.params;
    if (action === "logout") { (await cookies()).delete(CLUB_COOKIE); return json({ ok: true }); }
    if (!request.headers.get("content-type")?.includes("application/json")) return json({ error: "请使用 JSON 请求" }, 415);
    const text = await request.text();
    if (Buffer.byteLength(text) > 8000) return json({ error: "请求内容过长" }, 413);
    let input: Record<string, unknown>;
    try { input = JSON.parse(text); } catch { return json({ error: "请求格式无效" }, 400); }
    if (!["login", "register", "verify-email", "resend-verification", "forgot-password", "reset-password"].includes(action)) return json({ error: "接口不存在" }, 404);
    const result = await clubRequest<ClubSession & { verificationRequired?: boolean }>(`/auth/${action}`, { method: "POST", body: input });
    if (result.accessToken) { await setClubSession(result); return json({ ok: true }); }
    return json(result);
  } catch (error) { return json({ error: error instanceof ClubError ? error.message : "共享账号服务暂时不可用" }, error instanceof ClubError ? error.status : 503); }
}
