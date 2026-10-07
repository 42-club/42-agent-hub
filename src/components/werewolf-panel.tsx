"use client";

import { useId, useState } from "react";
import { ArrowRight, BadgeCheck, ChevronDown, ChevronLeft, ChevronRight, CircleCheck, CircleMinus, Eye, LockKeyhole, Users, Vote } from "lucide-react";
import type { ParticipantView, RoomView, VoteRoundView } from "@/domain/types";
import { Avatar } from "./ui";
import "./werewolf-panel.css";

export function WerewolfPanel({ room }: { room: RoomView }) {
  const id = useId();
  const [selectedVoteId, setSelectedVoteId] = useState<string | null>(null);
  const participants = new Map(room.participants.map((person) => [person.id, person]));
  const history = [...(room.voting?.history ?? [])].sort((a, b) => a.round - b.round);
  const latestVote = history.at(-1);
  const selectedVote = history.find((vote) => vote.id === selectedVoteId) ?? latestVote;
  const selectedIndex = selectedVote ? history.findIndex((vote) => vote.id === selectedVote.id) : -1;
  const aliveCount = room.participants.filter((person) => person.alive).length;
  const eliminatedCount = room.participants.length - aliveCount;
  const collecting = room.voting?.phase === "collecting" ? room.voting : null;
  const initialRoles = [
    { name: "狼人", count: room.options.werewolfCount - Number(Boolean(room.options.hasWolfKing)) },
    { name: "狼王", count: Number(Boolean(room.options.hasWolfKing)) },
    { name: "预言家", count: Number(Boolean(room.options.hasSeer)) },
    { name: "女巫", count: Number(Boolean(room.options.hasWitch)) },
    { name: "猎人", count: Number(Boolean(room.options.hasHunter)) },
    { name: "守卫", count: Number(Boolean(room.options.hasGuard)) },
    { name: "炸弹人", count: Number(Boolean(room.options.hasBomber)) },
    { name: "村民", count: room.participants.length - room.options.werewolfCount - Number(Boolean(room.options.hasSeer)) - Number(Boolean(room.options.hasWitch)) - Number(Boolean(room.options.hasHunter)) - Number(Boolean(room.options.hasGuard)) - Number(Boolean(room.options.hasBomber)) },
  ];

  function selectVote(voteId: string) {
    setSelectedVoteId(voteId === latestVote?.id ? null : voteId);
  }

  if (room.mode !== "werewolf") return null;

  return <section className="werewolf-panel" aria-labelledby={`${id}-title`}>
    <header className="ww-panel-heading">
      <div><Eye size={17} aria-hidden="true" /><h2 id={`${id}-title`}>公开局势</h2></div>
      <span className="ww-phase-label">{room.phaseLabel || "等待开场"}</span>
    </header>

    <section className="ww-section ww-voting-section" aria-labelledby={`${id}-voting-title`}>
      <div className="ww-section-heading"><h3 id={`${id}-voting-title`}><Vote size={16} aria-hidden="true" />白天投票</h3>{history.length > 0 && <span>{history.length} 轮已公布</span>}</div>

      {collecting && <div className="ww-collection" role="status" aria-live="polite" aria-atomic="true">
        <div className="ww-collection-heading"><strong>第 {collecting.round} 轮</strong><span>{room.status === "paused" ? "投票已暂停" : room.status === "error" ? "等待继续" : "正在收集投票"}</span></div>
        {collecting.eligibleCount > 0 ? <>
          <progress className="ww-collection-progress" max={collecting.eligibleCount} value={Math.min(collecting.submittedCount, collecting.eligibleCount)} aria-label={`第 ${collecting.round} 轮投票收集进度`} aria-valuetext={`${collecting.submittedCount} 位已提交，共 ${collecting.eligibleCount} 位`} />
          <p><strong>{collecting.submittedCount} / {collecting.eligibleCount}</strong> 位已提交</p>
        </> : <p>等待投票开始。</p>}
        <p className="ww-supporting">全部收齐后统一公布，当前票型暂不公开。</p>
      </div>}

      {selectedVote ? <>
        <div className="ww-round-switcher">
          <button type="button" className="ww-round-arrow" disabled={selectedIndex <= 0} onClick={() => { const previous = history[selectedIndex - 1]; if (previous) selectVote(previous.id); }} aria-label="查看上一轮已公布投票"><ChevronLeft size={18} aria-hidden="true" /></button>
          <label className="ww-round-select"><span className="sr-only">选择已公布投票轮次</span><select value={selectedVote.id} onChange={(event) => selectVote(event.target.value)}>{history.map((vote) => <option key={vote.id} value={vote.id}>第 {vote.round} 轮{vote.id === latestVote?.id ? " · 最新" : ""}</option>)}</select></label>
          <button type="button" className="ww-round-arrow" disabled={selectedIndex >= history.length - 1} onClick={() => { const next = history[selectedIndex + 1]; if (next) selectVote(next.id); }} aria-label="查看下一轮已公布投票"><ChevronRight size={18} aria-hidden="true" /></button>
        </div>
        <VoteResult key={selectedVote.id} vote={selectedVote} participants={participants} />
      </> : <div className="ww-empty-votes">
        <Vote size={23} strokeWidth={1.5} aria-hidden="true" />
        <p>{room.status === "completed" ? "这场回放暂无单独保存的票型明细。" : "这里会留下每一轮公开票型。"}</p>
        <span>{room.status === "completed" ? "较早的回放可能没有此记录，可以在公开记录中查看当时的结果。" : "白天投票结束后，可查看得票和每位玩家的选择。"}</span>
      </div>}
    </section>

    <section className="ww-section" aria-labelledby={`${id}-players-title`}>
      <div className="ww-section-heading"><h3 id={`${id}-players-title`}><Users size={16} aria-hidden="true" />玩家状态</h3><span>存活 {aliveCount} · 出局 {eliminatedCount}</span></div>
      <ul className="ww-player-list">{room.participants.map((person) => <li key={person.id} className={`ww-player-card ${person.alive ? "" : "is-eliminated"}`}>
        <Avatar name={person.modelName} vendor={person.vendor} color={person.color} size="small" />
        <div className="ww-player-copy"><div className="ww-player-identity"><span>{person.seat} 号</span><strong>{person.modelName}</strong></div><span className={`ww-player-role ${person.role ? "is-revealed" : ""}`}>{person.role ? <BadgeCheck size={13} aria-hidden="true" /> : <LockKeyhole size={12} aria-hidden="true" />}{person.role ? `身份：${person.role}` : "身份未揭晓"}</span></div>
        <span className={`ww-life-state ${person.alive ? "is-alive" : ""}`}>{person.alive ? <CircleCheck size={13} aria-hidden="true" /> : <CircleMinus size={13} aria-hidden="true" />}{person.alive ? "存活" : "出局"}</span>
      </li>)}</ul>
      <p className="ww-supporting ww-privacy-note"><LockKeyhole size={13} aria-hidden="true" /><span>身份按开局设置展示。夜间行动与药剂状态不在公开视角显示。</span></p>
    </section>

    <section className="ww-section ww-initial-section" aria-labelledby={`${id}-roles-title`}>
      <div className="ww-section-heading"><h3 id={`${id}-roles-title`}>初始角色配置</h3></div>
      <dl className="ww-role-counts">{initialRoles.map((role) => <div key={role.name}><dt>{role.name}</dt><dd>{role.count}<span> 位</span></dd></div>)}</dl>
      <p className="ww-supporting">这是开局人数，不代表各角色当前的存活人数。</p>
    </section>
  </section>;
}

function VoteResult({ vote, participants }: { vote: VoteRoundView; participants: Map<string, ParticipantView> }) {
  const counts = new Map<string, number>();
  for (const record of vote.votes) counts.set(record.targetId, (counts.get(record.targetId) ?? 0) + 1);
  const tallies = [...counts].sort(([firstId, firstCount], [secondId, secondCount]) => secondCount - firstCount || (participants.get(firstId)?.seat ?? Infinity) - (participants.get(secondId)?.seat ?? Infinity));
  const eliminated = vote.eliminatedId ? participants.get(vote.eliminatedId) : undefined;
  const ballots = [...vote.votes].sort((first, second) => (participants.get(first.voterId)?.seat ?? Infinity) - (participants.get(second.voterId)?.seat ?? Infinity));

  return <div className="ww-vote-result">
    <div className={`ww-vote-outcome ${vote.eliminatedId ? "has-elimination" : ""}`}>
      {vote.eliminatedId ? <CircleMinus size={17} aria-hidden="true" /> : <CircleCheck size={17} aria-hidden="true" />}
      <p>{vote.tied ? <><strong>平票，本轮无人出局</strong><span>最高得票相同，依照规则不淘汰玩家。</span></> : vote.eliminatedId ? <><strong>{eliminated ? `${eliminated.seat} 号玩家出局` : "本轮已产生淘汰结果"}</strong>{eliminated && <span>{eliminated.modelName}</span>}</> : <strong>本轮无人出局</strong>}</p>
    </div>
    <div className="ww-tally-heading"><span>已公布得票</span><span>共 {vote.votes.length} 票</span></div>
    {tallies.length > 0 ? <ol className="ww-tally-list">{tallies.map(([targetId, count]) => {
      const person = participants.get(targetId);
      return <li key={targetId} className={targetId === vote.eliminatedId ? "is-eliminated" : ""}>
        <div className="ww-tally-label"><span>{person ? <><b>{person.seat} 号</b> {person.modelName}</> : "未找到的席位"}</span><strong>{count} 票</strong></div>
        <div className="ww-tally-track" aria-hidden="true"><span style={{ width: `${count / Math.max(vote.votes.length, 1) * 100}%` }} /></div>
      </li>;
    })}</ol> : <p className="ww-supporting">本轮没有已保存的投票明细。</p>}
    {ballots.length > 0 && <details className="ww-ballot-details">
      <summary><span>每位玩家投给了谁</span><ChevronDown size={16} aria-hidden="true" /></summary>
      <ol className="ww-ballot-list">{ballots.map((record, index) => <li key={`${record.voterId}-${index}`}>
        <BallotPlayer person={participants.get(record.voterId)} />
        <span className="ww-ballot-arrow"><ArrowRight size={15} aria-hidden="true" /><span className="sr-only">投给</span></span>
        <BallotPlayer person={participants.get(record.targetId)} />
      </li>)}</ol>
    </details>}
  </div>;
}

function BallotPlayer({ person }: { person: ParticipantView | undefined }) {
  return <span className="ww-ballot-player"><strong>{person ? `${person.seat} 号` : "未知席位"}</strong>{person && <span>{person.modelName}</span>}</span>;
}
