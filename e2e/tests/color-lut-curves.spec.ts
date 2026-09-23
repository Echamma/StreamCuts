import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { clipById, clipIds, clips, openNewProject } from "./editor";
import { parseCubeLut } from "../../opencut-classic/apps/web/src/effects/luts/cube-lut";
import { sampleCubeLut } from "../../opencut-classic/apps/web/src/effects/luts/sample-cube-lut";
import {
  prepareToneCurve,
  evaluateToneCurve,
} from "../../opencut-classic/apps/web/src/effects/curves/tone-curve";

const exec = promisify(execFile);
const ffmpeg = process.env.FFMPEG_PATH ?? "ffmpeg";
// The red channel exceeds 1, so the partial-intensity export also catches
// premature clamping when the LUT is packed into an 8-bit GPU texture.
const cube =
  "LUT_3D_SIZE 2\nDOMAIN_MAX 2 2 2\n1.5 1 1\n1.5 1 1\n1.5 0 1\n1.5 0 1\n1.5 1 0\n1.5 1 0\n1.5 0 0\n1.5 0 0";

async function pixel(file: string): Promise<number[]> {
  const { stdout } = await exec(
    ffmpeg,
    [
      "-v",
      "error",
      "-i",
      file,
      "-frames:v",
      "1",
      "-vf",
      "crop=16:16:(iw-16)/2:(ih-16)/2,scale=1:1",
      "-pix_fmt",
      "rgb24",
      "-f",
      "rawvideo",
      "pipe:1",
    ],
    { encoding: "buffer" },
  );
  return Array.from(stdout.subarray(0, 3));
}

async function addCard(page: Page, name: string): Promise<string> {
  const before = await clipIds(page);
  const label = page.locator(`span[title="${name}"]`).first();
  await expect(label).toBeVisible();
  await label.hover();
  await label.locator("..").getByTestId("add-to-timeline").click();
  await expect(clips(page)).toHaveCount(before.length + 1);
  const id = (await clipIds(page)).find((id) => !before.includes(id))!;
  await clipById(page, id).click();
  return id;
}

async function setup(page: Page, info: TestInfo): Promise<number[]> {
  page.setDefaultTimeout(30_000);
  await page.addInitScript(() => {
    // @ts-expect-error choose downloadable output rather than a native picker
    delete window.showSaveFilePicker;
  });
  const source = info.outputPath("color.png");
  await exec(ffmpeg, [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=0x4080c0:s=320x180",
    "-frames:v",
    "1",
    source,
  ]);
  await openNewProject(page);
  await page.locator('input[type="file"]').first().setInputFiles(source);
  await addCard(page, "color.png");
  await page
    .getByRole("button", { name: "Effects", exact: true })
    .first()
    .click();
  return pixel(source);
}

async function exportPixel(page: Page): Promise<number[]> {
  await page.getByTestId("export-trigger").click();
  const download = page.waitForEvent("download", { timeout: 180_000 });
  await page.getByTestId("export-start").click();
  const result = await Promise.race([
    download.then((value) => ({ kind: "download" as const, value })),
    page
      .getByText("Export failed", { exact: true })
      .waitFor({ timeout: 180_000 })
      .then(() => ({ kind: "error" as const })),
  ]);
  if (result.kind === "error") {
    throw new Error(
      `Export failed: ${await page.getByRole("dialog").textContent()}`,
    );
  }
  return pixel((await result.value.path())!);
}

test("LUT import, domain, intensity, invalid file and persistence match exported pixels", async ({
  page,
}, info) => {
  test.setTimeout(300_000);
  const source = await setup(page, info);
  const id = await addCard(page, "Color LUT");
  await page.getByLabel("Import LUT", { exact: true }).setInputFiles({
    name: "invert.cube",
    mimeType: "text/plain",
    buffer: Buffer.from(cube),
  });
  await expect(
    page.getByTestId("lut-controls").getByRole("status"),
  ).toContainText("LUT loaded");
  await page.getByLabel("LUT intensity", { exact: true }).fill("50");
  await page.getByLabel("LUT intensity", { exact: true }).press("Tab");
  const output = await exportPixel(page);
  const rgb: [number, number, number] = [
    source[0] / 255,
    source[1] / 255,
    source[2] / 255,
  ];
  const graded = sampleCubeLut({ lut: parseCubeLut({ text: cube }), rgb });
  output.forEach((value, c) =>
    expect(
      Math.abs(value - (rgb[c] + graded[c]) * 0.5 * 255),
    ).toBeLessThanOrEqual(5),
  );
  await page.keyboard.press("Escape");
  await clipById(page, id).click();
  await page.getByLabel("Import LUT", { exact: true }).setInputFiles({
    name: "bad.cube",
    mimeType: "text/plain",
    buffer: Buffer.from("LUT_3D_SIZE 2\nNaN 0 0"),
  });
  await expect(
    page.getByTestId("lut-controls").getByRole("alert"),
  ).toBeVisible();
  await page.reload();
  await clipById(page, id).click();
  await expect(page.getByLabel("LUT intensity", { exact: true })).toHaveValue(
    "50",
  );
  await expect(
    page.getByTestId("lut-controls").getByRole("status"),
  ).toContainText("LUT loaded");
  await page.getByLabel("LUT intensity", { exact: true }).fill("0");
  await page.getByLabel("LUT intensity", { exact: true }).press("Tab");
  const neutral = await exportPixel(page);
  neutral.forEach((value, c) =>
    expect(Math.abs(value - source[c])).toBeLessThanOrEqual(5),
  );
});

test("curve point editing, channel selection, undo and persistence match exported pixels", async ({
  page,
}, info) => {
  test.setTimeout(300_000);
  const source = await setup(page, info);
  const id = await addCard(page, "Curves");
  await page.getByRole("button", { name: "Add point", exact: true }).click();
  await page.getByLabel("Curve output", { exact: true }).fill("0.75");
  await page.getByLabel("Curve output", { exact: true }).press("Tab");
  const curve = prepareToneCurve({
    points: [
      { x: 0, y: 0 },
      { x: 0.5, y: 0.75 },
      { x: 1, y: 1 },
    ],
  });
  const output = await exportPixel(page);
  output.forEach((value, c) =>
    expect(
      Math.abs(value - evaluateToneCurve({ curve, x: source[c] / 255 }) * 255),
    ).toBeLessThanOrEqual(5),
  );
  await page.keyboard.press("Escape");
  await page.reload();
  await clipById(page, id).click();
  await page
    .getByRole("button", { name: "Curve point 2", exact: true })
    .focus();
  await expect(page.getByLabel("Curve output", { exact: true })).toHaveValue(
    "0.75",
  );
  await page.getByLabel("Curve channel", { exact: true }).selectOption("1");
  await page.getByRole("button", { name: "Add point", exact: true }).click();
  await page.getByLabel("Curve output", { exact: true }).fill("0.25");
  await page.getByLabel("Curve output", { exact: true }).press("Tab");
  await page.getByRole("button", { name: "Reset curve", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Curve point 3", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(
    page.getByRole("button", { name: "Curve point 3", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Curve point 2", exact: true })
    .focus();
  await expect(page.getByLabel("Curve output", { exact: true })).toHaveValue(
    "0.25",
  );
});
