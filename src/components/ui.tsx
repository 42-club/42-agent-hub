"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { X, LoaderCircle, ArrowUpRight, MessagesSquare } from "lucide-react";
import type { GameMode, RoomStatus } from "@/domain/types";
import { brandForVendor, VendorMark } from "./icons";
export { brandForVendor } from "./icons";

export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "操作没有完成，请稍后重试。");
  return data as T;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "操作没有完成，请稍后重试。";
}

export const MODE_META: Record<GameMode, { label: string; subtitle: string; description: string; className: string }> = {
  debate: { label: "圆桌辩论", subtitle: "让不同的观点，好好聊一聊。", description: "抛出一个问题，让模型独立思考、交流、回应。", className: "sage" },
  undercover: { label: "谁是卧底", subtitle: "相似的词，不一样的心思。", description: "从只言片语里寻找线索，看看谁藏得更好。", className: "peach" },
  werewolf: { label: "狼人杀", subtitle: "夜幕降临，故事开始。", description: "身份、推理与选择，一场属于 AI 的文字游戏。", className: "lilac" },
};

export const STATUS_LABELS: Record<RoomStatus, string> = {
  waiting: "等待开始", running: "进行中", paused: "已暂停", completed: "已结束", error: "需要处理",
};

export function Avatar({ name, vendor = "", color, size = "normal", seat }: { name: string; vendor?: string; color?: string; size?: "small" | "normal" | "large"; seat?: number }) {
  const brand = brandForVendor(vendor);
  const background = brand.id === "other" && color?.startsWith("#") ? color : brand.background;
  return <span className={`model-avatar vendor-avatar avatar-${size} vendor-${brand.id}`} style={{ "--avatar-color": background, color: brand.foreground } as React.CSSProperties} aria-hidden="true">
    {vendor === "真人" ? <span className="human-initial">{name.trim().slice(0, 1) || "我"}</span> : <VendorMark vendor={vendor} />}
    {seat !== undefined && <span className="avatar-seat">{seat}</span>}
  </span>;
}

export function Dialog({ open, onClose, title, description, children, wide = false }: { open: boolean; onClose: () => void; title: string; description?: string; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return <dialog ref={ref} className={`modal ${wide ? "modal-wide" : ""}`} onCancel={(event) => { event.preventDefault(); onClose(); }} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }} aria-label={title}>
    <div className="modal-header"><div><p className="eyebrow">42 AGENT HUB</p><h2>{title}</h2>{description && <p className="muted">{description}</p>}</div><button type="button" className="icon-button" aria-label="关闭对话框" onClick={onClose}><X size={19} /></button></div>
    {children}
  </dialog>;
}

export function ErrorNotice({ message }: { message: string | null }) {
  return message ? <div className="error-notice" role="alert">{message}</div> : null;
}

export function Loading({ label = "正在准备这个空间…" }: { label?: string }) {
  return <div className="loading-state" role="status"><LoaderCircle className="spin" size={23} /><span>{label}</span></div>;
}

export function EmptyState({ symbol = <MessagesSquare size={34} strokeWidth={1.5} />, title, children, action }: { symbol?: ReactNode; title: string; children: ReactNode; action?: ReactNode }) {
  return <div className="empty-state"><span className="empty-symbol" aria-hidden="true">{symbol}</span><h3>{title}</h3><p>{children}</p>{action}</div>;
}

export function ArrowLink({ children }: { children: ReactNode }) {
  return <span className="arrow-link">{children}<ArrowUpRight size={16} /></span>;
}
