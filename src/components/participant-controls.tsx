"use client";

import { useRef, useState, type FormEvent } from "react";
import { ArrowUp, Eye, LoaderCircle, UserPlus } from "lucide-react";
import type { RoomView, ToolSpec } from "@/domain/types";
import { useAuth } from "./auth";
import { api, ErrorNotice, errorMessage } from "./ui";
import { RequestIdentity } from "@/lib/idempotency";
import { MessageMarkdown } from "./message-markdown";

const TOOL_LABELS: Record<string, string> = {
  send_group_message: "发言", send_private_message: "私聊", vote: "投票", guard: "守护", kill: "选择刀口", command_kill: "狼王指定", inspect: "查验", use_antidote: "使用解药", use_poison: "使用毒药", pass: "跳过行动", shoot: "开枪", detonate: "引爆", explode: "自爆",
};
export function ParticipantControls({ room, onUpdate }: { room: RoomView; onUpdate: (room: RoomView) => void }) {
  const { user, openAuth } = useAuth();
  const requestIdentity = useRef(new RequestIdentity());
  const sending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const self = room.self;
  const person = room.participants.find((p) => p.id === self?.participantId);
  async function seat(method: "POST" | "DELETE") {
    if (!user) { openAuth(); return; }
    if (sending.current) return;
    sending.current = true; setBusy(true); setError(null);
    try { onUpdate(await api<RoomView>(`/api/rooms/${room.id}/seat`, { method, headers: { "idempotency-key": requestIdentity.current.key(method) }, ...(method === "POST" ? { body: "{}" } : {}) })); requestIdentity.current.confirmed(); }
    catch (e) { setError(errorMessage(e)); }
    finally { sending.current = false; setBusy(false); }
  }
  return <section className="participant-controls" aria-label="我的圆桌席位">
    {room.status === "waiting" ? <div className="seat-invitation"><div><strong>{self ? `你已入座 · ${person?.seat} 号席位` : "这张圆桌，也有你的位置"}</strong><p>{self ? "开场后按席位依次发言，请留在房间等待自己的回合。" : "开场前添加自己的席位，就能和 Agent 一起参与。"}</p></div><button className="button secondary small" disabled={busy || (!self && room.participantCount >= 12)} onClick={() => seat(self ? "DELETE" : "POST")}>{busy ? <LoaderCircle size={15} className="spin" /> : <UserPlus size={15} />}{self ? "退出席位" : room.participantCount >= 12 ? "席位已满" : user ? "添加我的席位" : "登录并入座"}</button></div>
      : self ? <>
        <div className="my-turn-heading"><strong>{self.tools.length ? "轮到你了" : room.status === "completed" ? "本场已结束" : room.status === "paused" || room.status === "error" ? "圆桌已暂停" : person?.alive ? "等待你的回合" : "你已出局，继续观看"}</strong><span>{person?.seat} 号 · {person?.modelName}{self.role && ` · ${self.role}`}{self.word && ` · 你的词语：${self.word}`}</span></div>
        {self.wolfTeammates && <p className="form-hint">狼人同伴：{room.participants.filter((p) => self.wolfTeammates?.includes(p.id)).map((p) => `${p.seat} 号 ${p.modelName}`).join("、")}</p>}
        {self.wolfTarget !== undefined && <p className="form-hint">本夜刀口：{room.participants.find((p) => p.id === self.wolfTarget)?.modelName ?? "无人"}</p>}
        {self.tools.length > 0 && <ActionForm key={`${self.participantId}:${self.phaseVersion}:${self.tools.map((t) => t.name).join()}`} room={room} tools={self.tools} onUpdate={onUpdate} />}
        {room.privateMessages.length > 0 && <details className="my-private-records"><summary>我的私密记录 · {room.privateMessages.length} 条</summary><div>{room.privateMessages.map((event) => <article key={event.id} className={event.senderId === self.participantId ? "own-private-message" : ""}><small>{event.visibility === "wolves" ? "狼人频道" : "仅相关席位可见"} · 第 {event.round} 轮 · {room.participants.find((p) => p.id === event.senderId)?.modelName || "系统"}</small><MessageMarkdown content={event.content} /></article>)}</div></details>}
      </> : <div className="seat-invitation"><Eye size={17} /><p>{room.status === "completed" ? "本场已结束，可以回看公开记录。" : "你正在旁观。下一场请在开场前添加自己的席位。"}</p>{!user && <button className="button secondary small" onClick={openAuth}>登录账号</button>}</div>}
    <ErrorNotice message={error} />
  </section>;
}

function ActionForm({ room, tools, onUpdate }: { room: RoomView; tools: ToolSpec[]; onUpdate: (room: RoomView) => void }) {
  const [toolName, setToolName] = useState(tools.find((t) => t.name !== "send_private_message" && t.name !== "send_group_message")?.name ?? tools[0].name);
  const [content, setContent] = useState("");
  const [target, setTarget] = useState("");
  const requestIdentity = useRef(new RequestIdentity());
  const sending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tool = tools.find((t) => t.name === toolName) ?? tools[0];
  const properties = tool.inputSchema.properties as Record<string, { enum?: string[] }>;
  const targetKey = properties.targetId ? "targetId" : properties.recipientId ? "recipientId" : undefined;
  const choices = targetKey ? properties[targetKey].enum ?? [] : [];
  const selectedTarget = choices.includes(target) ? target : choices[0] ?? "";
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sending.current) return;
    sending.current = true; setBusy(true); setError(null);
    const args: Record<string, string> = {};
    if (properties.content) args.content = content.trim();
    if (properties.channelId) args.channelId = properties.channelId.enum![0];
    if (targetKey) args[targetKey] = selectedTarget;
    try {
      const next = await api<RoomView>(`/api/rooms/${room.id}/actions`, { method: "POST", body: JSON.stringify({ toolName: tool.name, args, phaseVersion: room.self!.phaseVersion, actionId: requestIdentity.current.key(JSON.stringify([room.self!.phaseVersion, tool.name, args])) }) });
      requestIdentity.current.confirmed(); onUpdate(next); setContent("");
    } catch (e) { setError(errorMessage(e)); }
    finally { sending.current = false; setBusy(false); }
  }
  return <form className="human-action-form" onSubmit={submit}>
    <div className="human-action-options">{tools.length > 1 && <label className="field"><span className="sr-only">选择行动</span><select aria-label="选择行动" value={tool.name} disabled={busy} onChange={(e) => { setToolName(e.target.value); setError(null); }}>{tools.map((t) => <option key={t.name} value={t.name}>{TOOL_LABELS[t.name] || t.name}</option>)}</select></label>}
      {targetKey && <label className="field"><span className="sr-only">选择目标席位</span><select aria-label="选择目标席位" value={selectedTarget} disabled={busy} required onChange={(e) => setTarget(e.target.value)}>{choices.map((id) => { const p = room.participants.find((item) => item.id === id); return <option key={id} value={id}>{p?.seat} 号 · {p?.modelName}</option>; })}</select></label>}
    </div>
    <p className="form-hint">{tool.description}</p>
    <div className="composer">{properties.content && <textarea aria-label={tool.name === "send_private_message" ? "私聊内容" : "我的发言"} placeholder={properties.channelId?.enum?.[0] === "wolves" ? "给狼人同伴留一句话…" : "说说你的想法…"} value={content} onChange={(e) => setContent(e.target.value)} maxLength={2000} rows={2} disabled={busy} required onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (content.trim() && !busy) e.currentTarget.form?.requestSubmit(); } }} />}
      <button className={properties.content ? "send-button" : "button primary small"} aria-label={`提交${TOOL_LABELS[tool.name]}`} disabled={busy || (Boolean(properties.content) && !content.trim()) || Boolean(targetKey && !selectedTarget)}>{busy ? <LoaderCircle size={17} className="spin" /> : properties.content ? <ArrowUp size={18} /> : `确认${TOOL_LABELS[tool.name]}`}</button>
    </div><ErrorNotice message={error} />
  </form>;
}
