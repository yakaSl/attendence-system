"use client";

import {
  CalendarClock,
  Clock3,
  CreditCard,
  FileSpreadsheet,
  Fingerprint,
  Gauge,
  Menu,
  Settings,
  ShieldCheck,
  Users,
  X,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";

import { BrandLogo } from "@/components/brand-logo";
import { useAuth } from "@/lib/auth/auth-provider";
import { useData } from "@/lib/data/data-provider";
import { cn, initials } from "@/lib/format";

const navigation = [
  { href: "/dashboard", label: "Overview", icon: Gauge },
  { href: "/employees", label: "Employees", icon: Users },
  { href: "/attendance", label: "Attendance", icon: Clock3 },
  { href: "/shifts", label: "Shifts", icon: CalendarClock },
  { href: "/devices", label: "Devices", icon: Fingerprint },
  { href: "/reports", label: "Reports", icon: FileSpreadsheet },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { user, logout, demo } = useAuth();
  const { organization } = useData();
  const [open, setOpen] = useState(false);
  const currentPage = navigation.find(({ href }) => pathname === href || (href !== "/dashboard" && pathname.startsWith(`${href}/`)))?.label ?? "Workspace";

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  async function signOut() {
    setOpen(false);
    await logout();
    router.push("/login");
  }

  if (user === null) return null;
  const accountNavigation = [
    ...(user.role === "organizationOwner" ? [{ href: "/billing", label: "Billing", icon: CreditCard }] : []),
    ...(user.role === "platformAdmin" ? [{ href: "/platform", label: "Platform", icon: ShieldCheck }] : []),
  ];

  return (
    <div className="app-frame">
      <aside id="primary-navigation" className={cn("sidebar", open && "sidebar-open")}>
        <div className="brand-row">
          <Link href="/dashboard" className="brand" onClick={() => setOpen(false)}>
            <BrandLogo priority />
          </Link>
          <button className="icon-button sidebar-close" onClick={() => setOpen(false)} aria-label="Close navigation"><X size={18} /></button>
        </div>
        <nav className="sidebar-nav" aria-label="Primary navigation">
          <p>Workspace</p>
          {navigation.map(({ href, label, icon: Icon }) => {
            const active = pathname === href || (href !== "/dashboard" && pathname.startsWith(`${href}/`));
            return (
              <Link key={href} href={href} className={cn("nav-link", active && "nav-link-active")} onClick={() => setOpen(false)}>
                <Icon size={17} strokeWidth={1.8} aria-hidden />
                <span>{label}</span>
              </Link>
            );
          })}
          {accountNavigation.map(({ href, label, icon: Icon }) => {
            const active = pathname === href || pathname.startsWith(`${href}/`);
            return (
              <Link key={href} href={href} className={cn("nav-link", active && "nav-link-active")} onClick={() => setOpen(false)}>
                <Icon size={17} strokeWidth={1.8} aria-hidden />
                <span>{label}</span>
              </Link>
            );
          })}
        </nav>
        <div className="sidebar-foot">
          <div className="sidebar-account">
            <span className="avatar">{initials(user.displayName)}</span>
            <span><strong>{user.displayName}</strong><small>{user.role.replace(/([A-Z])/g, " $1")}</small></span>
            <button type="button" onClick={() => void signOut()}>Sign out</button>
          </div>
          <div className="cloud-state"><span className="live-dot" />Cloud synchronized</div>
          <p>{demo ? "Demo workspace · no writes persist" : "Live Firebase workspace"}</p>
        </div>
      </aside>
      {open ? <button className="sidebar-scrim" onClick={() => setOpen(false)} aria-label="Close navigation" /> : null}
      <div className="app-body">
        <header className="topbar">
          <button className="icon-button menu-button" onClick={() => setOpen(true)} aria-label="Open navigation" aria-controls="primary-navigation" aria-expanded={open}><Menu size={19} /></button>
          <div className="organization-label">
            <span>{organization?.name ?? "Loading organization"}</span>
            <small className="organization-timezone">{organization?.timezone ?? ""}</small>
            <small className="organization-page">{currentPage}</small>
          </div>
          <div className="topbar-user">
            {demo ? <span className="demo-pill">Demo data</span> : null}
            <span className="avatar">{initials(user.displayName)}</span>
            <span className="user-copy"><strong>{user.displayName}</strong><small>{user.role.replace(/([A-Z])/g, " $1")}</small></span>
            <button className="quiet-action" onClick={() => void signOut()}>Sign out</button>
          </div>
        </header>
        <main className="page-content">{children}</main>
      </div>
    </div>
  );
}
