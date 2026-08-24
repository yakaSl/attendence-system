import { ArrowUpRight } from "lucide-react";
import Link from "next/link";

import { BrandLogo } from "@/components/brand-logo";

export function MarketingHeader() {
  return (
    <header className="marketing-header">
      <Link href="/" className="marketing-brand" aria-label="Infact Pulse home">
        <BrandLogo priority />
      </Link>
      <nav aria-label="Public navigation">
        <Link href="/#how-it-works">How it works</Link>
        <Link href="/pricing">Packages</Link>
        <Link href="/login">Sign in</Link>
        <Link className="marketing-nav-cta" href="/signup?plan=silver&cycle=monthly">Start free <ArrowUpRight size={14} /></Link>
      </nav>
    </header>
  );
}
