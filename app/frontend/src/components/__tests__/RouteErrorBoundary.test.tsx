import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { RouteErrorBoundary } from "@/components/RouteErrorBoundary";

vi.mock("@/lib/sentry", () => ({
  captureException: vi.fn(),
}));

function Bomb({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) throw new Error("boom");
  return <div>ok</div>;
}

describe("RouteErrorBoundary", () => {
  it("renders fallback UI and reports to Sentry when a child throws", async () => {
    const { captureException } = await import("@/lib/sentry");
    render(
      <RouteErrorBoundary section="dashboard">
        <Bomb shouldThrow />
      </RouteErrorBoundary>
    );

    expect(screen.getByText(/something went wrong/i)).toBeTruthy();
    expect(captureException).toHaveBeenCalled();
  });

  it("recovers when retry is clicked", () => {
    let shouldThrow = true;
    const { rerender } = render(
      <RouteErrorBoundary section="dashboard">
        {shouldThrow ? <Bomb shouldThrow /> : <div>recovered</div>}
      </RouteErrorBoundary>
    );

    expect(screen.getByText(/something went wrong/i)).toBeTruthy();

    shouldThrow = false;
    fireEvent.click(screen.getByText(/retry/i));
    rerender(
      <RouteErrorBoundary section="dashboard">
        {shouldThrow ? <Bomb shouldThrow /> : <div>recovered</div>}
      </RouteErrorBoundary>
    );

    expect(screen.getByText("recovered")).toBeTruthy();
  });
});
