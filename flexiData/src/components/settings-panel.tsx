"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Bell,
  Check,
  Copy,
  KeyRound,
  MonitorSmartphone,
  ShieldCheck,
  User,
  type LucideIcon,
} from "lucide-react";
import { cn, groupPhone } from "@/lib/format";

type UserInfo = {
  name: string;
  email: string;
  phone: string;
  referralCode: string;
  notifyPromos: boolean;
  notifyTx: boolean;
};

type SessionRow = {
  id: number;
  device: string;
  ip: string | null;
  lastSeen: string;
  current: boolean;
};

function Section({
  icon: Icon,
  title,
  subtitle,
  children,
}: {
  icon: LucideIcon;
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-[1.75rem] border border-black/[0.05] bg-paper shadow-sm dark:border-line dark:bg-card">
      <header className="flex items-center gap-3 border-b border-black/[0.05] px-4 py-3.5 dark:border-line">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand/15 text-brand-deep dark:text-brand">
          <Icon className="h-[17px] w-[17px]" />
        </span>
        <div>
          <h2 className="text-[13px] font-bold">{title}</h2>
          <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{subtitle}</p>
        </div>
      </header>
      <div className="space-y-3.5 p-4">{children}</div>
    </section>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
  autoComplete,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  autoComplete?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-bold text-zinc-500 dark:text-zinc-400">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
        className="w-full rounded-xl border border-black/10 bg-white px-3.5 py-2.5 text-[13px] font-semibold outline-none transition focus:border-brand focus:ring-2 focus:ring-brand/30 dark:border-line dark:bg-night"
      />
    </label>
  );
}

function SaveButton({
  saving,
  saved,
  error,
  onClick,
  label = "Save changes",
}: {
  saving: boolean;
  saved: boolean;
  error: string | null;
  onClick: () => void;
  label?: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <button
        onClick={onClick}
        disabled={saving}
        className="rounded-xl bg-brand px-4 py-2.5 text-[12px] font-black text-ink shadow-[0_6px_16px_rgba(255,203,5,0.3)] transition active:scale-95 disabled:opacity-60"
      >
        {saving ? "Saving…" : saved ? <span className="flex items-center gap-1.5"><Check className="h-3.5 w-3.5" /> Saved</span> : label}
      </button>
      {error && <p className="text-[11px] font-bold text-rose-500">{error}</p>}
    </div>
  );
}

function Toggle({
  label,
  sub,
  checked,
  onChange,
}: {
  label: string;
  sub: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={() => onChange(!checked)}
        className={cn(
          "relative h-6 w-11 shrink-0 rounded-full transition-colors",
          checked ? "bg-brand" : "bg-black/15 dark:bg-white/15",
        )}
        aria-pressed={checked}
      >
        <span
          className={cn(
            "absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all",
            checked ? "left-[22px]" : "left-0.5",
          )}
        />
      </button>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-bold">{label}</p>
        <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{sub}</p>
      </div>
    </div>
  );
}

export function SettingsPanel({ user }: { user: UserInfo }) {
  const router = useRouter();

  const [name, setName] = useState(user.name);
  const [email, setEmail] = useState(user.email);
  const [phone, setPhone] = useState(user.phone);
  const [profileState, setProfileState] = useState<{ saving: boolean; saved: boolean; error: string | null }>({
    saving: false,
    saved: false,
    error: null,
  });

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [pwState, setPwState] = useState<{ saving: boolean; saved: boolean; error: string | null }>({
    saving: false,
    saved: false,
    error: null,
  });

  const [promos, setPromos] = useState(user.notifyPromos);
  const [txNotif, setTxNotif] = useState(user.notifyTx);
  const [notifSaved, setNotifSaved] = useState(false);

  const [copied, setCopied] = useState(false);

  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [sessionsError, setSessionsError] = useState<string | null>(null);

  const saveProfile = async () => {
    setProfileState({ saving: true, saved: false, error: null });
    try {
      const res = await fetch("/api/account/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, phone }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Could not save");
      setProfileState({ saving: false, saved: true, error: null });
      router.refresh();
    } catch (e) {
      setProfileState({ saving: false, saved: false, error: e instanceof Error ? e.message : "Failed" });
    }
  };

  const changePassword = async () => {
    setPwState({ saving: true, saved: false, error: null });
    try {
      const res = await fetch("/api/account/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Could not change password");
      setPwState({ saving: false, saved: true, error: null });
      setCurrentPassword("");
      setNewPassword("");
    } catch (e) {
      setPwState({ saving: false, saved: false, error: e instanceof Error ? e.message : "Failed" });
    }
  };

  const updateNotif = async (key: "promos" | "tx", value: boolean) => {
    const nextPromos = key === "promos" ? value : promos;
    const nextTx = key === "tx" ? value : txNotif;
    setPromos(nextPromos);
    setTxNotif(nextTx);
    setNotifSaved(false);
    try {
      await fetch("/api/account/notifications", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          promos: nextPromos,
          transactions: nextTx,
        }),
      });
      setNotifSaved(true);
    } catch {
      // keep local state; will resync on refresh
    }
  };

  const copyReferral = async () => {
    await navigator.clipboard.writeText(user.referralCode).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const loadSessions = async () => {
    setSessionsError(null);
    try {
      const res = await fetch("/api/account/sessions");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed");
      setSessions(data.sessions as SessionRow[]);
    } catch (e) {
      setSessionsError(e instanceof Error ? e.message : "Failed");
    }
  };

  const logoutOthers = async () => {
    await fetch("/api/account/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "logout_others" }),
    });
    await loadSessions();
  };

  const logoutSession = async (id: number) => {
    await fetch("/api/account/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "logout_session", sessionId: id }),
    });
    setSessions((prev) => prev?.filter((s) => s.id !== id) ?? prev);
  };

  return (
    <div className="space-y-5">
      <Section icon={User} title="Profile" subtitle="Your name, email & registered number">
        <Field label="Full name" value={name} onChange={setName} placeholder="Kwame Boateng" autoComplete="name" />
        <Field label="Email address" value={email} onChange={setEmail} type="email" placeholder="you@example.com" autoComplete="email" />
        <Field label="Phone number" value={phone} onChange={(v) => setPhone(groupPhone(v))} type="tel" placeholder="024 123 4567" autoComplete="tel" />
        <SaveButton saving={profileState.saving} saved={profileState.saved} error={profileState.error} onClick={saveProfile} />
      </Section>

      <Section icon={ShieldCheck} title="Referral code" subtitle="Share it — you earn 150 pts when friends buy">
        <button
          onClick={copyReferral}
          className="flex w-full items-center justify-between rounded-xl border border-dashed border-brand/50 bg-brand/[0.06] px-4 py-3 text-left"
        >
          <span className="font-mono text-[15px] font-black tracking-widest text-brand-deep dark:text-brand">
            {user.referralCode}
          </span>
          <span className="flex items-center gap-1.5 text-[11px] font-black text-brand-deep dark:text-brand">
            {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            {copied ? "Copied" : "Copy"}
          </span>
        </button>
      </Section>

      <Section icon={KeyRound} title="Security" subtitle="Change your password">
        <Field
          label="Current password"
          value={currentPassword}
          onChange={setCurrentPassword}
          type="password"
          placeholder="••••••••"
          autoComplete="current-password"
        />
        <Field
          label="New password"
          value={newPassword}
          onChange={setNewPassword}
          type="password"
          placeholder="At least 8 characters, letters & numbers"
          autoComplete="new-password"
        />
        <SaveButton saving={pwState.saving} saved={pwState.saved} error={pwState.error} onClick={changePassword} label="Update password" />
      </Section>

      <Section icon={Bell} title="Notifications" subtitle="Choose what FlexiData emails you about">
        <Toggle
          label="Price drops & promos"
          sub="Flash bundle discounts and agent rates"
          checked={promos}
          onChange={(v) => updateNotif("promos", v)}
        />
        <Toggle
          label="Transaction receipts"
          sub="Purchases, deposits and transfers"
          checked={txNotif}
          onChange={(v) => updateNotif("tx", v)}
        />
        {notifSaved && <p className="text-[11px] font-bold text-emerald-500">Preferences updated</p>}
      </Section>

      <Section icon={MonitorSmartphone} title="Active devices" subtitle="Sessions signed in to your account">
        {sessions === null ? (
          <button
            onClick={loadSessions}
            className="rounded-xl border border-black/10 px-4 py-2.5 text-[12px] font-black dark:border-line"
          >
            View active sessions
          </button>
        ) : (
          <>
            <ul className="space-y-2">
              {sessions.map((s) => (
                <li
                  key={s.id}
                  className="flex items-center gap-3 rounded-xl bg-black/[0.03] px-3 py-2.5 dark:bg-white/[0.04]"
                >
                  <MonitorSmartphone className="h-4 w-4 shrink-0 text-zinc-400" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[12px] font-bold">
                      {s.device}
                      {s.current && (
                        <span className="ml-2 rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[9px] font-black text-emerald-600 dark:text-emerald-400">
                          THIS DEVICE
                        </span>
                      )}
                    </p>
                    <p className="text-[10px] text-zinc-500">
                      {s.ip ? `${s.ip} • ` : ""}Last seen {new Date(s.lastSeen).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}
                    </p>
                  </div>
                  {!s.current && (
                    <button
                      onClick={() => logoutSession(s.id)}
                      className="text-[10px] font-black text-rose-500"
                    >
                      Revoke
                    </button>
                  )}
                </li>
              ))}
            </ul>
            {sessions.filter((s) => !s.current).length > 0 && (
              <button
                onClick={logoutOthers}
                className="rounded-xl border border-rose-500/30 px-4 py-2 text-[12px] font-black text-rose-500"
              >
                Log out all other devices
              </button>
            )}
          </>
        )}
        {sessionsError && <p className="text-[11px] font-bold text-rose-500">{sessionsError}</p>}
      </Section>
    </div>
  );
}
