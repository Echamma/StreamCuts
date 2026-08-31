import { expect, test } from "@playwright/test";
import {
	addTextClips,
	clearSelection,
	clipById,
	clipContextAction,
	clipIds,
	clips,
	openNewProject,
	selectedClips,
} from "./editor";

/**
 * Clip grouping (EDIT-006). Grouped clips select, move and delete as one unit.
 *
 * These assert behaviour the unit tests cannot reach: the unit suite proves the
 * closure maths over scene tracks, while this proves the actions are wired to
 * it — that clicking one clip really does select its group in the running app.
 */
test.describe("clip groups", () => {
	test.beforeEach(async ({ page }) => {
		await openNewProject(page);
		await addTextClips(page, { count: 2 });
		await expect(clips(page)).toHaveCount(2);
	});

	test("selecting one clip in a group selects the whole group", async ({
		page,
	}) => {
		const [first, second] = await clipIds(page);

		// Group both clips.
		await clipById(page, first).click();
		await clipById(page, second).click({ modifiers: ["Control"] });
		await expect(selectedClips(page)).toHaveCount(2);
		await clipContextAction(page, {
			clip: clipById(page, first),
			action: "Group clips",
		});
		await expect(
			page.locator('[data-testid="timeline-clip"][data-grouped="true"]'),
		).toHaveCount(2);

		await clearSelection(page);

		// The point of the feature: one click selects both.
		await clipById(page, first).click();
		await expect(selectedClips(page)).toHaveCount(2);

		// ...from either member.
		await clearSelection(page);
		await clipById(page, second).click();
		await expect(selectedClips(page)).toHaveCount(2);
	});

	test("ungrouping restores independent selection", async ({ page }) => {
		const [first, second] = await clipIds(page);

		await clipById(page, first).click();
		await clipById(page, second).click({ modifiers: ["Control"] });
		await clipContextAction(page, {
			clip: clipById(page, first),
			action: "Group clips",
		});
		await clipContextAction(page, {
			clip: clipById(page, first),
			action: "Ungroup clips",
		});

		await expect(
			page.locator('[data-testid="timeline-clip"][data-grouped="true"]'),
		).toHaveCount(0);

		await clearSelection(page);
		await clipById(page, first).click();
		await expect(selectedClips(page)).toHaveCount(1);
	});

	test("deleting a grouped clip deletes the group, and undo restores it", async ({
		page,
	}) => {
		const [first, second] = await clipIds(page);

		await clipById(page, first).click();
		await clipById(page, second).click({ modifiers: ["Control"] });
		await clipContextAction(page, {
			clip: clipById(page, first),
			action: "Group clips",
		});
		await clearSelection(page);

		// Selecting one and deleting takes the whole group with it.
		await clipById(page, first).click();
		await clipContextAction(page, {
			clip: clipById(page, first),
			// The accessible name carries the shortcut too ("… BACKSPACE").
			action: /^Delete 2 elements/,
		});
		await expect(clips(page)).toHaveCount(0);

		await page.keyboard.press("Control+z");
		await expect(clips(page)).toHaveCount(2);
		// The group survives the undo, so the restored clips still travel together.
		await expect(
			page.locator('[data-testid="timeline-clip"][data-grouped="true"]'),
		).toHaveCount(2);
	});

	test("ungrouped clips are unaffected — one click selects one clip", async ({
		page,
	}) => {
		const [first] = await clipIds(page);
		await clipById(page, first).click();
		await expect(selectedClips(page)).toHaveCount(1);
	});
});
