import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import { AuthProvider } from "@/lib/auth/auth-provider";
import { SubscriptionProvider } from "@/lib/billing/subscription-provider";
import "./globals.css";

export const metadata: Metadata = {
  applicationName: "Infact Pulse",
  title: { default: "Infact Pulse", template: "%s · Infact Pulse" },
  description: "Operational attendance management for Hikvision-connected teams.",
  icons: {
    icon: [{ url: "/brand/infact-pulse-mark.png", type: "image/png" }],
    apple: "/brand/infact-pulse-mark.png",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#172421",
  viewportFit: "cover",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body><AuthProvider><SubscriptionProvider>{children}</SubscriptionProvider></AuthProvider></body>
    </html>
  );
}
