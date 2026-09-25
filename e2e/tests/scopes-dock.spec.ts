import { expect, test } from "@playwright/test";
import { openNewProject } from "./editor";

test("Color page scopes dock shows RGB parade and vectorscope", async ({
  page,
}) => {
  await openNewProject(page);
  await page.getByRole("button", { name: "Project thumbnail" }).click();
  await page.getByRole("menuitemcheckbox", { name: "Pages workspace" }).click();
  await page.keyboard.press("Escape");
  await page.getByRole("tab", { name: "Color" }).click();
  const dock = page.getByTestId("scopes-dock");
  await expect(dock).toBeVisible();
  await expect(dock.getByRole("img", { name: "RGB parade" })).toBeVisible();
  await expect(dock.getByRole("img", { name: "Vectorscope" })).toBeVisible();
  await expect(dock.getByText("Waveform", { exact: true })).toBeVisible();
  await expect(dock.getByText("Histogram", { exact: true })).toBeVisible();
});
