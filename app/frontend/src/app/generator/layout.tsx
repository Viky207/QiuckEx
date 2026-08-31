import { RouteErrorBoundary } from "@/components/RouteErrorBoundary";

interface GeneratorLayoutProps {
  children: React.ReactNode;
}

export default function GeneratorLayout({ children }: GeneratorLayoutProps) {
  return <RouteErrorBoundary section="generator">{children}</RouteErrorBoundary>;
}
