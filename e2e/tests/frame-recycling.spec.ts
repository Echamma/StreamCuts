import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { clips, openNewProject } from "./editor";

const exec = promisify(execFile);
const ffmpeg = process.env.FFMPEG_PATH ?? "ffmpeg";

test("90 fps source exports at 30 fps without recycled or out-of-order frames", async ({
  page,
}, testInfo) => {
  test.setTimeout(300_000);
  page.setDefaultTimeout(30_000);
  const input = testInfo.outputPath("frame-counter.mp4");
  const font =
    process.platform === "win32"
      ? `fontfile='${(process.env.WINDIR ?? "C:/Windows").replaceAll("\\", "/").replaceAll(":", "\\:")}/Fonts/arial.ttf':`
      : "";
  // Each frame has both a visible counter and a monotonically increasing gray
  // level. Center pixels provide a numeric oracle without depending on OCR.
  await exec(ffmpeg, [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "nullsrc=s=320x180:r=90:d=1",
    "-vf",
    `geq=lum='32+2*N':cb=128:cr=128,drawtext=${font}text='%{n}':x=8:y=8:fontsize=20:fontcolor=white`,
    "-c:v",
    "libx264",
    "-crf",
    "0",
    "-pix_fmt",
    "yuv420p",
    input,
  ]);
  await page.addInitScript(() => {
    // @ts-expect-error exercise the browser download fallback
    delete window.showSaveFilePicker;
  });
  await test.step("Create project", () => openNewProject(page));
  await page.locator('input[type="file"]').first().setInputFiles(input);
  const asset = page.locator('span[title="frame-counter.mp4"]').first();
  await expect(asset).toBeVisible({ timeout: 60_000 });
  await asset.hover();
  await page.getByTestId("add-to-timeline").first().click();
  await expect(clips(page)).toHaveCount(1);
  // Import raises the project rate to match the source. Explicitly downsample
  // by three to exercise the original three-slot decoder pool regression.
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByText("Frame rate", { exact: true })
    .locator("..")
    .getByRole("combobox")
    .click();
  await page.getByRole("option", { name: "30 fps", exact: true }).click();
  await page.getByTestId("export-trigger").click();
  const downloaded = page.waitForEvent("download", { timeout: 240_000 });
  await page.getByTestId("export-start").click();
  const output = await (await downloaded).path();
  expect(output).toBeTruthy();

  async function centerPixels(file: string): Promise<Buffer> {
    const result = await exec(
      ffmpeg,
      [
        "-v",
        "error",
        "-i",
        file,
        "-vf",
        "crop=32:32:(iw-32)/2:(ih-32)/2,scale=1:1",
        "-pix_fmt",
        "gray",
        "-f",
        "rawvideo",
        "pipe:1",
      ],
      { encoding: "buffer" },
    );
    return result.stdout;
  }
  const reference = await centerPixels(input);
  const actual = await centerPixels(output!);
  expect(reference.length).toBe(90);
  expect(actual.length).toBe(30);
  for (let frame = 0; frame < actual.length; frame++) {
    expect(Math.abs(actual[frame] - reference[frame * 3])).toBeLessThanOrEqual(
      3,
    );
    if (frame > 0) expect(actual[frame]).toBeGreaterThan(actual[frame - 1]);
  }
});
