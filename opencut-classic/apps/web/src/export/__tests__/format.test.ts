import { describe, expect, test } from "bun:test";
import {
	EXPORT_FORMAT_VALUES,
	getExportFileExtension,
	getExportMimeType,
	getFormatFileExtension,
} from "@/export";

describe("ExportFormat (DEL-002 AV1)", () => {
	test("EXPORT_FORMAT_VALUES contains webm-av1", () => {
		expect(EXPORT_FORMAT_VALUES).toContain("webm-av1");
	});

	test("webm-av1 uses the .webm extension", () => {
		expect(getFormatFileExtension({ format: "webm-av1" })).toBe(".webm");
		expect(getExportFileExtension({ format: "webm-av1" })).toBe(".webm");
	});

	test("webm-av1 uses the video/webm mime type", () => {
		expect(getExportMimeType({ format: "webm-av1" })).toBe("video/webm");
	});

	test("mp4 extension is unchanged", () => {
		expect(getFormatFileExtension({ format: "mp4" })).toBe(".mp4");
	});

	test("webm (VP9) extension is unchanged", () => {
		expect(getFormatFileExtension({ format: "webm" })).toBe(".webm");
	});
});
