import { ChevronDown } from "lucide-react";
import type { GameEvent, ParticipantView } from "@/domain/types";
import { Avatar } from "./ui";
import { MessageMarkdown } from "./message-markdown";

export type ReadingMode = "bubbles" | "reading" | "compact";

export function RoomMessage({ event, participant, previousRound, mode, side }: {
  event: GameEvent;
  participant?: ParticipantView;
  previousRound?: number;
  mode: ReadingMode;
  side: "left" | "right";
}) {
  const displayName = participant?.modelName || (event.senderId ? "主持人" : "圆桌记录");
  const newRound = event.round > 0 && event.round !== previousRound;
  const time = new Date(event.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  const meta = <div className="message-meta"><strong>{displayName}</strong>{participant && <span className="seat-label">{participant.seat} 号</span>}{event.type === "action" && <span className="action-label">行动</span>}<time dateTime={event.createdAt}>{time}</time></div>;
  const avatar = <Avatar name={displayName} vendor={participant?.vendor} color={participant?.color || "#e7dfcf"} size="normal" />;
  return <>
    {newRound && <div className="round-divider"><span />第 {event.round} 轮<span /></div>}
    {event.type === "system" ? <div className="system-event"><span className="system-event-dot" /><p>{event.content}</p></div>
      : mode === "compact" && event.type === "message" ? <details className="compact-message" data-event-id={event.id}>
        <summary>{avatar}<div className="compact-message-summary">{meta}<p>{event.content.replace(/\s+/g, " ").slice(0, 140)}</p></div><ChevronDown className="compact-chevron" size={16} /><span className="sr-only">展开或收起消息全文</span></summary>
        <div className="compact-message-content"><MessageMarkdown content={event.content} /></div>
      </details>
      : <article className={`timeline-message ${event.type === "action" ? "action-message" : `message-${side}`}`} data-event-id={event.id}>
        {avatar}<div className="message-body">{meta}<div className="message-surface"><MessageMarkdown content={event.content} /></div></div>
      </article>}
  </>;
}
