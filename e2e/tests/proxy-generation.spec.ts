import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { openNewProject } from "./editor";

const exec = promisify(execFile);
const ffmpeg = process.env.FFMPEG_PATH ?? "ffmpeg";

test("bulk proxy generation persists and marks media and timeline clips", async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  const input = testInfo.outputPath("proxy-fixture.mp4");
  await exec(ffmpeg, [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=320x180:rate=24:duration=2",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    input,
  ]);

  await openNewProject(page);
  await page.locator('input[type="file"]').first().setInputFiles(input);
  const asset = page.locator('span[title="proxy-fixture.mp4"]').first();
  await expect(asset).toBeVisible({ timeout: 60_000 });
  await asset.hover();
  await page.getByTestId("add-to-timeline").first().click();
  await expect(
    page
      .getByTestId("timeline-clip")
      .filter({ has: page.locator('[data-testid="proxy-badge"]') }),
  ).toHaveCount(0);

  await page.getByTestId("generate-all-proxies").click();
  await expect(page.getByTestId("proxy-badge").first()).toBeVisible({
    timeout: 120_000,
  });
  await expect(page.getByTestId("timeline-clip").first()).toHaveAttribute(
    "data-proxy",
    "true",
  );

  await page.reload();
  await expect(page.getByTestId("proxy-badge").first()).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByTestId("timeline-clip").first()).toHaveAttribute(
    "data-proxy",
    "true",
  );
});

test("automatic proxies stay off until enabled in project settings", async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  const input = testInfo.outputPath("auto-proxy.mp4");
  await exec(ffmpeg, [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=320x180:rate=24:duration=1",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    input,
  ]);

  await openNewProject(page);
  await page.getByRole("button", { name: "Settings" }).click();
  const autoProxies = page.getByRole("checkbox", {
    name: "Generate proxies automatically",
  });
  await expect(autoProxies).not.toBeChecked();
  await autoProxies.check();
  await page.getByRole("button", { name: "Media", exact: true }).click();
  await page.locator('input[type="file"]').first().setInputFiles(input);
  await expect(page.getByTestId("proxy-badge").first()).toBeVisible({
    timeout: 120_000,
  });

  await page.reload();
  await expect(page.getByTestId("proxy-badge").first()).toBeVisible({
    timeout: 60_000,
  });
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(
    page.getByRole("checkbox", { name: "Generate proxies automatically" }),
  ).toBeChecked();
});
