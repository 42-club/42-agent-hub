"use client";

import { GameIcon, HubLogo, IconCredits } from "./icons";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { ArrowRight, Plus, House, Bot, Cable, BookOpen, Sparkles, Pencil, Trash2, X, ChevronRight, Users } from "lucide-react";
import { DEFAULT_OPTIONS, type AgentEntity, type CreateRoomInput, type DashboardData, type GameMode, type RoomOptions } from "@/domain/types";
import { api, Avatar, Dialog, EmptyState, ErrorNotice, Loading, MODE_META, STATUS_LABELS, errorMessage } from "./ui";
import { AccountMenu, useAuth } from "./auth";
import { AgentDialog, OpenRouterDialog } from "./model-settings";

type Section = "lobby" | "agents" | "guide";
const NAV = [{ id: "lobby", label: "空间大厅", icon: House }, { id: "agents", label: "我的 Agent", icon: Bot }, { id: "guide", label: "玩法与规则", icon: BookOpen }] as const;

export function Hub() {
  const { user, openAuth, activeOrganization, loading } = useAuth();
  const createRoom = (mode: GameMode) => { if (!user) openAuth(); else setCreateMode(mode); };
  const [section, setSection] = useState<Section>("lobby");
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [createMode, setCreateMode] = useState<GameMode | null>(null);
  const [agentEdit, setAgentEdit] = useState<AgentEntity | "new" | null>(null);
  const [providerEdit, setProviderEdit] = useState(false);
  const [deletion, setDeletion] = useState<{ type: "agents"; id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [roomFilter, setRoomFilter] = useState<"all" | "active" | "completed">("all");
  const refresh = async () => { const next = await api<DashboardData>("/api/dashboard"); setData(next); };
  useEffect(() => {
    setData(null); setError(null);
    if (!activeOrganization) return;
    const controller = new AbortController();
    api<DashboardData>("/api/dashboard", { signal: controller.signal }).then(setData).catch((e) => { if (!controller.signal.aborted) setError(errorMessage(e)); });
    return () => controller.abort();
  }, [activeOrganization?.id, user?.id]);
  const navigate = (next: Section) => { setSection(next); setError(null); };
  const remove = async () => {
    if (!deletion) return;
    setDeleting(true); setError(null);
    try { await api(`/api/${deletion.type}/${deletion.id}`, { method: "DELETE" }); await refresh(); setDeletion(null); }
    catch (e) { setError(errorMessage(e)); }
    finally { setDeleting(false); }
  };
  const provider = data?.providers[0];
  const rooms = data?.rooms.filter((room) => roomFilter === "all" || (roomFilter === "completed" ? room.status === "completed" : ["running", "paused", "waiting"].includes(room.status))) ?? [];
  return <div className="app-shell">
    <aside className="sidebar">
      <button className="brand" onClick={() => navigate("lobby")} aria-label="42 Agent Hub 首页"><HubLogo /><span>42<span className="brand-sub">Agent Hub</span></span></button>
      <div className="sidebar-label">一起，让想法发生</div>
      <nav className="main-nav" aria-label="主导航">{NAV.map(({ id, label, icon: Icon }) => <button key={id} className={section === id ? "nav-item active" : "nav-item"} onClick={() => navigate(id)} aria-current={section === id ? "page" : undefined}><Icon size={19} /><span>{label}</span>{id === "agents" && data && <span className="nav-count">{data.agents.length}</span>}</button>)}</nav>
      <div className="sidebar-note"><span className="tiny-flower"><Sparkles size="1em" strokeWidth={1.5} aria-hidden="true" /></span><p>不同的模型，<br />同一张圆桌。</p><small>给思考一点碰撞的空间。</small></div>
      <div className="sidebar-footer"><span className="status-dot" /><span>由 42-agent 驱动</span><span className="version">v0.1</span></div>
    </aside>
    <div className="main-shell">
      <header className="topbar"><div className="breadcrumb">{activeOrganization?.name || "42 Club"} <ChevronRight size={13} /><span>{NAV.find((item) => item.id === section)?.label}</span></div><span className="topbar-note"><span className="status-dot" />让 AI 坐下来聊聊</span><AccountMenu /></header>
      <main className={`hub-main ${section !== "lobby" ? "settings-main" : ""}`}>
        <ErrorNotice message={error} />
        {!user || !activeOrganization ? <div className="account-gate"><HubLogo /><h2>{loading ? "正在连接你的空间…" : !user ? "让你的声音，也加入圆桌" : "先选择一个组织"}</h2><p>{!user ? "登录 42 Club 账号，与组织里的伙伴和 Agent 一起交流。" : "从右上角「选择组织」进入已有组织，或创建属于你们的空间。"}</p>{!user && !loading && <button className="button primary" onClick={openAuth}>登录 / 注册</button>}</div> : !data ? (error ? <button className="button secondary" onClick={() => { setError(null); refresh().catch((e) => setError(errorMessage(e))); }}>重新加载</button> : <Loading />) : <>
          {section === "lobby" && <>
            <section className="welcome"><div className="welcome-copy"><p className="eyebrow"><span /> A LITTLE SPACE FOR BIG IDEAS</p><h1>好想法，围桌而生<span className="heading-star"><Sparkles size="1em" strokeWidth={1.5} aria-hidden="true" /></span></h1><p>请几个 AI 朋友入座。聊一个问题，或玩一场游戏。<br className="desktop-break" />看看不同的思考，会碰撞出什么。</p><button className="button primary" onClick={() => createRoom("debate")}><Plus size={18} />新建一个房间</button></div><RoundTableArt /></section>
            <section className="mode-section"><div className="section-heading"><h2>今天，想怎么玩？</h2><span>一个空间，三种相遇</span></div><div className="mode-grid">{(Object.keys(MODE_META) as GameMode[]).map((mode, index) => { const meta = MODE_META[mode]; return <button className={`mode-card mode-${meta.className}`} key={mode} onClick={() => createRoom(mode)}><span className="mode-card-top"><span className="mode-art" aria-hidden="true"><GameIcon mode={mode} /></span><span className="mode-index">0{index + 1}</span></span><h3>{meta.label}<ArrowRight size={18} /></h3><p>{meta.subtitle}</p><span className="mode-card-foot">{mode === "debate" ? "观点交流 · 多轮讨论" : mode === "undercover" ? "词语线索 · 推理投票" : "自定义角色 · 阵营对抗"}</span></button>; })}</div></section>
            <section className="rooms-section"><div className="section-heading"><h2>组织圆桌 <span className="count-label">{data.rooms.length}</span></h2><div className="segmented" aria-label="筛选房间">{([{ id: "all", label: "全部" }, { id: "active", label: "进行中" }, { id: "completed", label: "已结束" }] as const).map((filter) => <button key={filter.id} className={roomFilter === filter.id ? "selected" : ""} onClick={() => setRoomFilter(filter.id)} aria-pressed={roomFilter === filter.id}>{filter.label}</button>)}</div></div>
              {rooms.length === 0 ? <EmptyState title={data.rooms.length ? "这里还没有这样的房间" : "第一张圆桌，等你来开场"}>{data.rooms.length ? "试试查看其他状态的房间。" : "从上面选一种玩法，邀请模型入座。所有对话都会留在这里。"}</EmptyState> : <div className="room-list">{rooms.map((room) => <Link href={`/rooms/${room.id}`} className="room-list-item" key={room.id}><span className={`room-mode-icon ${MODE_META[room.mode].className}`}><GameIcon mode={room.mode} /></span><div className="room-list-copy"><div className="room-list-title"><h3>{room.title}</h3>{room.executionMode === "demo" && <span className="badge demo">离线演示</span>}</div><p>{room.topic || MODE_META[room.mode].label}</p><span className="room-list-meta"><Users size={13} />{room.participantCount} 位参与者 <span>·</span>{room.modelNames.slice(0, 3).join(" / ")}{room.modelNames.length > 3 ? " 等" : ""}</span></div><div className="room-list-status"><span className={`badge status-${room.status}`}><span className="status-dot" />{STATUS_LABELS[room.status]}</span><small>{room.phaseLabel}</small></div><ChevronRight className="room-arrow" size={17} /></Link>)}</div>}
            </section>
            <section className="lobby-bottom"><span className="bottom-flower"><Sparkles size="1em" strokeWidth={1.5} aria-hidden="true" /></span><p>每个 Agent 独立思考，每一场相遇都有新的可能。</p><button onClick={() => navigate("agents")}>认识我的 Agent <ArrowRight size={14} /></button></section>
          </>}
          {section === "agents" && <><div className="page-heading"><div><p className="eyebrow">THE VOICES AT YOUR TABLE</p><h1>我的 Agent</h1><p>用模型本来的名字，认识每一种不同的思考。</p></div><div className="page-heading-actions"><button className="button secondary" onClick={() => setProviderEdit(true)}><Cable size={16} />连接设置</button><button className="button primary" onClick={() => setAgentEdit("new")}><Plus size={17} />添加 Agent</button></div></div><div className="info-strip"><Sparkles size={18} /><p>Agent 是独立实体。同一个模型可以创建多个 Agent，也可以在房间中重复入座。</p></div>{data.agents.length === 0 ? <EmptyState title="邀请第一位 Agent 入座" action={<button className="button secondary" onClick={() => setAgentEdit("new")}>添加 Agent</button>}>从 OpenRouter 目录选择模型，为下一场讨论做准备。</EmptyState> : <div className="agent-grid">{data.agents.map((agent) => { const provider = data.providers.find((item) => item.id === agent.providerId); return <article className="agent-card" key={agent.id}><div className="agent-card-header"><Avatar name={agent.modelName} vendor={agent.vendor} color={agent.color} size="large" /><div className="card-actions"><button className="icon-button" aria-label={`编辑 ${agent.modelName}`} onClick={() => setAgentEdit(agent)}><Pencil size={15} /></button><button className="icon-button" aria-label={`删除 ${agent.modelName}`} onClick={() => { setError(null); setDeletion({ type: "agents", id: agent.id, name: agent.modelName }); }}><Trash2 size={15} /></button></div></div><h2>{agent.modelName}</h2><p className="vendor-label">{agent.vendor}</p><code>{agent.modelId}</code><div className="agent-card-footer"><span>{provider?.name || "连接已移除"}</span><span className={`connection-label ${provider?.configured ? "connected" : ""}`}><span className="status-dot" />{provider?.configured ? "已配置" : "待连接"}</span></div></article>; })}</div>}<p className="settings-footnote">所有 Agent 统一通过 OpenRouter 连接。每个房间席位都由独立的 Agent 进程运行。</p></>}
          {section === "guide" && <><div className="page-heading"><div><p className="eyebrow">MAKE YOURSELF AT HOME</p><h1>玩法与规则</h1><p>自由的交流，清楚的边界。</p></div></div><div className="guide-grid">{(Object.keys(MODE_META) as GameMode[]).map((mode) => <article className={`guide-card mode-${MODE_META[mode].className}`} key={mode}><span className="mode-art"><GameIcon mode={mode} /></span><h2>{MODE_META[mode].label}</h2><p>{MODE_META[mode].description}</p><ul>{(mode === "debate" ? ["选择话题和轮数，邀请至少 2 个席位。", "开场前加入自己的席位，每轮按席位依次发言。", "房主可以暂停和继续；所有参与者只能在自己的回合行动。"] : mode === "undercover" ? ["至少 3 个席位，自定义平民词、卧底词和卧底人数。", "词语仅在创建时设置，公开房间不会展示未揭晓的秘密。", "按轮描述再投票，不允许自投；平票无人淘汰。卧底达到存活人数一半获胜。"] : ["至少 6 个席位，可配置狼人、狼王、预言家、女巫、猎人、守卫和炸弹人。", "白天依次发言；狼人轮到发言时可自爆，结束发言和投票，未到回合上限时直接进入黑夜。狼王可指定全队的夜间刀口。", "守卫夜间守护，猎人被狼人袭击或公投出局可开枪；炸弹人被公投出局可带走一人。身份可选仅向观众开局公开，终局依次复盘。"]).map((item) => <li key={item}>{item}</li>)}</ul><button className="button secondary" onClick={() => createRoom(mode)}>试试这个玩法 <ArrowRight size={15} /></button></article>)}</div><div className="guide-principles"><h2>每一场圆桌，都遵守这些约定</h2><div><article><span>01</span><h3>独立的参与者</h3><p>每个席位都有独立的上下文与运行进程。相同模型也可以多次入座。</p></article><article><span>02</span><h3>看得见的规则</h3><p>自定义配置在开场前确定，投票、角色能力和胜负都接受规则校验。</p></article><article><span>03</span><h3>留下真实的过程</h3><p>公开发言和阶段变化保留为记录。结束后可以按轮回看，并导出回放。</p></article></div></div><IconCredits /></>}
        </>}
      </main>
      <footer className="app-footer"><HubLogo small /><span>A room for every perspective.</span><button className="icon-credit-link" onClick={() => navigate("guide")}>图标来源</button></footer>
    </div>
    {data && createMode && <CreateRoomDialog initialMode={createMode} data={data} onClose={() => setCreateMode(null)} />}
    {data && agentEdit && <AgentDialog agent={agentEdit === "new" ? undefined : agentEdit} provider={data.providers[0]} onClose={() => setAgentEdit(null)} onSaved={refresh} />}
    {providerEdit && <OpenRouterDialog provider={provider} onClose={() => setProviderEdit(false)} onSaved={refresh} />}
    <Dialog open={!!deletion} onClose={() => { if (!deleting) setDeletion(null); }} title="移除 Agent"><div className="modal-body"><p>确定移除「{deletion?.name}」？已有房间的记录将会保留。</p><ErrorNotice message={error} /></div><div className="modal-footer"><button className="button secondary" onClick={() => setDeletion(null)} disabled={deleting}>取消</button><button className="button danger" disabled={deleting} onClick={remove}>{deleting ? "正在移除…" : "确认移除"}</button></div></Dialog>
  </div>;
}

function CreateRoomDialog({ initialMode, data, onClose }: { initialMode: GameMode; data: DashboardData; onClose: () => void }) {
  const { user, openAuth } = useAuth();
  const [joinAsParticipant, setJoinAsParticipant] = useState(false);
  const [mode, setMode] = useState<GameMode>(initialMode);
  const [title, setTitle] = useState("");
  const [topic, setTopic] = useState("");
  const [executionMode, setExecutionMode] = useState<"demo" | "live">(data.providers[0]?.configured ? "live" : "demo");
  const [options, setOptions] = useState<RoomOptions>({ ...DEFAULT_OPTIONS });
  const initialSeats = (gameMode: GameMode) => { const count = gameMode === "werewolf" ? 6 : Math.min(4, data.agents.length); return data.agents.length ? Array.from({ length: count }, (_, i) => data.agents[i % data.agents.length].id) : []; };
  const [seats, setSeats] = useState<string[]>(() => initialSeats(initialMode));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seatCount = seats.length + Number(joinAsParticipant);
  const minimum = mode === "debate" ? 2 : mode === "undercover" ? 3 : 6;
  const specialGoodCount = Number(options.hasSeer) + Number(options.hasWitch) + Number(options.hasHunter) + Number(options.hasGuard) + Number(options.hasBomber);
  const villagerCount = seatCount - options.werewolfCount - specialGoodCount;
  const updateOption = <K extends keyof RoomOptions>(key: K, value: RoomOptions[K]) => setOptions((previous) => ({ ...previous, [key]: value }));
  const changeMode = (next: GameMode) => { setMode(next); if (next === "werewolf" && seats.length < 6) setSeats(initialSeats(next)); };
  const unconnected = seats.some((id) => !data.providers.find((p) => p.id === data.agents.find((a) => a.id === id)?.providerId)?.configured);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError(null);
    if (seatCount < minimum) return setError(`这个玩法至少需要 ${minimum} 个席位。可以重复添加同一模型。`);
    if (executionMode === "live" && unconnected) return setError("OpenRouter 尚未配置密钥，请先完成连接，或选择离线演示。");
    if (mode === "debate" && !topic.trim()) return setError("先给这场讨论一个话题吧。");
    if (mode === "undercover" && (!options.civilianWord.trim() || !options.undercoverWord.trim() || options.civilianWord.trim() === options.undercoverWord.trim())) return setError("请输入两个不同的词语。");
    if (mode === "undercover" && options.undercoverCount >= seatCount / 2) return setError("卧底人数需要少于总席位的一半。");
    if (mode === "werewolf" && options.werewolfCount * 2 >= seatCount) return setError("狼人数量需要少于总席位的一半。");
    if (mode === "werewolf" && villagerCount < 1) return setError("至少保留一位村民。请增加席位或减少特殊身份。");
    setBusy(true);
    try { const input: CreateRoomInput = { title: title.trim() || `${MODE_META[mode].label}小屋`, topic: topic.trim(), mode, agentIds: seats, joinAsParticipant, executionMode, options: { ...options, revealRolesAtStart: joinAsParticipant ? false : options.revealRolesAtStart } }; const room = await api<{ id: string }>("/api/rooms", { method: "POST", body: JSON.stringify(input) }); window.location.assign(`/rooms/${room.id}`); }
    catch (e) { setError(errorMessage(e)); setBusy(false); }
  };
  return <Dialog open onClose={() => { if (!busy) onClose(); }} wide title="开一间自己的小屋" description="选好玩法，邀请模型，然后把时间留给思考。"><form onSubmit={submit}><div className="modal-body create-room-body"><div className="mode-choice">{(Object.keys(MODE_META) as GameMode[]).map((item) => <button type="button" key={item} className={mode === item ? "chosen" : ""} onClick={() => changeMode(item)} aria-pressed={mode === item}><span><GameIcon mode={item} /></span>{MODE_META[item].label}</button>)}</div><div className="form-grid"><label className="field">房间名称 <span className="optional">选填</span><input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={`${MODE_META[mode].label}小屋`} maxLength={80} /></label><label className="field">运行方式<select value={executionMode} onChange={(e) => setExecutionMode(e.target.value as "demo" | "live")}><option value="demo">离线演示 · 不调用真实模型</option><option value="live">真实模型 · 通过 OpenRouter</option></select></label></div><p className={`form-hint ${executionMode === "demo" ? "demo-hint" : ""}`}>{executionMode === "demo" ? "离线演示使用本地预设响应，帮助你熟悉完整流程。" : "真实运行通过 OpenRouter 调用所选模型，并产生相应的模型用量。"}</p>{mode === "debate" && <label className="field">讨论话题<textarea value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="比如：AI 时代，我们应该如何重新理解学习？" rows={3} required maxLength={1500} /></label>}<div className="form-section-heading"><h3>邀请入座 <span>{seatCount} / 至少 {minimum} 位</span></h3><small>同一模型可以重复添加</small></div><div className="join-self-card"><div><strong>也给自己加一个席位</strong><p>和 Agent 一起入座，轮到你时再发言。其他用户也可以在开场前加入。</p></div><label className="checkbox-line"><input type="checkbox" checked={joinAsParticipant} disabled={!joinAsParticipant && seats.length >= 12} onChange={(e) => { if (!user) { openAuth(); return; } setJoinAsParticipant(e.target.checked); }} />{joinAsParticipant ? "已加入 · 最后一个席位" : "我要参加"}</label></div><div className="seat-picker">{seats.map((id, index) => { const agent = data.agents.find((item) => item.id === id); return <div className="picked-seat" key={`${index}-${id}`}><Avatar name={agent?.modelName || "?"} vendor={agent?.vendor} color={agent?.color} size="small" /><span><small>{index + 1} 号席位</small>{agent?.modelName || "已移除的 Agent"}</span><button type="button" className="icon-button" aria-label={`移除 ${index + 1} 号席位`} onClick={() => setSeats((previous) => previous.filter((_, i) => i !== index))}><X size={15} /></button></div>; })}</div><label className="field add-seat-field"><span className="sr-only">添加 Agent 席位</span><select value="" onChange={(e) => { if (e.target.value) setSeats((previous) => [...previous, e.target.value]); }} disabled={seatCount >= 12 || data.agents.length === 0}><option value="">＋ 添加一个 Agent 席位{seatCount >= 12 ? "（最多 12 位）" : ""}</option>{data.agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.modelName} · {agent.vendor}</option>)}</select></label>{data.agents.length === 0 && <p className="form-hint">先在「我的 Agent」中添加模型，再邀请它们入座。</p>}<div className="form-section-heading"><h3>这间小屋的规则</h3></div><div className="form-grid">{mode === "debate" ? <label className="field">讨论轮数<input type="number" min={1} max={10} value={options.rounds} onChange={(e) => updateOption("rounds", Number(e.target.value))} required /></label> : <label className="field">最多进行轮数<input type="number" min={2} max={20} value={options.maxRounds} onChange={(e) => updateOption("maxRounds", Number(e.target.value))} required /></label>}{mode === "undercover" && <label className="field">卧底人数<input type="number" min={1} max={Math.min(4, Math.max(1, Math.floor((seatCount - 1) / 2)))} value={options.undercoverCount} onChange={(e) => updateOption("undercoverCount", Number(e.target.value))} required /></label>}{mode === "werewolf" && <label className="field">狼人数量<input type="number" min={1} max={Math.min(4, Math.max(1, Math.floor((seatCount - 1) / 2)))} value={options.werewolfCount} onChange={(e) => updateOption("werewolfCount", Number(e.target.value))} required /></label>}</div>{mode === "undercover" && <><div className="form-grid"><label className="field">平民词<input value={options.civilianWord} onChange={(e) => updateOption("civilianWord", e.target.value)} required maxLength={30} /></label><label className="field">卧底词<input value={options.undercoverWord} onChange={(e) => updateOption("undercoverWord", e.target.value)} required maxLength={30} /></label></div><p className="form-hint">词语只发给对应席位，开局后不在公开房间中展示。</p></>}{mode === "werewolf" && <>
  <fieldset className="ww-role-picker">
    <legend>特殊身份</legend>
    <div className="checkbox-row ww-role-options">
      <label><input type="checkbox" checked={options.hasSeer} onChange={(e) => updateOption("hasSeer", e.target.checked)} />预言家</label>
      <label><input type="checkbox" checked={options.hasWitch} onChange={(e) => updateOption("hasWitch", e.target.checked)} />女巫</label>
      <label><input type="checkbox" checked={options.hasHunter} onChange={(e) => updateOption("hasHunter", e.target.checked)} />猎人</label>
      <label><input type="checkbox" checked={options.hasGuard} onChange={(e) => updateOption("hasGuard", e.target.checked)} />守卫</label>
      <label><input type="checkbox" checked={options.hasBomber} onChange={(e) => updateOption("hasBomber", e.target.checked)} />炸弹人</label>
      <label><input type="checkbox" checked={options.hasWolfKing} onChange={(e) => updateOption("hasWolfKing", e.target.checked)} />狼王</label>
    </div>
    <p className={`form-hint ww-role-budget ${villagerCount < 1 ? "is-invalid" : ""}`} role={villagerCount < 1 ? "alert" : undefined}>当前 {seatCount} 个席位：狼人阵营 {options.werewolfCount} 位{options.hasWolfKing ? "（含狼王 1 位）" : ""}，特殊好人 {specialGoodCount} 位，村民 {Math.max(villagerCount, 0)} 位{villagerCount < 1 ? " · 至少需要 1 位村民" : ""}。</p>
  </fieldset>
  <label className="checkbox-line"><input type="checkbox" checked={!joinAsParticipant && options.revealRolesAtStart} disabled={joinAsParticipant} onChange={(e) => updateOption("revealRolesAtStart", e.target.checked)} />开局向观众公开身份</label>
  <p className="form-hint ww-spectator-hint">公开身份仅供观众查看，参与模型仍只知道自己的身份与规则允许的信息。</p>
</>}<label className="checkbox-line"><input type="checkbox" checked={options.allowPrivateMessages} onChange={(e) => updateOption("allowPrivateMessages", e.target.checked)} />允许规则范围内的私密交流</label><ErrorNotice message={error} /></div><div className="modal-footer"><span className="footer-hint">创建后，你可以在房间里开始。</span><button type="button" className="button secondary" onClick={onClose} disabled={busy}>取消</button><button className="button primary" disabled={busy || !data.agents.length}>{busy ? "正在布置房间…" : "创建房间"}<ArrowRight size={16} /></button></div></form></Dialog>;
}

function RoundTableArt() {
  return <div className="round-table-art" aria-hidden="true"><svg viewBox="0 0 360 230" fill="none"><ellipse cx="185" cy="202" rx="135" ry="13" fill="#EAE7DC"/><path d="M288 195V134" stroke="#869875" strokeWidth="4" strokeLinecap="round"/><path d="M287 166C259 160 258 143 270 141C285 139 287 155 287 166Z" fill="#A8B79A"/><path d="M291 150C310 143 313 125 302 123C290 124 290 140 291 150Z" fill="#8EAA86"/><path d="M274 174H302L298 200H278L274 174Z" fill="#DABAA0"/><path d="M95 151L84 201M239 150L251 201" stroke="#B18D6E" strokeWidth="10" strokeLinecap="round"/><path d="M167 62V88" stroke="#9DAF91" strokeWidth="7"/><path d="M132 77C132 52 148 38 169 38C190 38 206 52 206 77V94H132V77Z" fill="#A6BA98"/><path d="M143 81C143 67 154 58 169 58C184 58 195 67 195 81V96H143V81Z" fill="#DBE6D2"/><circle cx="160" cy="76" r="2.7" fill="#4C6651"/><circle cx="178" cy="76" r="2.7" fill="#4C6651"/><path d="M164 86Q169 90 174 86" stroke="#4C6651" strokeWidth="2" strokeLinecap="round"/><rect x="38" y="104" width="59" height="76" rx="26" fill="#D7B09A"/><path d="M37 129C37 109 51 96 68 96C87 96 101 112 101 131V145H37V129Z" fill="#E9C8B3"/><circle cx="58" cy="124" r="2.7" fill="#715A49"/><circle cx="75" cy="124" r="2.7" fill="#715A49"/><path d="M61 134Q67 138 72 133" stroke="#715A49" strokeWidth="2" strokeLinecap="round"/><path d="M67 174L61 197M84 173L88 195" stroke="#B89278" strokeWidth="7" strokeLinecap="round"/><rect x="239" y="104" width="54" height="66" rx="25" fill="#A4A7BE"/><path d="M230 117C230 97 242 83 262 83C281 83 296 100 296 119V135H230V117Z" fill="#D3D1E3"/><circle cx="248" cy="110" r="2.7" fill="#666078"/><circle cx="265" cy="110" r="2.7" fill="#666078"/><path d="M251 120Q257 124 263 120" stroke="#666078" strokeWidth="2" strokeLinecap="round"/><ellipse cx="166" cy="145" rx="104" ry="38" fill="#B38F70"/><ellipse cx="166" cy="137" rx="104" ry="38" fill="#E0C3A2"/><ellipse cx="166" cy="133" rx="94" ry="30" fill="#E8CEAE"/><path d="M148 133L173 126L187 135L162 143Z" fill="#FBF7EC"/><path d="M162 132L175 134M158 135L170 137" stroke="#B5BEA2" strokeWidth="2" strokeLinecap="round"/><path d="M206 123H219V132C219 140 206 140 206 132V123Z" fill="#F6F2E7"/><path d="M219 126C228 124 226 134 219 132" stroke="#F6F2E7" strokeWidth="3"/><ellipse cx="212" cy="123" rx="6.5" ry="2" fill="#A78768"/><path d="M212 115C208 110 217 108 212 103" stroke="#B7AF99" strokeWidth="2" strokeLinecap="round"/><rect x="135" y="165" width="62" height="43" rx="23" fill="#D8C993"/><path d="M129 169C129 144 145 132 167 132C189 132 205 148 205 172V192H129V169Z" fill="#EADDAD"/><path d="M135 155C138 144 146 139 155 137" stroke="#F2EACD" strokeWidth="5" strokeLinecap="round"/><path d="M61 51L65 41L69 51L79 55L69 59L65 69L61 59L51 55L61 51Z" fill="#CAB990"/><path d="M269 46L272 38L275 46L283 49L275 52L272 60L269 52L261 49L269 46Z" fill="#A7B59A"/><circle cx="105" cy="25" r="3" fill="#D7C6AE"/><circle cx="311" cy="86" r="3" fill="#D7C6AE"/><path d="M101 76C110 67 115 69 121 75" stroke="#B8C3A9" strokeWidth="2" strokeLinecap="round"/></svg><span className="art-caption">GOOD COMPANY. GOOD CONVERSATIONS.</span></div>;
}
