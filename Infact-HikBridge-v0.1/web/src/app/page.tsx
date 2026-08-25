import {
  ArrowRight,
  CheckCircle2,
  Cloud,
  Fingerprint,
  MapPin,
  ShieldCheck,
  Wifi,
} from "lucide-react";
import Link from "next/link";

import { BrandLogo } from "@/components/brand-logo";
import { MarketingHeader } from "@/components/marketing-header";
import { PlanSelector } from "@/components/plan-selector";

export default function HomePage() {
  return (
    <main className="marketing-page pulse-marketing-page">
      <section className="pulse-hero">
        <MarketingHeader />
        <div className="pulse-hero-media" aria-hidden="true" />
        <div className="pulse-hero-scrim" aria-hidden="true" />

        <div className="pulse-hero-copy">
          <p className="pulse-overline">Hikvision-connected workforce operations</p>
          <h1><span>Pulse.</span> Attendance that keeps up with your workplace.</h1>
          <p>Bring every clock-in, shift, exception, and report into one clear workspace—without opening your office network to the internet.</p>
          <div className="pulse-hero-actions">
            <Link href="/signup?plan=silver&cycle=annual">Start free for 14 days <ArrowRight size={17} /></Link>
            <Link href="/#workflow">See how it connects</Link>
          </div>
          <div className="pulse-hero-proof" aria-label="Product assurances">
            <span><ShieldCheck size={15} /> No inbound router ports</span>
            <span><CheckCircle2 size={15} /> Keep your existing terminal</span>
            <span><CheckCircle2 size={15} /> Pay in LKR</span>
          </div>
        </div>

        <div className="pulse-signal-strip" aria-label="Attendance data path">
          <div><Fingerprint size={17} /><span><small>01</small> Terminal</span></div>
          <i aria-hidden="true"><b /></i>
          <div><ShieldCheck size={17} /><span><small>02</small> HikBridge</span></div>
          <i aria-hidden="true"><b /></i>
          <div><Cloud size={17} /><span><small>03</small> Pulse cloud</span></div>
          <p><span /> Live sync path</p>
        </div>
      </section>

      <section className="pulse-manifesto" id="how-it-works">
        <div className="pulse-section-number">01 / 04</div>
        <div>
          <p className="pulse-section-label">A clearer operating rhythm</p>
          <h2>Your terminal clocks the moment. Pulse runs the operation.</h2>
        </div>
        <p>HikBridge sits beside the Hikvision terminal on your local network. It securely carries punches to Pulse, where HR and managers can resolve attendance, manage shifts, and prepare reports from any browser.</p>
      </section>

      <section className="pulse-workflow" id="workflow" aria-labelledby="workflow-title">
        <header>
          <p className="pulse-section-label">From fingerprint to decision</p>
          <h2 id="workflow-title">One secure route.<br />No network gymnastics.</h2>
          <p>Nothing needs to reach into your office. HikBridge sends signed attendance data out, retries safely, and keeps the flow moving.</p>
        </header>
        <div className="pulse-workflow-line">
          <article>
            <div><span>01</span><Fingerprint size={25} /></div>
            <h3>Clock in as usual</h3>
            <p>Employees use the Hikvision device already installed at your workplace.</p>
            <small><MapPin size={13} /> Your office LAN</small>
          </article>
          <div className="pulse-route" aria-hidden="true"><span /><Wifi size={17} /></div>
          <article>
            <div><span>02</span><ShieldCheck size={25} /></div>
            <h3>HikBridge carries it</h3>
            <p>The local agent queues, signs, retries, and synchronizes events safely.</p>
            <small><CheckCircle2 size={13} /> Outbound only</small>
          </article>
          <div className="pulse-route" aria-hidden="true"><span /><Cloud size={17} /></div>
          <article>
            <div><span>03</span><Cloud size={25} /></div>
            <h3>Pulse makes it useful</h3>
            <p>Authorized teams work with shifts, exceptions, employees, and reports online.</p>
            <small><ShieldCheck size={13} /> Role-controlled</small>
          </article>
        </div>
      </section>

      <section className="pulse-scope">
        <div className="pulse-scope-heading">
          <p className="pulse-section-label">Built around the real boundary</p>
          <h2>Cloud where it helps.<br />Local where it matters.</h2>
          <p>Pulse makes the digital operation portable while staying honest about the physical work that still happens at the terminal.</p>
        </div>
        <div className="pulse-scope-list">
          <article><span>01</span><strong>Work from any browser</strong><p>Dashboards, attendance, corrections, employees, reports, billing, and device health.</p></article>
          <article><span>02</span><strong>Coordinate through HikBridge</strong><p>User sync, queued enrollment commands, and supported device configuration.</p></article>
          <article><span>03</span><strong>Keep physical tasks on-site</strong><p>Sensor contact, wiring, power, initial networking, and unsupported terminal menus.</p></article>
        </div>
      </section>

      <section className="marketing-pricing-preview" id="packages">
        <div className="marketing-section-heading">
          <div>
            <p>Simple, capacity-based pricing</p>
            <span className="pulse-section-number">02 / 04</span>
          </div>
          <h2>Every feature.<br />Choose your scale.</h2>
        </div>
        <PlanSelector compact />
      </section>

      <section className="marketing-final-cta">
        <div className="pulse-final-orbit" aria-hidden="true"><span /><span /><span /></div>
        <p>Ready for the next shift</p>
        <h2>Make every clock-in<br />part of the bigger picture.</h2>
        <Link href="/signup?plan=silver&cycle=annual">Create your workspace <ArrowRight size={17} /></Link>
        <small>14 days free · No charge today</small>
      </section>

      <footer className="marketing-footer">
        <BrandLogo />
        <span>Hikvision-connected workforce operations</span>
        <div><Link href="/pricing">Packages</Link><Link href="/login">Sign in</Link></div>
      </footer>
    </main>
  );
}
