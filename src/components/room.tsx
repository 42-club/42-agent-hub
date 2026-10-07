"use client";

import { GameIcon, HubLogo } from "./icons";
import { RoomMessage, type ReadingMode } from "./room-message";
import { AccountMenu, useAuth } from "./auth";
import { ParticipantControls } from "./participant-controls";
import { RoomPanel } from "./room-panel";
import { WerewolfPanel } from "./werewolf-panel";
import "./message-markdown.css";
import "./room-reading.css";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AlignLeft, List, MessagesSquare, Vote, Sparkles, ArrowLeft, ChevronDown, Copy, Download, Info, LoaderCircle, MessageCircle, PanelRightClose, PanelRightOpen, Pause, Play, Square, Users, X, Check, Eye } from "lucide-react";
import type { ParticipantView, RoomView } from "@/domain/types";
import { RequestIdentity } from "@/lib/idempotency";
import { api, Avatar, Dialog, EmptyState, ErrorNotice, Loading, MODE_META, STATUS_LABELS, errorMessage } from "./ui";

const PARTICIPANT_STATUS: Record<ParticipantView["status"], string> = { idle: "等待中", thinking: "正在思考", done: "本轮已完成", eliminated: "已出局", error: "运行异常" };

function scrollBehavior(): ScrollBehavior {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
}

export function Room({ id }: { id: string }) {
  const { user, activeOrganization } = useAuth();
  const [room, setRoom] = useState<RoomView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(true);
  const [sidebarTab, setSidebarTab] = useState<"game" | "rules">("game");
  const [participantsCollapsed, setParticipantsCollapsed] = useState(false);
  const [readingMode, setReadingMode] = useState<ReadingMode>("bubbles");
  const [preferencesReady, setPreferencesReady] = useState(false);
  const [selectedParticipant, setSelectedParticipant] = useState<ParticipantView | null>(null);
  const [stopDialog, setStopDialog] = useState(false);
  const [roundFilter, setRoundFilter] = useState("all");
  const [copied, setCopied] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const timelineRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const mobile = window.matchMedia("(max-width: 760px)").matches;
    if (window.matchMedia("(max-width: 1100px)").matches) setRulesOpen(false);
    if (mobile) setParticipantsCollapsed(true);
    try {
      const saved = JSON.parse(localStorage.getItem("42hub:room-reading:v1") || "null");
      if (typeof saved?.collapsed === "boolean") setParticipantsCollapsed(saved.collapsed);
      if (["bubbles", "reading", "compact"].includes(saved?.mode)) setReadingMode(saved.mode);
    } catch { /* Reading preferences are optional when storage is unavailable. */ }
    setPreferencesReady(true);
  }, []);
  useEffect(() => {
    if (!preferencesReady) return;
    try { localStorage.setItem("42hub:room-reading:v1", JSON.stringify({ collapsed: participantsCollapsed, mode: readingMode })); } catch {}
  }, [participantsCollapsed, readingMode, preferencesReady]);
  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setRoom(null); setError(null); setSelectedParticipant(null);
    const controller = new AbortController();
    let source: EventSource | undefined;
    let disconnected: ReturnType<typeof setTimeout> | undefined;
    const synchronized = () => { clearTimeout(disconnected); disconnected = undefined; setConnected(true); };
    api<RoomView>(`/api/rooms/${id}`, { signal: controller.signal }).then((initial) => {
      if (controller.signal.aborted) return;
      setRoom(initial);
      source = new EventSource(`/api/rooms/${id}/events`);
      source.onopen = synchronized;
      // Serverless snapshots close normally between polls. Only report a lost
      // connection when fresh snapshots stop arriving for a meaningful interval.
      source.onerror = () => { disconnected ??= setTimeout(() => setConnected(false), 15_000); };
      source.addEventListener("snapshot", (event: MessageEvent<string>) => {
        try { setRoom(JSON.parse(event.data) as RoomView); synchronized(); }
        catch { setError("房间更新暂时无法读取，正在等待下一次同步。"); }
      });
    }).catch((e) => { if (!controller.signal.aborted) setError(errorMessage(e)); });
    return () => { controller.abort(); source?.close(); clearTimeout(disconnected); };
  }, [id, user?.id, activeOrganization?.id]);
  const eventCount = room?.events.length ?? 0;
  useEffect(() => { if (autoScroll && roundFilter === "all") bottomRef.current?.scrollIntoView({ behavior: scrollBehavior(), block: "end" }); }, [eventCount, autoScroll, roundFilter, readingMode]);
  useEffect(() => { if (!copied) return; const timeout = setTimeout(() => setCopied(false), 2200); return () => clearTimeout(timeout); }, [copied]);
  const controlIdentity = useRef(new RequestIdentity());
  const controlPending = useRef(false);
  const control = async (action: "start" | "pause" | "resume" | "stop") => {
    if (controlPending.current) return;
    controlPending.current = true; setActionBusy(true); setError(null);
    try { setRoom(await api<RoomView>(`/api/rooms/${id}/control`, { method: "POST", headers: { "idempotency-key": controlIdentity.current.key(JSON.stringify([action, room?.executionGeneration ?? 0])) }, body: JSON.stringify({ action, generation: room?.executionGeneration ?? 0 }) })); controlIdentity.current.confirmed(); setStopDialog(false); }
    catch (e) { setError(errorMessage(e)); }
    finally { controlPending.current = false; setActionBusy(false); }
  };
  const copy = async () => { try { await navigator.clipboard.writeText(window.location.href); setCopied(true); } catch { setError("链接复制失败，可以直接复制浏览器地址栏中的地址。"); } };
  if (!room) return <div className="room-loading"><Link href="/" className="text-link"><ArrowLeft size={17} />返回大厅</Link>{error ? <ErrorNotice message={error} /> : <Loading label="正在打开小屋…" />}</div>;
  const meta = MODE_META[room.mode];
  const rounds = [...new Set(room.events.map((event) => event.round))].filter((round) => round > 0).sort((a, b) => a - b);
  const visibleEvents = room.events.filter((event) => (event.visibility === "public" || event.visibility === "spectator") && (roundFilter === "all" || event.round === Number(roundFilter)));
  const concealedProgress = room.status === "running" && room.completedCount + room.pendingCount === 0;
  const activeParticipant = selectedParticipant ? room.participants.find((person) => person.id === selectedParticipant.id) ?? selectedParticipant : null;
  return <div className={`room-shell reading-room ${rulesOpen ? "rules-visible" : ""} ${room.mode === "werewolf" ? "werewolf-room" : ""}`}>
    <header className="room-header"><Link href="/" className="room-back" aria-label="返回空间大厅"><ArrowLeft size={18} /><HubLogo small /></Link><div className="room-title"><div><span className="room-type-label">{meta.label}</span>{room.executionMode === "demo" && <span className="badge demo">离线演示</span>}</div><h1>{room.title}</h1></div><div className="room-header-actions"><AccountMenu /><span className={`badge status-${room.status}`}><span className="status-dot" />{STATUS_LABELS[room.status]}</span><button className="icon-button" aria-label={copied ? "链接已复制" : "复制房间链接"} title="复制房间链接" onClick={copy}>{copied ? <Check size={17} /> : <Copy size={17} />}</button><a className="icon-button" href={`/api/rooms/${id}/export`} download aria-label="下载房间回放 JSON" title="下载房间回放 JSON"><Download size={18} /></a><button className="icon-button" onClick={() => setRulesOpen((value) => !value)} aria-label={rulesOpen ? "收起房间面板" : "展开房间面板"} aria-expanded={rulesOpen}>{rulesOpen ? <PanelRightClose size={19} /> : <PanelRightOpen size={19} />}</button></div></header>
    <section className={`participants-section ${participantsCollapsed ? "participants-collapsed" : ""}`} aria-label="圆桌参与者">
      <div className="participants-heading"><div className="participants-summary"><Users size={15} /><span>圆桌席位</span><span className="participant-count">{room.participants.length} 位</span>{participantsCollapsed && <div className="collapsed-avatars" aria-hidden="true">{room.participants.slice(0, 6).map((participant) => <Avatar key={participant.id} name={participant.modelName} vendor={participant.vendor} size="small" />)}{room.participants.length > 6 && <span>+{room.participants.length - 6}</span>}</div>}</div><button className="participants-toggle" type="button" onClick={() => setParticipantsCollapsed((value) => !value)} aria-expanded={!participantsCollapsed} aria-controls="room-participants"><span>{participantsCollapsed ? "展开席位列表" : "收起席位列表"}</span><ChevronDown size={15} className={participantsCollapsed ? "" : "chevron-up"} /></button></div>
      <div id="room-participants" hidden={participantsCollapsed}>{!participantsCollapsed && <div className="participants-strip">{room.participants.map((participant) => <button className={`participant-seat ${participant.status === "thinking" ? "thinking" : ""} ${!participant.alive ? "eliminated" : ""}`} key={participant.id} onClick={() => setSelectedParticipant(participant)} aria-label={`查看 ${participant.seat} 号 ${participant.modelName} 详情`}><Avatar name={participant.modelName} vendor={participant.vendor} color={participant.color} size="large" seat={participant.seat} /><span className="participant-name">{participant.modelName}</span><span className={`participant-status participant-${participant.status}`}>{participant.status === "thinking" ? <span className="thinking-dots"><i /><i /><i /></span> : <span className="status-dot" />}{PARTICIPANT_STATUS[participant.status]}</span></button>)}</div>}</div>
    </section>
    <div className="room-body"><main className="conversation-panel"><div className="conversation-toolbar"><div><MessageCircle size={16} /><h2>{room.status === "completed" ? "圆桌回放" : "公开圆桌"}</h2><span className="tiny-label">{visibleEvents.filter((event) => event.type === "message").length} 条发言</span></div><div className="timeline-filters"><label className="sr-only" htmlFor="round-filter">按轮次查看记录</label><select id="round-filter" value={roundFilter} onChange={(e) => { setRoundFilter(e.target.value); setAutoScroll(false); }}><option value="all">全部轮次</option>{rounds.map((round) => <option key={round} value={round}>第 {round} 轮</option>)}</select><span className={`stream-status ${connected ? "online" : ""}`} title={connected ? "房间已实时连接" : "正在重连，记录会自动同步"}><span className="status-dot" /><span>{connected ? "实时同步" : "重新连接中"}</span></span></div></div>
      <div className="reading-toolbar"><div className="reading-mode-switch" role="group" aria-label="消息显示方式">{([{ value: "bubbles", label: "对话气泡", icon: MessagesSquare }, { value: "reading", label: "文章阅读", icon: AlignLeft }, { value: "compact", label: "紧凑列表", icon: List }] as const).map(({ value, label, icon: Icon }) => <button key={value} type="button" aria-pressed={readingMode === value} onClick={() => setReadingMode(value)}><Icon size={15} /><span>{label}</span></button>)}</div>{room.mode === "werewolf" && <button type="button" className="game-panel-toggle" aria-expanded={rulesOpen && sidebarTab === "game"} onClick={() => { setSidebarTab("game"); setRulesOpen((open) => sidebarTab === "game" ? !open : true); }}><Vote size={15} /><span>投票与角色</span></button>}</div>
      {room.executionMode === "demo" && <div className="demo-banner"><Info size={15} /><span>当前是离线演示：使用本地预设响应，未调用真实模型。</span></div>}
      <div className="room-error-region"><ErrorNotice message={error || room.error} /></div>
      <div className={`timeline timeline-${readingMode}`} ref={timelineRef} onScroll={() => { const element = timelineRef.current; if (element) setAutoScroll(element.scrollHeight - element.scrollTop - element.clientHeight < 100); }}>
        <div className="room-topic-card"><span className={`topic-symbol ${meta.className}`}><GameIcon mode={room.mode} /></span><div><p className="eyebrow">{room.mode === "debate" ? "TODAY’S QUESTION" : "LET THE STORY BEGIN"}</p><h3>{room.topic || meta.subtitle}</h3><p>{room.mode === "debate" ? "让观点相遇，也给不同的答案一点空间。" : meta.description}</p></div></div>
        {room.status === "waiting" && room.canControl && <div className="waiting-note"><span className="tiny-flower"><Sparkles size="1em" strokeWidth={1.5} aria-hidden="true" /></span><h3>大家已经入座了</h3><p>检查一下右侧规则，准备好就开始这一场相遇。</p><button className="button primary" onClick={() => control("start")} disabled={actionBusy}>{actionBusy ? <LoaderCircle size={16} className="spin" /> : <Play size={16} />}开始{room.mode === "debate" ? "讨论" : "游戏"}</button></div>}
        {visibleEvents.map((event, index) => <RoomMessage key={event.id} event={event} participant={room.participants.find((person) => person.id === event.senderId)} previousRound={visibleEvents[index - 1]?.round} mode={readingMode} side={room.self && event.senderId === room.self.participantId ? "right" : "left"} />)}
        {visibleEvents.length === 0 && room.status !== "waiting" && <EmptyState title="这一轮还没有公开记录">新的发言会出现在这里。</EmptyState>}
        {room.status === "running" && room.pendingCount > 0 && roundFilter === "all" && <div className="thinking-notice"><span className="thinking-dots"><i /><i /><i /></span><p>{room.self?.tools.length ? "轮到你提交行动" : "等待当前席位完成行动"}<span>每一种声音，都有自己的时间</span></p></div>}
        {room.status === "paused" && <div className="pause-notice"><Pause size={16} /><span>圆桌已暂停，继续后将接着当前进度进行。</span></div>}
        {room.status === "completed" && <div className="completion-card"><span><Sparkles size="1em" strokeWidth={1.5} aria-hidden="true" /></span><h3>这一场相遇，告一段落</h3><p>{room.winner || "对话已保存在这里，随时回来看看。"}</p><a className="button secondary small" href={`/api/rooms/${id}/export`} download><Download size={14} />下载回放</a></div>}
        <div ref={bottomRef} />
      </div>
      {!autoScroll && roundFilter === "all" && <button className="latest-button" onClick={() => { setAutoScroll(true); bottomRef.current?.scrollIntoView({ behavior: scrollBehavior() }); }}><ChevronDown size={14} />回到最新</button>}
      <ParticipantControls key={user?.id ?? "guest"} room={room} onUpdate={setRoom} />
    </main>
    {rulesOpen && <RoomPanel onClose={() => setRulesOpen(false)}><div className="rules-title"><span>{room.mode === "werewolf" ? "对局面板" : "房间手册"}</span><button className="icon-button mobile-rules-close" onClick={() => setRulesOpen(false)} aria-label="关闭房间面板"><X size={17} /></button><span className="tiny-flower"><Sparkles size="1em" strokeWidth={1.5} aria-hidden="true" /></span></div>{room.mode === "werewolf" && <div className="sidebar-tabs" role="group" aria-label="对局面板内容"><button type="button" aria-pressed={sidebarTab === "game"} onClick={() => setSidebarTab("game")}>投票与角色</button><button type="button" aria-pressed={sidebarTab === "rules"} onClick={() => setSidebarTab("rules")}>房间规则</button></div>}<div className="room-progress"><p className="eyebrow">{room.status === "completed" ? "FINISHED, NOT FORGOTTEN" : "HERE & NOW"}</p><h3>{room.phaseLabel || "等待开场"}</h3><p>第 {room.round} 轮 <span>·</span>{STATUS_LABELS[room.status]}</p>{concealedProgress ? <p className="concealed-progress">{room.mode === "werewolf" && room.phaseLabel.includes("夜") ? "夜间行动正在进行，天亮后公布。" : "正在按规则推进，新的公开记录会自动同步。"}</p> : room.status === "running" ? <><div className="progress-track"><span style={{ width: `${room.completedCount + room.pendingCount > 0 ? room.completedCount / (room.completedCount + room.pendingCount) * 100 : 0}%` }} /></div><small>{room.completedCount} 位已完成 · {room.pendingCount} 位正在准备</small></> : null}</div><div className="room-control-buttons" hidden={!room.canControl}>{room.status === "waiting" && <button className="button primary" disabled={actionBusy} onClick={() => control("start")}><Play size={15} />开始{room.mode === "debate" ? "讨论" : "游戏"}</button>}{room.status === "running" && <button className="button secondary" disabled={actionBusy} onClick={() => control("pause")}><Pause size={15} />暂停圆桌</button>}{(room.status === "paused" || room.status === "error") && <button className="button primary" disabled={actionBusy} onClick={() => control("resume")}><Play size={15} />{room.status === "error" ? "重试并继续" : "继续圆桌"}</button>}{room.status !== "completed" && room.status !== "waiting" && <button className="button quiet" disabled={actionBusy} onClick={() => setStopDialog(true)}><Square size={12} />结束本场</button>}{actionBusy && <span className="control-busy" role="status">正在处理…</span>}</div>{room.mode === "werewolf" && sidebarTab === "game" ? <WerewolfPanel room={room} /> : <><div className="rules-section"><h3>本场规则</h3><dl><div><dt>玩法</dt><dd>{meta.label}</dd></div><div><dt>参与席位</dt><dd>{room.participantCount} 位</dd></div>{room.mode === "debate" ? <div><dt>讨论轮数</dt><dd>{room.options.rounds} 轮</dd></div> : <div><dt>最多轮数</dt><dd>{room.options.maxRounds} 轮</dd></div>}{room.mode === "undercover" && <div><dt>卧底人数</dt><dd>{room.options.undercoverCount} 位</dd></div>}{room.mode === "werewolf" && <>
  <div><dt>狼人阵营</dt><dd>{room.options.werewolfCount} 位</dd></div>
  <div><dt>普通狼人</dt><dd>{room.options.werewolfCount - Number(Boolean(room.options.hasWolfKing))} 位</dd></div>
  <div><dt>狼王</dt><dd>{room.options.hasWolfKing ? "加入" : "不加入"}</dd></div>
  <div><dt>预言家</dt><dd>{room.options.hasSeer ? "加入" : "不加入"}</dd></div>
  <div><dt>女巫</dt><dd>{room.options.hasWitch ? "加入" : "不加入"}</dd></div>
  <div><dt>猎人</dt><dd>{room.options.hasHunter ? "加入" : "不加入"}</dd></div>
  <div><dt>守卫</dt><dd>{room.options.hasGuard ? "加入" : "不加入"}</dd></div>
  <div><dt>炸弹人</dt><dd>{room.options.hasBomber ? "加入" : "不加入"}</dd></div>
  <div><dt>观众身份</dt><dd>{room.options.revealRolesAtStart ? "开局公开" : "终局揭晓"}</dd></div>
</>}<div><dt>私密交流</dt><dd>{room.options.allowPrivateMessages ? "按规则开放" : "关闭"}</dd></div><div><dt>运行方式</dt><dd>{room.executionMode === "demo" ? "离线演示" : "真实模型"}</dd></div></dl>{room.mode !== "debate" && <details className="game-rules-detail"><summary>行动与胜负规则</summary>{room.mode === "werewolf" ? <ul>
  <li>白天按席位依次发言。轮到狼人发言时可以自爆，结束发言和投票；未到回合上限时直接进入黑夜。</li>
  <li>白天投票不能选择自己，平票无人淘汰。狼人夜间多数票决定目标，平票空刀；狼王可强制指定全队刀口。</li>
  <li>守卫夜间守护一人，可守自己但不能连续两夜守同一人；女巫每夜最多用一种药，两瓶药每局各一次，仅首夜可自救。</li>
  <li>猎人被狼人袭击或白天公投出局时可开枪带走一人；被女巫毒杀不能开枪。炸弹人被白天公投出局时可选择带走一人。</li>
  <li>狼人达到存活人数的一半获胜；狼人全部出局，好人获胜。</li>
</ul> : <ul><li>每轮描述后投票，不能选择自己；平票无人淘汰。</li><li>卧底达到存活人数的一半获胜；卧底全部出局，平民获胜。</li></ul>}<p>到达最多轮数仍未分出胜负，则本场平局。身份按开局设置向观众展示，圆桌席位只会得到自己身份与规则允许的信息；终局全部揭晓。</p></details>}</div><div className="room-boundary-note"><Eye size={17} /><p>{room.self ? "你正在以自己的席位参与。" : "你正在观看观众视角。"}<br />{room.mode === "werewolf" && room.options.revealRolesAtStart ? "身份对观众公开，圆桌席位仍只能获知自己的身份。" : "私密身份、词语和夜间行动会按规则隐藏。"}</p></div><div className="rules-section compact"><h3>关于这张圆桌</h3><p>每个席位独立思考，按共同规则发言与行动。点击头像，可以了解这位 Agent 的运行状态。</p><Link href="/" className="text-link"><ArrowLeft size={13} />回到空间大厅</Link></div><div className="rules-footer"><HubLogo small /><span>愿每一种声音，都被听见。</span></div></>}</RoomPanel>}
    </div>
    <Dialog open={!!activeParticipant} onClose={() => setSelectedParticipant(null)} title="圆桌参与者">{activeParticipant && <div className="modal-body"><div className="agent-preview"><Avatar name={activeParticipant.modelName} vendor={activeParticipant.vendor} color={activeParticipant.color} size="large" seat={activeParticipant.seat} /><div><h3>{activeParticipant.modelName}</h3><p>{activeParticipant.vendor} · {activeParticipant.seat} 号席位</p></div></div><dl className="participant-details"><div><dt>参与方式</dt><dd>{activeParticipant.kind === "human" ? "真人参与" : activeParticipant.modelId}</dd></div><div><dt>当前状态</dt><dd>{PARTICIPANT_STATUS[activeParticipant.status]}</dd></div>{activeParticipant.role && <div><dt>已揭晓身份</dt><dd>{activeParticipant.role}</dd></div>}{activeParticipant.word && <div><dt>已揭晓词语</dt><dd>{activeParticipant.word}</dd></div>}<div><dt>运行状态</dt><dd>{activeParticipant.kind === "human" ? "由本人提交行动" : room.mode !== "debate" && room.status === "running" ? "按玩法隐藏" : activeParticipant.pid ? `PID ${activeParticipant.pid}` : "未启动或已结束"}</dd></div></dl><ParticipantPrivateChat room={room} participant={activeParticipant} /><p className="form-hint">真人席位由本人操作；Agent 席位拥有独立进程与对话上下文。</p></div>}</Dialog>
    <Dialog open={stopDialog} onClose={() => { if (!actionBusy) setStopDialog(false); }} title="结束这场圆桌？" description="当前讨论或游戏将结束，已产生的公开记录会保留。"><div className="modal-body"><p>结束后可回看完整过程，也可以下载回放。</p><ErrorNotice message={error} /></div><div className="modal-footer"><button className="button secondary" disabled={actionBusy} onClick={() => setStopDialog(false)}>再聊一会儿</button><button className="button danger" disabled={actionBusy} onClick={() => control("stop")}>{actionBusy ? "正在结束…" : "结束本场"}</button></div></Dialog>
  </div>;
}

function ParticipantPrivateChat({ room, participant }: { room: RoomView; participant: ParticipantView }) {
  const messages = (room.privateMessages ?? []).filter((event) => event.recipientIds.includes(participant.id));
  return <section className="participant-private-chat" aria-label={`${participant.modelName} 的私聊记录`}>
    <div className="private-chat-heading"><MessageCircle size={17} aria-hidden="true" /><h3>私聊记录</h3><span>{messages.length} 条</span></div>
    {messages.length ? <ol className="private-chat-thread">{messages.map((event) => {
      const outgoing = event.senderId === room.self?.participantId;
      const otherId = outgoing ? event.recipientIds.find((id) => id !== participant.id) : event.senderId;
      const other = room.participants.find((person) => person.id === otherId);
      return <li key={event.id} className={`private-chat-message ${outgoing ? "is-outgoing" : "is-incoming"}`}>
        <span className="private-chat-sender">{outgoing ? "发给" : "来自"} {other ? `${other.seat} 号 ${other.modelName}` : "未知席位"}</span>
        <div className="private-chat-bubble">{event.content}</div>
        <span className="private-chat-round">第 {event.round} 轮</span>
      </li>;
    })}</ol> : <p className="private-chat-empty">暂无私聊记录。</p>}
  </section>;
}
