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

test("Color page scopes reduce the preview's red pixels through WASM", async ({
  page,
}) => {
  await openNewProject(page);
  await page.getByRole("button", { name: "Project thumbnail" }).click();
  await page.getByRole("menuitemcheckbox", { name: "Pages workspace" }).click();
  await page.keyboard.press("Escape");
  await page.getByRole("tab", { name: "Color" }).click();
  const dock = page.getByTestId("scopes-dock");
  await expect(dock).toBeVisible();

  const pixel = (name: string, x: number, y: number) =>
    dock.getByRole("img", { name }).evaluate(
      (element, point) => {
        const canvas = element as HTMLCanvasElement;
        return Array.from(
          canvas.getContext("2d")!.getImageData(point.x, point.y, 1, 1).data,
        );
      },
      { x, y },
    );
  const baselineVectorscope = await pixel("Vectorscope", 98, 0);

  // The dock re-queries this source every frame. Put a deterministic bitmap
  // first so the test covers DOM sampling, the Rust WASM reductions, and paint.
  await page.evaluate(() => {
    const source = document.querySelector("[data-scope-source]");
    if (!source) throw new Error("Preview scope source is missing");
    const canvas = document.createElement("canvas");
    canvas.width = 32;
    canvas.height = 18;
    canvas.style.display = "none";
    const context = canvas.getContext("2d");
    if (!context) throw new Error("2D canvas is unavailable");
    context.fillStyle = "#ff0000";
    context.fillRect(0, 0, canvas.width, canvas.height);
    source.prepend(canvas);
  });

  // Opaque red appears at the parade's maximum red bin (top of its R plane).
  await expect
    .poll(async () => (await pixel("RGB parade", 43, 0))[3])
    .toBe(255);
  const parade = await pixel("RGB parade", 43, 0);
  expect(parade[0]).toBeGreaterThan(parade[1]! * 2);
  expect(parade[0]).toBeGreaterThan(parade[2]! * 2);

  // Pure red maps to the Rec.709 vectorscope target at (98, 0).
  await expect
    .poll(async () => (await pixel("Vectorscope", 98, 0))[3])
    .toBe(255);
  const vectorscope = await pixel("Vectorscope", 98, 0);
  expect(vectorscope[3]).toBeGreaterThan(baselineVectorscope[3]!);
  expect(vectorscope[1]).toBeGreaterThan(baselineVectorscope[1]!);
});
