"use client";

import { useState } from "react";
import { CheckCircle2, ContactRound, Search, X } from "lucide-react";
import { Sheet } from "@/components/sheet";
import { FieldLabel } from "@/components/ui";
import { CONTACTS } from "@/lib/constants";
import { cn, groupPhone, isValidPhone, phoneDigits } from "@/lib/format";

export function PhoneInput({
  value,
  onChange,
  label = "Recipient phone",
  placeholder = "024 412 3456",
}: {
  value: string;
  onChange: (digits: string) => void;
  label?: string;
  placeholder?: string;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [q, setQ] = useState("");

  const filtered = CONTACTS.filter(
    (c) => c.name.toLowerCase().includes(q.toLowerCase()) || c.phone.includes(q.replace(/\D/g, "")),
  );

  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <div
        className={cn(
          "flex items-center gap-2 rounded-2xl border bg-paper px-4 py-[13px] transition-all focus-within:border-brand focus-within:ring-2 focus-within:ring-brand/30 dark:bg-card",
          value && !isValidPhone(value)
            ? "border-rose-400/60"
            : "border-black/[0.08] dark:border-line",
        )}
      >
        <input
          inputMode="numeric"
          autoComplete="tel"
          value={groupPhone(value)}
          onChange={(e) => onChange(phoneDigits(e.target.value))}
          placeholder={placeholder}
          className="w-full min-w-0 flex-1 bg-transparent font-display text-[15px] font-bold tracking-wide outline-none placeholder:font-sans placeholder:font-semibold placeholder:text-zinc-400"
        />
        {isValidPhone(value) && <CheckCircle2 className="h-[18px] w-[18px] shrink-0 text-emerald-500" />}
        {value && !isValidPhone(value) && (
          <button
            aria-label="Clear"
            onClick={() => onChange("")}
            className="text-zinc-400 transition-colors hover:text-zinc-600"
          >
            <X className="h-4 w-4" />
          </button>
        )}
        <button
          type="button"
          aria-label="Pick from contacts"
          onClick={() => setPickerOpen(true)}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-brand/15 text-brand-deep transition-all hover:bg-brand/25 active:scale-90 dark:text-brand"
        >
          <ContactRound className="h-4 w-4" />
        </button>
      </div>

      <Sheet open={pickerOpen} onClose={() => setPickerOpen(false)} title="Select contact">
        <div className="relative mb-3">
          <Search className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search contacts"
            className="w-full rounded-2xl border border-black/[0.08] bg-black/[0.03] py-3 pl-10 pr-4 text-sm font-semibold outline-none transition-all focus:border-brand focus:ring-2 focus:ring-brand/30 dark:border-line dark:bg-white/[0.04]"
          />
        </div>
        <div className="max-h-[300px] overflow-y-auto">
          {filtered.map((c) => (
            <button
              key={c.phone}
              onClick={() => {
                onChange(c.phone);
                setPickerOpen(false);
                setQ("");
              }}
              className="flex w-full items-center gap-3 rounded-2xl px-2 py-2.5 text-left transition-colors hover:bg-black/[0.03] active:scale-[0.99] dark:hover:bg-white/[0.04]"
            >
              <AvatarInitials name={c.name} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-bold">{c.name}</span>
                <span className="block font-mono text-[11px] text-zinc-500">{groupPhone(c.phone)}</span>
              </span>
            </button>
          ))}
          {filtered.length === 0 && (
            <p className="py-6 text-center text-xs text-zinc-400">No contacts found</p>
          )}
        </div>
      </Sheet>
    </div>
  );
}

function AvatarInitials({ name }: { name: string }) {
  const initials = name
    .split(" ")
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  const hues = ["bg-amber-500/15 text-amber-600", "bg-sky-500/15 text-sky-600", "bg-violet-500/15 text-violet-600", "bg-emerald-500/15 text-emerald-600", "bg-rose-500/15 text-rose-600"];
  const i = name.length % hues.length;
  return (
    <span className={cn("flex h-9 w-9 items-center justify-center rounded-full text-[11px] font-black", hues[i])}>
      {initials}
    </span>
  );
}
