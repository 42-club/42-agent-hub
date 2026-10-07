"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ArrowRight, LoaderCircle, LogOut, UserRound } from "lucide-react";
import type { Organization } from "@/lib/club-service";
import { OrganizationMenu } from "./organizations";
import { HubLogo } from "./icons";
import { api, Avatar, Dialog, ErrorNotice, Loading, errorMessage } from "./ui";

type User = { id: string; email: string; profile: { display_name: string; avatar_url?: string | null } };
type AuthMode = "login" | "register" | "reset";
const AuthContext = createContext<{ user: User | null; organizations: Organization[]; activeOrganization: Organization | null; loading: boolean; openAuth: () => void; refresh: () => Promise<void>; logout: () => Promise<void> } | null>(null);
export function useAuth() { const auth = useContext(AuthContext); if (!auth) throw new Error("Missing AuthProvider"); return auth; }

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [activeOrganization, setActiveOrganization] = useState<Organization | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sessionSequence = useRef(0);
  const channel = useRef<BroadcastChannel | null>(null);
  const refresh = useCallback(async () => {
    const sequence = ++sessionSequence.current;
    try { const session = await api<{ user: User | null; organizations: Organization[]; activeOrganization: Organization | null }>("/api/auth/session"); if (sequence !== sessionSequence.current) return; setUser(session.user); setOrganizations(session.organizations); setActiveOrganization(session.activeOrganization); setError(null); }
    catch (error) { if (sequence === sessionSequence.current) { setUser(null); setOrganizations([]); setActiveOrganization(null); } throw error; }
    finally { if (sequence === sessionSequence.current) setLoading(false); }
  }, []);
  useEffect(() => {
    const sync = () => { void refresh().catch(() => setError("账号状态暂时无法同步，请稍后重试")); };
    sync();
    channel.current = new BroadcastChannel("42-account");
    channel.current.onmessage = sync;
    window.addEventListener("focus", sync);
    const timer = setInterval(sync, 5 * 60_000);
    return () => { channel.current?.close(); window.removeEventListener("focus", sync); clearInterval(timer); };
  }, [refresh]);
  const logout = async () => {
    try { await api("/api/auth/logout", { method: "POST", body: "{}" }); sessionSequence.current++; setUser(null); setOrganizations([]); setActiveOrganization(null); channel.current?.postMessage("changed"); }
    catch (e) { setError(errorMessage(e)); }
  };
  const signedIn = async () => { await refresh(); channel.current?.postMessage("changed"); setOpen(false); };
  return <AuthContext.Provider value={{ user, organizations, activeOrganization, loading, refresh, logout, openAuth: () => setOpen(true) }}>
    {loading ? <main className="auth-entry"><Loading label="正在验证登录状态…" /></main> : user ? children : <main className="auth-entry">
      <section className="auth-entry-card" aria-labelledby="auth-entry-title">
        <header className="auth-entry-heading"><HubLogo /><p className="eyebrow">42 AGENT HUB</p><h1 id="auth-entry-title">登录后，入座圆桌</h1><p>与你的组织和 Agent，一起交流。</p></header>
        <AuthForm onSuccess={signedIn} />
      </section>
    </main>}
    {error && <div className="account-sync-error" role="alert">{error}<button onClick={() => { void refresh().catch(() => {}); }}>重试</button></div>}
    {user && <Dialog open={open} onClose={() => setOpen(false)} title="你的 42 账号" description="42 Club 共享账号 · 和组织里的伙伴一起入座。">
      {open && <AuthForm onSuccess={signedIn} />}
    </Dialog>}
  </AuthContext.Provider>;
}

export function AccountMenu() {
  const { user, loading, openAuth, logout } = useAuth();
  const [busy, setBusy] = useState(false);
  if (loading) return <span className="account-loading" aria-label="正在读取账号"><LoaderCircle size={17} className="spin" /></span>;
  if (!user) return <button className="button secondary small" onClick={openAuth}><UserRound size={15} />登录 / 注册</button>;
  return <div className="account-menu"><OrganizationMenu /><Avatar name={user.profile.display_name} vendor="真人" size="small" /><span title={user.email}>{user.profile.display_name}</span><button className="icon-button" aria-label="退出登录" disabled={busy} onClick={async () => { setBusy(true); try { await logout(); } finally { setBusy(false); } }}><LogOut size={16} /></button></div>;
}

export function AuthForm({ onSuccess }: { onSuccess: () => Promise<void> }) {
  const [mode, setMode] = useState<AuthMode>("login");
  const [verificationEmail, setVerificationEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => { if (!cooldown) return; const timer = setTimeout(() => setCooldown((value) => value - 1), 1000); return () => clearTimeout(timer); }, [cooldown]);
  const switchMode = (value: AuthMode) => { setMode(value); setVerificationEmail(""); setError(null); setNotice(""); };
  async function sendCode() {
    const email = form.current?.elements.namedItem("email") as HTMLInputElement;
    if (!email?.reportValidity()) return;
    setBusy(true); setError(null);
    try {
      const result = await api<{ resendAvailableAt?: string }>(`/api/auth/${mode === "reset" ? "forgot-password" : "resend-verification"}`, { method: "POST", body: JSON.stringify({ email: email.value }) });
      setCooldown(Math.max(60, Math.ceil((new Date(result.resendAvailableAt ?? Date.now()).getTime() - Date.now()) / 1000)));
      setNotice("如果邮箱符合验证条件，验证码将发送至收件箱。");
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(null); setNotice("");
    const input = Object.fromEntries(new FormData(event.currentTarget));
    try {
      if (mode === "register" && !verificationEmail) {
        const result = await api<{ resendAvailableAt: string }>("/api/auth/register", { method: "POST", body: JSON.stringify(input) });
        setVerificationEmail(String(input.email));
        setCooldown(Math.max(0, Math.ceil((new Date(result.resendAvailableAt).getTime() - Date.now()) / 1000)));
        setNotice("验证码已发送，请验证邮箱完成注册。");
      } else {
        await api(`/api/auth/${mode === "reset" ? "reset-password" : verificationEmail ? "verify-email" : "login"}`, { method: "POST", body: JSON.stringify(mode === "reset" ? { email: input.email, code: input.code, newPassword: input.password } : input) });
        if (mode === "reset") { switchMode("login"); setNotice("密码已更新，请重新登录。"); }
        else await onSuccess();
      }
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  return <form ref={form} onSubmit={submit} className="auth-form"><div className="modal-body">
    <div className="auth-welcome"><span className="auth-flower"><UserRound size={26} strokeWidth={1.5} /></span><h3>{mode === "login" ? "欢迎回来，给你留了一个位置" : mode === "register" ? "从认识你开始" : "找回你的圆桌席位"}</h3><p>使用 42 Agent 或已有的 42 Meeting 账号登录。</p></div>
    <div className="auth-tabs" role="group" aria-label="账号操作"><button type="button" aria-pressed={mode === "login"} disabled={busy} onClick={() => switchMode("login")}>登录</button><button type="button" aria-pressed={mode === "register"} disabled={busy} onClick={() => switchMode("register")}>注册</button></div>
    <fieldset disabled={busy}>
      {mode === "register" && !verificationEmail && <label className="field">你的名字<input name="displayName" autoComplete="name" placeholder="圆桌上的称呼" maxLength={80} required /></label>}
      <label className="field">邮箱<input key={verificationEmail} name="email" type="email" autoComplete="email" defaultValue={verificationEmail} readOnly={Boolean(verificationEmail)} placeholder="you@example.com" maxLength={254} required /></label>
      {(mode === "reset" || verificationEmail) && <label className="field">邮箱验证码<div className="auth-code-row"><input name="code" autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} placeholder="6 位验证码" required /><button className="button secondary small" type="button" onClick={sendCode} disabled={cooldown > 0}>{cooldown ? `${cooldown} 秒后重发` : "获取验证码"}</button></div></label>}
      {!verificationEmail && <label className="field">{mode === "reset" ? "新密码" : "密码"}<input key={mode} name="password" type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} minLength={mode === "login" ? 1 : 8} maxLength={72} placeholder="至少 8 位密码" required /></label>}
    </fieldset>
    {mode === "register" && !verificationEmail && <button className="text-link" type="button" disabled={busy} onClick={() => { const email = form.current?.elements.namedItem("email") as HTMLInputElement; if (email?.reportValidity()) setVerificationEmail(email.value); }}>已经收到验证码？继续验证邮箱</button>}
    <ErrorNotice message={error} />{notice && <p className="auth-notice" role="status">{notice}</p>}
    <button className="button primary auth-submit" disabled={busy}>{busy ? <LoaderCircle size={17} className="spin" /> : <ArrowRight size={17} />}{mode === "login" ? "登录，回到圆桌" : mode === "register" ? verificationEmail ? "验证邮箱，完成注册" : "创建账号并发送验证码" : "更新密码"}</button>
    <div className="auth-footer"><span>一个账号，连接 42 的每一场相遇。</span><button type="button" className="text-link" disabled={busy} onClick={() => switchMode(mode === "reset" ? "login" : "reset")}>{mode === "reset" ? "返回登录" : "忘记密码？"}</button></div>
  </div></form>;
}
