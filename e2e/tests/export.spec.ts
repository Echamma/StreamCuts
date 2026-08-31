import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { addTextClips, clips, openNewProject } from "./editor";

const execFileAsync = promisify(execFile);
const FFPROBE = process.env.FFPROBE_PATH ?? "ffprobe";

/**
 * Export (DEL-008 and the fixes around it).
 *
 * The export path regressed repeatedly while it was only ever checked by hand,
 * so these drive a real export in a real browser and then inspect the produced
 * file with ffprobe — the same measurement that eventually found the actual
 * bug, rather than trusting that the UI merely looked busy.
 *
 * Skipped automatically when ffprobe is unavailable, so the suite still runs on
 * a machine without ffmpeg installed.
 */

async function probe(filePath: string): Promise<{
	videoCodec: string | null;
	width: number | null;
	height: number | null;
	durationSeconds: number | null;
	frameCount: number;
}> {
	const { stdout } = await execFileAsync(
		FFPROBE,
		[
			"-v",
			"error",
			"-select_streams",
			"v:0",
			"-show_entries",
			"stream=codec_name,width,height:format=duration",
			"-of",
			"json",
			filePath,
		],
		{ maxBuffer: 1024 * 1024 * 16 },
	);
	const parsed: {
		streams?: { codec_name?: string; width?: number; height?: number }[];
		format?: { duration?: string };
	} = JSON.parse(stdout);
	const stream = parsed.streams?.[0];

	// Count decoded frames separately: a file can carry a plausible header and
	// still decode to nothing.
	const { stdout: counted } = await execFileAsync(
		FFPROBE,
		[
			"-v",
			"error",
			"-select_streams",
			"v:0",
			"-count_frames",
			"-show_entries",
			"stream=nb_read_frames",
			"-of",
			"csv=p=0",
			filePath,
		],
		{ maxBuffer: 1024 * 1024 * 16 },
	);

	return {
		videoCodec: stream?.codec_name ?? null,
		width: stream?.width ?? null,
		height: stream?.height ?? null,
		durationSeconds:
			parsed.format?.duration === undefined
				? null
				: Number(parsed.format.duration),
		frameCount: Number(counted.trim().split(/[\r\n,]+/)[0] ?? 0),
	};
}

let hasFfprobe = false;
test.beforeAll(async () => {
	hasFfprobe = await execFileAsync(FFPROBE, ["-version"]).then(
		() => true,
		() => false,
	);
});

test.describe("export", () => {
	test.beforeEach(async ({ page }) => {
		// Chromium supports the File System Access API, so the editor would open a
		// native "save file" dialog that no automation can drive. Removing it
		// makes the export fall back to its buffer path, which downloads the file
		// through the browser — the same code path a user without that API gets.
		await page.addInitScript(() => {
			// @ts-expect-error deliberately removing an optional platform API
			delete window.showSaveFilePicker;
		});
		await openNewProject(page);
		await addTextClips(page, { count: 1 });
		await expect(clips(page)).toHaveCount(1);
	});

	test("exports a file that actually decodes", async ({ page }) => {
		test.skip(!hasFfprobe, "ffprobe not on PATH");
		test.setTimeout(300_000);

		await page.getByTestId("export-trigger").click();
		await expect(page.getByText("Export project")).toBeVisible();

		const download = page.waitForEvent("download", { timeout: 240_000 });
		await page.getByTestId("export-start").click();
		const file = await download;
		const path = await file.path();
		expect(path).toBeTruthy();

		const info = await probe(path);
		// A truncated or empty render is the failure this guards against, so
		// assert the file genuinely decodes rather than merely existing.
		expect(info.videoCodec).toBe("h264");
		expect(info.frameCount).toBeGreaterThan(0);
		expect(info.width).toBeGreaterThan(0);
		expect(info.height).toBeGreaterThan(0);
		expect(info.durationSeconds ?? 0).toBeGreaterThan(0);
	});

	test("clicking elsewhere does not cancel a running export", async ({
		page,
	}) => {
		test.setTimeout(300_000);

		await page.getByTestId("export-trigger").click();
		await expect(page.getByText("Export project")).toBeVisible();

		const download = page.waitForEvent("download", { timeout: 240_000 });
		await page.getByTestId("export-start").click();

		// The popover closes on any outside click, and closing used to cancel the
		// export outright — so clicking anywhere in the editor threw the render
		// away. Click the timeline mid-export and require it to survive.
		await page.mouse.click(700, 640);
		await expect(page.getByText("Export project")).toBeHidden();

		// The trigger doubles as the progress readout while a background export
		// runs, which is how the user can tell it is still going.
		await expect(page.getByTestId("export-trigger")).toHaveAttribute(
			"data-exporting",
			"true",
		);

		const file = await download;
		expect(await file.path()).toBeTruthy();
	});
});
