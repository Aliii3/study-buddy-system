import { test, expect } from "@playwright/test";

test.describe("smoke", () => {
  test("landing / auth shell renders", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: /find your people/i })).toBeVisible();
    await expect(page.getByRole("heading", { name: /study buddy/i })).toBeVisible();
  });
});
