import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test, type Page } from "@playwright/test";
import {
  addTextClips,
  clipById,
  clipContextAction,
  clipIds,
  clips,
  openNewProject,
  selectedClips,
} from "./editor";

const exec = promisify(execFile);
const ffmpeg = process.env.FFMPEG_PATH ?? "ffmpeg";

async function makeCompound(page: Page) {
  const [first, second] = await clipIds(page);
  await clipById(page, first).click();
  await clipById(page, second).click({ modifiers: ["Control"] });
  await expect(selectedClips(page)).toHaveCount(2);
  await clipContextAction(page, {
    clip: clipById(page, first),
    action: "Make compound clip",
  });
  const compound = page.locator(
    '[data-testid="timeline-clip"][data-element-type="compound"]',
  );
  await expect(compound).toHaveCount(1);
  return compound;
}

async function exportFrame(page: Page): Promise<Buffer> {
  await page.getByTestId("export-trigger").click();
  const download = page.waitForEvent("download", { timeout: 240_000 });
  await page.getByTestId("export-start").click();
  const file = await download;
  const { stdout } = await exec(
    ffmpeg,
    [
      "-v",
      "error",
      "-ss",
      "0.5",
      "-i",
      (await file.path())!,
      "-frames:v",
      "1",
      "-pix_fmt",
      "rgb24",
      "-f",
      "rawvideo",
      "pipe:1",
    ],
    { encoding: "buffer", maxBuffer: 32 * 1024 * 1024 },
  );
  return stdout;
}

test.describe("compound clips", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      // @ts-expect-error choose browser download instead of the native save picker
      delete window.showSaveFilePicker;
    });
    await openNewProject(page);
    await addTextClips(page, { count: 2 });
  });

  test("fold, enter, edit, exit, reload, decompose and undo", async ({
    page,
  }) => {
    const compound = await makeCompound(page);
    await compound.dblclick();
    const path = page.getByRole("navigation", { name: "Compound clip path" });
    await expect(path).toContainText("Compound Clip");
    await expect(clips(page)).toHaveCount(2);

    await page.getByRole("button", { name: "Text", exact: true }).click();
    const card = page.getByText("Default text", { exact: true }).first();
    await card.hover();
    await page.getByTestId("add-to-timeline").first().click();
    await expect(clips(page)).toHaveCount(3);

    await path.getByRole("button").first().click();
    await expect(path).toBeHidden();
    await expect(clips(page)).toHaveCount(1);
    await page.reload();
    const restored = page.locator(
      '[data-testid="timeline-clip"][data-element-type="compound"]',
    );
    await expect(restored).toHaveCount(1);
    await restored.dblclick();
    await expect(clips(page)).toHaveCount(3);
    await page.keyboard.press("Escape");
    await expect(path).toBeHidden();

    await clipContextAction(page, {
      clip: restored,
      action: "Decompose compound clip",
    });
    await expect(clips(page)).toHaveCount(3);
    await page.keyboard.press("Control+z");
    await expect(restored).toHaveCount(1);
  });

  test("a folded compound exports the same visible frame", async ({ page }) => {
    test.setTimeout(600_000);
    const before = await exportFrame(page);
    expect(before.length).toBeGreaterThan(0);
    expect(before.some((channel) => channel > 32)).toBe(true);

    await makeCompound(page);
    const after = await exportFrame(page);
    expect(after.length).toBe(before.length);
    let materiallyDifferent = 0;
    for (let index = 0; index < before.length; index++) {
      if (Math.abs(before[index]! - after[index]!) > 4) materiallyDifferent++;
    }
    expect(materiallyDifferent / before.length).toBeLessThan(0.02);
  });
});
