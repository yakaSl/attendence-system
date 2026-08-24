import type { ReactNode } from "react";

import { AppShell } from "@/components/app-shell";
import { ProtectedApp } from "@/components/protected-app";
import { DataProvider } from "@/lib/data/data-provider";

export default function WorkspaceLayout({ children }: { children: ReactNode }) {
  return (
    <ProtectedApp>
      <DataProvider><AppShell>{children}</AppShell></DataProvider>
    </ProtectedApp>
  );
}
