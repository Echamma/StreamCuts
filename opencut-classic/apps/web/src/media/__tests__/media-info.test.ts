import { describe, expect, test } from "bun:test";
import {
	buildMediaInfoRows,
	formatFileSize,
	formatFps,
	formatMediaDuration,
} from "@/media/media-info";

// media-info.ts is pure formatting — no @/wasm, no stub needed.

describe("formatFileSize", () => {
	test("scales to a sensible unit", () => {
		expect(formatFileSize(0)).toBe("0 B");
		expect(formatFileSize(500)).toBe("500 B");
		expect(formatFileSize(1024)).toBe("1.00 KB");
		expect(formatFileSize(1024 * 1024 * 5)).toBe("5.00 MB");
		expect(formatFileSize(1024 ** 3 * 2)).toBe("2.00 GB");
	});

	test("drops decimals for large magnitudes and rejects junk", () => {
		expect(formatFileSize(150 * 1024 * 1024)).toBe("150 MB");
		expect(formatFileSize(-5)).toBe("0 B");
		expect(formatFileSize(Number.NaN)).toBe("0 B");
	});
});

describe("formatMediaDuration", () => {
	test("m:ss under an hour, h:mm:ss past it", () => {
		expect(formatMediaDuration(0)).toBe("0:00");
		expect(formatMediaDuration(5)).toBe("0:05");
		expect(formatMediaDuration(90)).toBe("1:30");
		expect(formatMediaDuration(3600)).toBe("1:00:00");
		expect(formatMediaDuration(3661)).toBe("1:01:01");
	});

	test("guards non-finite / negative input", () => {
		expect(formatMediaDuration(-1)).toBe("0:00");
		expect(formatMediaDuration(Number.POSITIVE_INFINITY)).toBe("0:00");
	});
});

describe("formatFps", () => {
	test("integers plain, fractional trimmed", () => {
		expect(formatFps(30)).toBe("30");
		expect(formatFps(29.97)).toBe("29.97");
		expect(formatFps(23.976)).toBe("23.98");
	});
});

describe("buildMediaInfoRows", () => {
	test("video includes resolution, duration, frame rate, audio, size", () => {
		const rows = buildMediaInfoRows({
			type: "video",
			size: 1024 * 1024 * 10,
			width: 1920,
			height: 1080,
			duration: 65,
			fps: 30,
			hasAudio: true,
		});
		const map = Object.fromEntries(rows.map((r) => [r.label, r.value]));
		expect(map).toEqual({
			Type: "Video",
			Resolution: "1920×1080",
			Duration: "1:05",
			"Frame rate": "30 fps",
			Audio: "Yes",
			Size: "10.0 MB",
		});
	});

	test("image omits duration, frame rate and audio", () => {
		const labels = buildMediaInfoRows({
			type: "image",
			size: 2048,
			width: 800,
			height: 600,
		}).map((r) => r.label);
		expect(labels).toEqual(["Type", "Resolution", "Size"]);
	});

	test("audio omits resolution and reports no audio track", () => {
		const rows = buildMediaInfoRows({
			type: "audio",
			size: 4096,
			duration: 12,
			hasAudio: false,
		});
		const map = Object.fromEntries(rows.map((r) => [r.label, r.value]));
		expect(map.Resolution).toBeUndefined();
		expect(map.Audio).toBe("No");
		expect(map.Duration).toBe("0:12");
	});
});
