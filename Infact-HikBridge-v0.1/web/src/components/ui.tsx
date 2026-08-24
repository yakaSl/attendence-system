"use client";

import { AlertCircle, ArrowUpRight, CheckCircle2, LoaderCircle, X, type LucideIcon } from "lucide-react";
import Link from "next/link";
import type { ButtonHTMLAttributes, ReactNode } from "react";

import { cn } from "@/lib/format";

export function PageHeader({ eyebrow, title, description, actions }: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
        <h1>{title}</h1>
        {description ? <p className="page-description">{description}</p> : null}
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </header>
  );
}

export function Button({ className, variant = "primary", children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger" | "quiet";
}) {
  return <button className={cn("button", `button-${variant}`, className)} {...props}>{children}</button>;
}

export function TextLink({ href, children }: { href: string; children: ReactNode }) {
  return <Link className="text-link" href={href}>{children}<ArrowUpRight size={14} aria-hidden /></Link>;
}

export function Panel({ title, description, action, children, className }: {
  title?: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("panel", className)}>
      {title || action ? (
        <div className="panel-header">
          <div>
            {title ? <h2>{title}</h2> : null}
            {description ? <p>{description}</p> : null}
          </div>
          {action}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function Metric({ label, value, note, tone = "neutral", icon: Icon }: {
  label: string;
  value: string | number;
  note?: string;
  tone?: "neutral" | "positive" | "warning" | "danger";
  icon?: LucideIcon;
}) {
  return (
    <div className={cn("metric", `metric-${tone}`)}>
      <div className="metric-label">{Icon ? <Icon size={15} aria-hidden /> : null}<span>{label}</span></div>
      <strong>{value}</strong>
      {note ? <small>{note}</small> : null}
    </div>
  );
}

const statusLabels: Record<string, string> = {
  present: "Present",
  absent: "Absent",
  leave: "On leave",
  holiday: "Holiday",
  rest_day: "Rest day",
  no_shift: "No shift",
  checked_in: "Checked in",
  unscheduled_punch: "Unscheduled punch",
  missing_punch: "Missing punch",
  online: "Online",
  offline: "Offline",
  disabled: "Disabled",
  inactive: "Inactive",
  unknown: "Unknown",
};

export function StatusBadge({ status }: { status: string | null }) {
  const value = status ?? "unknown";
  return <span className={cn("status-badge", `status-${value}`)}>{statusLabels[value] ?? value.replaceAll("_", " ")}</span>;
}

export function LoadingState({ label = "Loading workspace" }: { label?: string }) {
  return <div className="state-message"><LoaderCircle className="spin" size={20} /><span>{label}</span></div>;
}

export function EmptyState({ title, message, action }: { title: string; message: string; action?: ReactNode }) {
  return (
    <div className="empty-state">
      <CheckCircle2 size={24} aria-hidden />
      <strong>{title}</strong>
      <p>{message}</p>
      {action}
    </div>
  );
}

export function ErrorState({ message }: { message: string }) {
  return <div className="error-state" role="alert"><AlertCircle size={18} /><span>{message}</span></div>;
}

export function Modal({ open, title, description, children, onClose }: {
  open: boolean;
  title: string;
  description?: string;
  children: ReactNode;
  onClose(): void;
}) {
  if (!open) return null;
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.currentTarget === event.target) onClose();
    }}>
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <div className="modal-heading">
          <div><h2 id="modal-title">{title}</h2>{description ? <p>{description}</p> : null}</div>
          <button className="icon-button" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>
        {children}
      </section>
    </div>
  );
}

export function RoleGate({ role, allowed, children }: { role: string; allowed: string[]; children: ReactNode }) {
  return allowed.includes(role) || role === "platformAdmin" ? children : null;
}
