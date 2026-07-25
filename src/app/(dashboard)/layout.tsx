import { SessionProvider } from "@/components/dashboard/admin-context";
import { AppShell } from "@/components/dashboard/app-shell";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ConfirmProvider } from "@/components/ui/confirm-provider";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <TooltipProvider>
        <ConfirmProvider>
          <AppShell>{children}</AppShell>
        </ConfirmProvider>
      </TooltipProvider>
    </SessionProvider>
  );
}
