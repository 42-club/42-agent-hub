"use client";

import { useState, type FormEvent } from "react";
import { AGENT_PORTRAITS, type AgentEntity, type AgentPortrait } from "@/domain/types";
import { api, Avatar, Dialog, ErrorNotice, errorMessage } from "./ui";

export function AgentDialog({ agent, onClose, onSaved }: { agent?: AgentEntity; onClose: () => void; onSaved: () => Promise<void> }) {
  const copying = agent?.source === "system";
  const [name, setName] = useState(copying ? `${agent.name} · 我的版本` : agent?.name ?? "");
  const [description, setDescription] = useState(agent?.description ?? "");
  const [instructions, setInstructions] = useState(agent?.instructions ?? "");
  const [color, setColor] = useState(agent?.color ?? "#77977b");
  const [portrait, setPortrait] = useState<AgentPortrait | "">(agent?.portrait ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const editing = agent && !copying;
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(null);
    try {
      await api(editing ? `/api/agents/${agent.id}` : "/api/agents", {
        method: editing ? "PUT" : "POST", body: JSON.stringify({ name, description, instructions, color, ...(portrait ? { portrait } : {}) }),
      });
      await onSaved(); onClose();
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }
  return <Dialog open onClose={() => { if (!busy) onClose(); }} title={copying ? "另存为个人 Agent" : editing ? "编辑个人 Agent" : "创建个人 Agent"} description="定义它的个性与交流方式，就能邀请它加入圆桌。">
    <form onSubmit={submit}>
      <div className="modal-body">
        <div className="agent-preview"><Avatar name={name || "Agent"} color={color} portrait={portrait || undefined} size="large" /><div><h3>{name || "你的 Agent"}</h3><p>个人 Agent · 仅你可管理</p></div></div>
        <fieldset disabled={busy}>
          <label className="field">名称<input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required placeholder="圆桌上的称呼" /></label>
          <label className="field">介绍<input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={240} placeholder="用一句话介绍它" /></label>
          <label className="field">个性与交流方式<textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} maxLength={4000} rows={6} placeholder="例如：善于用生活中的例子解释观点，发言简洁，愿意根据新证据修正判断。" /></label>
          <label className="field">头像颜色<input type="color" value={color} onChange={(e) => setColor(e.target.value)} /></label>
          <label className="field">人物头像<select value={portrait} onChange={(e) => setPortrait(e.target.value as AgentPortrait | "")}><option value="">默认头像</option>{AGENT_PORTRAITS.map((id, index) => <option key={id} value={id}>{["林小满", "陈序", "许棠", "周野", "大肥鱼"][index]}风格</option>)}</select></label>
        </fieldset>
        <p className="form-hint">修改只影响之后创建的房间；已经入座的 Agent 会保留开场前的设定。</p>
        <ErrorNotice message={error} />
      </div>
      <div className="modal-footer"><button type="button" className="button secondary" onClick={onClose} disabled={busy}>取消</button><button className="button primary" disabled={busy || !name.trim()}>{busy ? "正在保存…" : "保存 Agent"}</button></div>
    </form>
  </Dialog>;
}
