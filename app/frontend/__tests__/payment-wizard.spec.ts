import { expect, test, type Page } from "@playwright/test";

async function stubWizardServices(page: Page) {
  let metadataRequest: Record<string, unknown> | null = null;

  await page.route("**/stellar/verified-assets", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        assets: [
          { code: "USDC", type: "credit_alphanum4", issuer: `G${"A".repeat(55)}`, verified: true },
          { code: "XLM", type: "native", issuer: null, verified: true },
          { code: "AQUA", type: "credit_alphanum4", issuer: `G${"B".repeat(55)}`, verified: true },
        ],
      }),
    }),
  );
  await page.route(/\/order_book\?/, (route) => {
    const nativeAsset = route.request().url().includes("selling_asset_type=native");
    const ask = nativeAsset ? "0.23" : "0.98";
    const bid = nativeAsset ? "0.22" : "0.96";
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ asks: [{ price: ask }], bids: [{ price: bid }] }),
    });
  });
  await page.route("**/links/scan", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        isSafe: false,
        alerts: [{ message: "Reported phishing account." }],
      }),
    }),
  );
  await page.route("**/links/metadata", async (route) => {
    metadataRequest = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        data: { canonical: "amount=10&asset=XLM&username=test_user&privacy=true" },
      }),
    });
  });

  return () => metadataRequest;
}

async function completeWizard(page: Page) {
  const metadataRequest = await stubWizardServices(page);
  await page.goto("/dashboard");
  await page.getByRole("button", { name: "Create payment link" }).first().click();
  await expect(page.getByRole("heading", { name: "Choose an asset" })).toBeVisible();

  await page.getByLabel("Recipient username or Stellar address").fill("test_user");
  await page.getByRole("button", { name: "Continue" }).click();

  await page.getByLabel("Amount in XLM").fill("10");
  await expect(page.getByText("Approximately $2.25 USD")).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();

  await page.getByLabel("Memo (optional)").fill("Invoice 204");
  await expect(page.getByText(/This payment request has scam indicators.*Reported phishing account/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue" })).toBeDisabled();
  await page.getByLabel("I have reviewed the warning and want to continue.").check();
  await page.getByRole("button", { name: "Continue" }).click();

  await page.getByRole("switch", { name: "Enable X-Ray privacy" }).click();
  await page.getByRole("button", { name: "Generate preview" }).click();
  await expect(page.getByRole("button", { name: "Copy payment link" })).toBeVisible();
  await expect(page.locator(".max-w-xs svg")).toBeVisible();

  return metadataRequest;
}

test("payment wizard generates and copies a link", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const getMetadataRequest = await completeWizard(page);

  await page.getByRole("button", { name: "Copy payment link" }).click();
  await expect(page.getByText("Payment link copied.")).toBeVisible();
  expect(getMetadataRequest()).toMatchObject({
    amount: 10,
    asset: "XLM",
    username: "test_user",
    memo: "Invoice 204",
    privacy: true,
  });
});

test("payment wizard fits a 375px viewport and keeps values when navigating back", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await stubWizardServices(page);
  await page.goto("/dashboard");
  await page.getByRole("button", { name: "Create payment link" }).first().click();
  await page.getByLabel("Custom Stellar asset").selectOption("AQUA");
  await page.getByLabel("Recipient username or Stellar address").fill("test_user");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Amount in AQUA").fill("10");
  await expect(page.getByText("Approximately $9.70 USD")).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByLabel("Amount in AQUA")).toHaveValue("10");
  await expect(page.getByRole("heading", { name: "Set the amount" })).toBeFocused();
  await expect(page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).resolves.toBe(true);
});
