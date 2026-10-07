import { ClubError, clubRequest, currentClubSession, setClubSession, type ClubSession } from "@/lib/club-service";
export const dynamic = "force-dynamic";
async function handle(request: Request, context: { params: Promise<{ path?: string[] }> }) {
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
  const origin = request.headers.get("origin");
  if (request.method !== "GET" && ((origin && new URL(origin).host !== request.headers.get("host")) || request.headers.get("sec-fetch-site") === "cross-site")) return json({ error: "请求来源无效" }, 403);
  try {
    const session = await currentClubSession();
    if (!session) return json({ error: "请先登录" }, 401);
    const path = (await context.params).path ?? [];
    const tail = path.join("/");
    const uuid = "[0-9a-fA-F-]{36}";
    const allowed = request.method === "GET" ? !tail || new RegExp(`^${uuid}/members$`).test(tail) || tail === "invitations" : !tail || new RegExp(`^${uuid}/(switch|invitations)$`).test(tail) || new RegExp(`^invitations/${uuid}/(accept|reject)$`).test(tail);
    if (!allowed) return json({ error: "接口不存在" }, 404);
    const endpoint = tail.startsWith("invitations") ? `/${tail}` : `/organizations${tail ? `/${tail}` : ""}`;
    const body = request.method === "GET" ? undefined : await request.json();
    const result = await clubRequest<ClubSession & { session?: ClubSession }>(endpoint, { token: session.token, method: request.method, body });
    const nextSession = result.accessToken ? result : result.session;
    if (nextSession?.accessToken) await setClubSession(nextSession);
    // JWTs stay in HttpOnly cookies, never in browser-readable JSON.
    if (nextSession) return json({ ok: true });
    return json(result);
  } catch (error) { return json({ error: error instanceof ClubError ? error.message : "组织操作失败，请稍后重试" }, error instanceof ClubError ? error.status : 503); }
}
export { handle as GET, handle as POST };
