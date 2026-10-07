"use client";
import { useEffect, useState, type FormEvent } from "react";
import { Building2, Plus, Users } from "lucide-react";
import { useAuth } from "./auth";
import { api, Dialog, ErrorNotice, errorMessage } from "./ui";

type Member = { id: string; userId?: string; displayName: string; email: string; role: string };
type Invitation = { id: string; organization?: { name: string } };
const roles: Record<string, string> = { owner: "所有者", admin: "管理员", member: "成员", viewer: "只读成员" };
export function OrganizationMenu() {
  const { organizations, activeOrganization, refresh } = useAuth();
  const [open, setOpen] = useState(false);
  const [members, setMembers] = useState<Member[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setMembers([]);
    Promise.all([activeOrganization ? api<Member[]>(`/api/organizations/${activeOrganization.id}/members`, { signal: controller.signal }) : Promise.resolve([]), api<Invitation[]>("/api/organizations/invitations", { signal: controller.signal })]).then(([m, i]) => { setMembers(m); setInvitations(i); }).catch((e) => { if (!controller.signal.aborted) setError(errorMessage(e)); });
    return () => controller.abort();
  }, [open, activeOrganization?.id]);
  async function mutate(path: string, body: unknown = {}) {
    setBusy(true); setError(null);
    try { await api(`/api/organizations${path}`, { method: "POST", body: JSON.stringify(body) }); await refresh(); setOpen(false); }
    catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  const create = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); void mutate("", Object.fromEntries(new FormData(event.currentTarget))); };
  const invite = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); void mutate(`/${activeOrganization!.id}/invitations`, Object.fromEntries(new FormData(event.currentTarget))); };
  return <>
    <button className="button quiet small organization-button" onClick={() => setOpen(true)}><Building2 size={15} />{activeOrganization?.name || "选择组织"}</button>
    <Dialog open={open} onClose={() => setOpen(false)} title="组织与成员" description="与 42 Agent 共享组织、成员和权限。">
      <div className="modal-body organization-body"><ErrorNotice message={error} />
        {organizations.length > 0 && <label className="field">当前组织<select aria-label="当前组织" value={activeOrganization?.id || ""} disabled={busy} onChange={(e) => mutate(`/${e.target.value}/switch`)}><option value="" disabled>选择组织</option>{organizations.map((org) => <option key={org.id} value={org.id}>{org.name} · {roles[org.role]}</option>)}</select></label>}
        {activeOrganization && <section><h3><Users size={16} /> {activeOrganization.name} 的成员</h3><ul className="organization-members">{members.map((member) => <li key={member.userId || member.id}><span><strong>{member.displayName}</strong><small>{member.email}</small></span><span>{roles[member.role] || member.role}</span></li>)}</ul></section>}
        {activeOrganization && ["owner", "admin"].includes(activeOrganization.role) && <form onSubmit={invite}><label className="field">邀请成员<input name="email" type="email" placeholder="对方的账号邮箱" required /></label><button className="button secondary small" disabled={busy}>发送组织邀请</button></form>}
        {invitations.map((invitation) => <div className="organization-invitation" key={invitation.id}><span>{invitation.organization?.name} 邀请你加入</span><button className="button secondary small" disabled={busy} onClick={() => mutate(`/invitations/${invitation.id}/accept`)}>接受邀请</button></div>)}
        <details open={!organizations.length}><summary>创建一个组织</summary><form className="create-organization" onSubmit={create}><label className="field">组织名称<input name="name" placeholder="比如：42 Club" maxLength={100} required /></label><label className="field">组织域名<input name="domain" placeholder="your-team.com" maxLength={253} required /></label><button className="button primary small" disabled={busy}><Plus size={15} />创建组织</button></form></details>
      </div>
    </Dialog>
  </>;
}
