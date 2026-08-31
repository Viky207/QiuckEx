import { RouteErrorBoundary } from "@/components/RouteErrorBoundary";

interface DashboardLayoutProps {
  children: React.ReactNode;
}

export default function DashboardLayout({ children }: DashboardLayoutProps) {
  return <RouteErrorBoundary section="dashboard">{children}</RouteErrorBoundary>;
}
