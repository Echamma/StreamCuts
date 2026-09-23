import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { openNewProject } from "./editor";

const exec = promisify(execFile);
const ffmpeg = process.env.FFMPEG_PATH ?? "ffmpeg";

async function rms(file: string): Promise<number> {
  const data = await readFile(file);
  let sum = 0;
  for (let offset = 0; offset < data.length; offset += 4) {
    const sample = data.readFloatLE(offset);
    sum += sample * sample;
  }
  return Math.sqrt(sum / (data.length / 4));
}

test("mixer EQ persists and cuts the selected frequency in export", async ({
  page,
}, testInfo) => {
  test.setTimeout(300_000);
  const input = testInfo.outputPath("two-tone.wav");
  await exec(ffmpeg, [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=250:duration=1:sample_rate=44100",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=1000:duration=1:sample_rate=44100",
    "-filter_complex",
    "[0:a][1:a]concat=n=2:v=0:a=1,volume=0.4[a]",
    "-map",
    "[a]",
    "-c:a",
    "pcm_s16le",
    input,
  ]);

  await page.addInitScript(() => {
    // @ts-expect-error exercise the browser download path
    delete window.showSaveFilePicker;
  });
  await openNewProject(page);
  await page.locator('input[type="file"]').first().setInputFiles(input);
  const asset = page.locator('span[title="two-tone.wav"]').first();
  await expect(asset).toBeVisible({ timeout: 60_000 });
  await asset.hover();
  await page.getByTestId("add-to-timeline").first().click();

  await page
    .getByRole("button", { name: "Audio", exact: true })
    .first()
    .click();
  await page.getByTestId("eq-controls").first().locator("summary").click();
  const midGain = page.getByTestId("eq-mid-gain").first();
  await midGain.focus();
  await midGain.press("Home");
  for (let index = 0; index < 12; index++) await midGain.press("ArrowRight");
  await expect(midGain).toHaveValue("-12");

  await page.reload();
  await page
    .getByRole("button", { name: "Audio", exact: true })
    .first()
    .click();
  await page.getByTestId("eq-controls").first().locator("summary").click();
  await expect(page.getByTestId("eq-mid-gain").first()).toHaveValue("-12");

  await page.getByTestId("export-trigger").click();
  const download = page.waitForEvent("download", { timeout: 240_000 });
  await page.getByTestId("export-start").click();
  const output = await (await download).path();
  expect(output).toBeTruthy();

  const low = testInfo.outputPath("low.f32");
  const mid = testInfo.outputPath("mid.f32");
  for (const [start, destination] of [
    ["0.15", low],
    ["1.15", mid],
  ]) {
    await exec(ffmpeg, [
      "-y",
      "-v",
      "error",
      "-i",
      output!,
      "-ss",
      start,
      "-t",
      "0.65",
      "-map",
      "0:a:0",
      "-ac",
      "1",
      "-ar",
      "44100",
      "-f",
      "f32le",
      destination,
    ]);
  }
  const attenuationDb = 20 * Math.log10((await rms(mid)) / (await rms(low)));
  expect(attenuationDb).toBeGreaterThan(-15);
  expect(attenuationDb).toBeLessThan(-9);
});
