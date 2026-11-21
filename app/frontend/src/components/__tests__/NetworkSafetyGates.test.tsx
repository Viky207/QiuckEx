// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FeatureFlags } from "@/components/admin/FeatureFlags";
import { SigningSummary } from "@/components/SigningSummary";
import { WalletSigningFlow } from "@/components/wallet/WalletSigningFlow";

const walletMocks = vi.hoisted(() => ({
  connectWallet: vi.fn(),
  detectWallets: vi.fn(),
  fetchUnsignedXdr: vi.fn(),
  signXdr: vi.fn(),
  submitSignedXdr: vi.fn(),
}));

const adminMocks = vi.hoisted(() => ({
  getQuickexApiBase: vi.fn(() => "http://localhost:4000"),
  useAdminAuth: vi.fn(),
}));

vi.mock("@/lib/wallet/detectWallets", () => ({
  detectWallets: walletMocks.detectWallets,
}));

vi.mock("@/lib/wallet/walletSigning", () => ({
  WalletUserDeniedError: class WalletUserDeniedError extends Error {},
  connectWallet: walletMocks.connectWallet,
  fetchUnsignedXdr: walletMocks.fetchUnsignedXdr,
  signXdr: walletMocks.signXdr,
  submitSignedXdr: walletMocks.submitSignedXdr,
}));

vi.mock("@/lib/api", () => ({
  getQuickexApiBase: adminMocks.getQuickexApiBase,
}));

vi.mock("@/hooks/useAdminAuth", () => ({
  useAdminAuth: adminMocks.useAdminAuth,
}));

describe("WalletSigningFlow disabled states", () => {
  beforeEach(() => {
    walletMocks.connectWallet.mockReset();
    walletMocks.detectWallets.mockReset();
    walletMocks.fetchUnsignedXdr.mockReset().mockResolvedValue("unsigned-xdr");
    walletMocks.signXdr.mockReset().mockResolvedValue("signed-xdr");
    walletMocks.submitSignedXdr.mockReset().mockResolvedValue({ hash: "abc123" });
  });

  it("does not start a signing flow from an unavailable wallet", () => {
    walletMocks.detectWallets.mockReturnValue([
      { id: "freighter", name: "Freighter", available: false },
    ]);

    render(<WalletSigningFlow />);
    const blockedButton = screen.getByRole("button", {
      name: "Freighter (not detected in browser)",
    });

    expect(blockedButton).toBeDisabled();
    fireEvent.click(blockedButton);
    expect(walletMocks.connectWallet).not.toHaveBeenCalled();
  });

  it("keeps wallet actions blocked while a signing attempt is in progress", async () => {
    walletMocks.connectWallet.mockReturnValue(new Promise<string>(() => {}));
    walletMocks.detectWallets.mockReturnValue([
      { id: "freighter", name: "Freighter", available: true },
    ]);

    render(<WalletSigningFlow />);
    const walletButton = screen.getByRole("button", {
      name: "Connect and sign with Freighter",
    });

    await act(async () => {
      fireEvent.click(walletButton);
    });

    expect(walletMocks.connectWallet).toHaveBeenCalledTimes(1);
    expect(walletButton).toBeDisabled();

    fireEvent.click(walletButton);
    expect(walletMocks.connectWallet).toHaveBeenCalledTimes(1);
  });
});

describe("SigningSummary network mismatch gate", () => {
  const defaultProps = {
    action: "purchase" as const,
    amount: { value: 12.5, asset: "USDC" },
    details: [{ label: "Recipient", value: "@merchant" }],
  };

  it("withholds the ready-to-sign confirmation when networks do not match", () => {
    render(
      <SigningSummary
        {...defaultProps}
        network="Stellar Mainnet"
        targetNetwork="Stellar Testnet"
      />,
    );

    expect(screen.getByText(/Your wallet is on Stellar Mainnet/)).toBeInTheDocument();
    expect(
      screen.queryByText(/Verify the details above match your intention/),
    ).not.toBeInTheDocument();
  });

  it("allows the confirmation only when wallet and target networks match", () => {
    render(<SigningSummary {...defaultProps} />);

    expect(screen.queryByText(/Your wallet is on/)).not.toBeInTheDocument();
    expect(
      screen.getByText(/Verify the details above match your intention/),
    ).toBeInTheDocument();
  });
});

describe("FeatureFlags loading and error safety state", () => {
  beforeEach(() => {
    adminMocks.getQuickexApiBase.mockReturnValue("http://localhost:4000");
    adminMocks.useAdminAuth.mockReturnValue({
      apiKey: null,
      isPrompting: false,
      setIsPrompting: vi.fn(),
      saveApiKey: vi.fn(),
      clearApiKey: vi.fn(),
      getHeaders: vi.fn(() => ({ "Content-Type": "application/json" })),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders no flag toggles while flags are still loading", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));

    render(<FeatureFlags />);

    expect(screen.getByText("Loading feature flags...")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("renders no flag toggles when the flag fetch fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("flag store unavailable")),
    );

    render(<FeatureFlags />);

    expect(await screen.findByText("flag store unavailable")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });
});
