import { ArrowRight, CheckCircle2, Cloud, Fingerprint, MapPin, ShieldCheck, Wifi } from "lucide-react";
import Link from "next/link";

import { BrandLogo } from "@/components/brand-logo";
import { MarketingHeader } from "@/components/marketing-header";
import { PlanSelector } from "@/components/plan-selector";

export default function HomePage() {
  return (
    <main className="marketing-page">
      <section className="marketing-hero">
        <MarketingHeader />
        <div className="marketing-hero-shade" />
        <div className="marketing-hero-copy">
          <p className="marketing-kicker"><span /> Built for Sri Lankan workplaces</p>
          <h1>Your Hikvision terminal already knows who arrived. Now your whole team can.</h1>
          <p>HikBridge securely carries attendance from the device on your LAN to a controlled cloud workspace for HR, managers, and payroll.</p>
          <div className="marketing-hero-actions">
            <Link href="/signup?plan=silver&cycle=annual">Start 14 days free <ArrowRight size={16} /></Link>
            <Link href="/#how-it-works">See the bridge workflow</Link>
          </div>
          <div className="marketing-hero-proof">
            <span><ShieldCheck size={15} />No inbound router ports</span>
            <span><CheckCircle2 size={15} />LKR monthly or annual billing</span>
          </div>
        </div>
        <div className="marketing-hero-index"><span>01</span><small>Device to decisions</small></div>
      </section>

      <section className="marketing-intro" id="how-it-works">
        <div className="marketing-section-heading">
          <p>One small bridge. A much wider view.</p>
          <h2>Keep the device local.<br />Make attendance useful everywhere.</h2>
        </div>
        <p className="marketing-section-lede">HikBridge runs beside your Hikvision terminal on the same network. It collects punches, signs each batch, and sends them outbound to Firebase. Authorized users can then work from any internet-connected browser.</p>
      </section>

      <section className="bridge-flow" aria-label="HikBridge workflow">
        <article><span>01</span><Fingerprint size={24} /><h3>Terminal records</h3><p>Employees clock in on the existing Hikvision attendance device.</p><small><MapPin size={13} />Your office LAN</small></article>
        <div className="bridge-connector"><span /><Wifi size={18} /><span /></div>
        <article><span>02</span><ShieldCheck size={24} /><h3>HikBridge protects</h3><p>The local agent queues, signs, retries, and synchronizes events safely.</p><small><CheckCircle2 size={13} />Outbound connection</small></article>
        <div className="bridge-connector"><span /><Cloud size={18} /><span /></div>
        <article><span>03</span><Cloud size={24} /><h3>Cloud organizes</h3><p>HR reviews exceptions, devices, shifts, employees, and reports online.</p><small><ShieldCheck size={13} />Role-controlled access</small></article>
      </section>

      <section className="marketing-answer">
        <div><p className="marketing-kicker">What works remotely</p><h2>Cloud operations travel. Physical device actions do not.</h2></div>
        <div className="marketing-answer-grid">
          <p><strong>From any browser</strong><span>Dashboards, attendance, reports, corrections, employee records, subscriptions, and device health.</span></p>
          <p><strong>Through HikBridge</strong><span>User sync, queued enrollment commands, and supported device configuration actions.</span></p>
          <p><strong>Still on-site</strong><span>Touching the sensor, wiring, power, initial network setup, and unsupported terminal menus.</span></p>
        </div>
      </section>

      <section className="marketing-pricing-preview" id="packages">
        <div className="marketing-section-heading">
          <p>Packages that grow with the workplace</p>
          <h2>Every operational feature.<br />Limits you can plan around.</h2>
        </div>
        <PlanSelector compact />
      </section>

      <section className="marketing-final-cta">
        <p>Ready when your next shift starts.</p>
        <h2>Connect the terminal.<br />Open attendance to the people who need it.</h2>
        <Link href="/signup?plan=silver&cycle=annual">Create your workspace <ArrowRight size={16} /></Link>
      </section>

      <footer className="marketing-footer"><BrandLogo /><span>Hikvision-connected workforce operations</span><div><Link href="/pricing">Packages</Link><Link href="/login">Sign in</Link></div></footer>
    </main>
  );
}
