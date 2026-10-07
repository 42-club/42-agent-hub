import { NextRequest } from "next/server";
import { start } from "workflow/api";
import { roomWorkflow } from "@/lib/room-workflow";
import { cloudRequest } from "../../../../server/cloud-runtime";
import { currentClubSession } from "@/lib/club-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function proxy(request: NextRequest) {
  const baseUrl = process.env.HUB_COORDINATOR_URL;
  const token = process.env.HUB_INTERNAL_TOKEN;
  const cloud = process.env.HUB_EXECUTION === "workflow" || Boolean(process.env.VERCEL);
  if (!cloud && (!baseUrl || !token)) return Response.json({ error: "房间服务尚未启动，请使用 npm run dev 启动完整应用。" }, { status: 503 });
  const mutation = !["GET", "HEAD"].includes(request.method);
  if (mutation) {
    const origin = request.headers.get("origin");
    if (origin && new URL(origin).host !== request.headers.get("host")) return Response.json({ error: "请求来源无效" }, { status: 403 });
    if (request.headers.get("sec-fetch-site") === "cross-site") return Response.json({ error: "请求来源无效" }, { status: 403 });
    if (request.method !== "DELETE" && !request.headers.get("content-type")?.includes("application/json")) return Response.json({ error: "请使用 JSON 请求" }, { status: 415 });
  }
  try {
    if (Number(request.headers.get("content-length") ?? 0) > 64_000) return Response.json({ error: "请求内容过长" }, { status: 413 });
    const requestBody = mutation ? await request.text() : undefined;
    if (requestBody && Buffer.byteLength(requestBody, "utf8") > 64_000) return Response.json({ error: "请求内容过长" }, { status: 413 });
    const session = await currentClubSession();
    const user = session?.user;
    if (!user) return Response.json({ error: "请先登录 42 账号" }, { status: 401 });
    if (!session?.activeOrganization) return Response.json({ error: "请先选择或创建组织" }, { status: 403 });
    if (mutation && session.activeOrganization.role === "viewer") return Response.json({ error: "当前成员为只读角色" }, { status: 403 });
    const path = `${request.nextUrl.pathname}${request.nextUrl.search}`;
    const actorHeaders = { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": request.headers.get("idempotency-key") || "", "x-hub-user-id": user.id, "x-hub-organization-id": session.activeOrganization.id, "x-hub-role": session.activeOrganization.role, "x-hub-user-name": encodeURIComponent(user.profile.display_name || user.email?.split("@")[0] || "圆桌成员") };
    const upstream = cloud ? await cloudRequest(path,{method:request.method,headers:actorHeaders,body:requestBody}) : await fetch(`${baseUrl}${path}`,{method:request.method,headers:actorHeaders,body:requestBody,signal:request.signal,cache:"no-store"});
    if(cloud && upstream.ok && mutation) {
      const match=request.nextUrl.pathname.match(/^\/api\/rooms\/([^/]+)\/(actions|messages|control)$/);
      if(match) {
        const action = requestBody ? JSON.parse(requestBody).action : undefined;
        if(match[2]!=="control" || action==="start" || action==="resume") {
          try { await start(roomWorkflow,[match[1], (await upstream.clone().json()).executionGeneration ?? 0]); }
          catch { return Response.json({error:"行动已保存，但执行队列暂时不可用，请房主暂停后继续，以重新调度。"},{status:503}); }
        }
      }
    }
    const headers = new Headers({ "content-type": upstream.headers.get("content-type") ?? "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    const disposition = upstream.headers.get("content-disposition");
    if (disposition) headers.set("content-disposition", disposition);
    if (headers.get("content-type")?.includes("text/event-stream")) { headers.set("connection", "keep-alive"); headers.set("x-accel-buffering", "no"); }
    return new Response(upstream.body, { status: upstream.status, headers });
  } catch {
    return Response.json({ error: "暂时无法连接房间服务，请稍后重试。" }, { status: 503 });
  }
}

export { proxy as GET, proxy as POST, proxy as PUT, proxy as DELETE };
