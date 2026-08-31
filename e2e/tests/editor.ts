import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Shared driving helpers for the editor.
 *
 * Specs use **text clips** wherever they need "some clips on the timeline":
 * text needs no media import, so a test never has to drive a file picker or
 * ship a fixture video, while still exercising the same timeline element
 * machinery (selection, grouping, move, delete) that video clips use.
 */

/** Every clip currently drawn on the timeline. */
export function clips(page: Page): Locator {
	return page.locator('[data-testid="timeline-clip"]');
}

/** A specific clip by its element id. */
export function clipById(page: Page, id: string): Locator {
	return page.locator(`[data-testid="timeline-clip"][data-element-id="${id}"]`);
}

/** Clips the editor currently considers selected. */
export function selectedClips(page: Page): Locator {
	return page.locator('[data-testid="timeline-clip"][data-selected="true"]');
}

/** Element ids of the clips on the timeline, in DOM order. */
export async function clipIds(page: Page): Promise<string[]> {
	return clips(page).evaluateAll((nodes) =>
		nodes.map((node) => node.getAttribute("data-element-id") ?? ""),
	);
}

/**
 * Open a brand-new project and dismiss the first-run dialog.
 *
 * The editor refuses to render below a desktop width ("Desktop only (for
 * now)"), so specs must keep the default desktop viewport.
 */
export async function openNewProject(page: Page): Promise<void> {
	await page.goto("/projects");

	// A fresh browser profile has no projects, so the empty-state button is the
	// one that creates the first; a reused profile gets the header button.
	const firstProject = page.getByRole("button", {
		name: "Create your first project",
	});
	const newProject = page.getByRole("button", { name: "New project" });
	if (await firstProject.isVisible().catch(() => false)) {
		await firstProject.click();
	} else {
		await newProject.first().click();
	}

	await page.waitForURL(/\/editor\//, { timeout: 60_000 });
	await expect(page.getByText("Main scene")).toBeVisible({ timeout: 60_000 });

	// The beta welcome dialog covers the timeline on a fresh profile.
	const welcome = page.getByRole("dialog");
	if (await welcome.first().isVisible().catch(() => false)) {
		await page.keyboard.press("Escape");
		await expect(welcome.first()).toBeHidden({ timeout: 15_000 });
	}
}

/**
 * Add `count` text clips to the timeline. Each lands on its own track, giving
 * the grouping specs a group that spans tracks.
 */
export async function addTextClips(
	page: Page,
	{ count }: { count: number },
): Promise<void> {
	await page.getByRole("button", { name: "Text", exact: true }).click();

	const card = page.getByText("Default text", { exact: true }).first();
	await expect(card).toBeVisible();

	for (let index = 0; index < count; index++) {
		// The add control only appears on hover.
		await card.hover();
		await page.getByTestId("add-to-timeline").first().click();
		// Wait for this clip before adding the next, so they don't race onto the
		// same track.
		await expect(clips(page)).toHaveCount(index + 1);
	}
}

/**
 * Right-click a clip and choose a context-menu entry.
 *
 * A string matches the label exactly, which matters because several labels are
 * substrings of others ("Group clips" inside "Ungroup clips"). Pass a regex for
 * entries whose accessible name also carries their keyboard shortcut, e.g.
 * "Delete 2 elements BACKSPACE".
 */
export async function clipContextAction(
	page: Page,
	{ clip, action }: { clip: Locator; action: string | RegExp },
): Promise<void> {
	await clip.click({ button: "right" });
	const item = page.getByRole("menuitem", {
		name: action,
		exact: typeof action === "string",
	});
	await expect(item).toBeVisible();
	await item.click();
	await expect(item).toBeHidden();
}

/** Click empty timeline space to drop the current selection. */
export async function clearSelection(page: Page): Promise<void> {
	// Well below the tracks, but still inside the timeline surface.
	await page.mouse.click(700, 640);
	await expect(selectedClips(page)).toHaveCount(0);
}
