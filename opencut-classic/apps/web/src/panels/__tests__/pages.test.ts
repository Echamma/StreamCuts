import { describe, expect, test, beforeEach } from "bun:test";
import {
	DEFAULT_PAGE,
	isPageId,
	isPageReady,
	PAGE_IDS,
	PAGE_META,
	PAGE_ORDER,
} from "@/panels/pages";
import { usePageStore } from "@/editor/page-store";
import { FLAG_META, useFlagStore, isFlagEnabled } from "@/flags";

describe("pages registry", () => {
	test("every page id has metadata with a matching id", () => {
		for (const id of PAGE_IDS) {
			expect(PAGE_META[id]).toBeDefined();
			expect(PAGE_META[id].id).toBe(id);
		}
	});

	test("shortcuts are unique across pages", () => {
		const shortcuts = PAGE_IDS.map((id) => PAGE_META[id].shortcut);
		expect(new Set(shortcuts).size).toBe(shortcuts.length);
	});

	test("page order covers exactly the page ids", () => {
		expect([...PAGE_ORDER].sort()).toEqual([...PAGE_IDS].sort());
	});

	test("Edit is the default page and is ready", () => {
		expect(DEFAULT_PAGE).toBe("edit");
		expect(isPageReady({ page: "edit" })).toBe(true);
	});

	test("the default page must always be ready (safe fallback)", () => {
		expect(PAGE_META[DEFAULT_PAGE].ready).toBe(true);
	});

	test("isPageId narrows only known ids", () => {
		expect(isPageId("color")).toBe(true);
		expect(isPageId("cut")).toBe(false);
		expect(isPageId("")).toBe(false);
	});
});

describe("page store", () => {
	beforeEach(() => {
		usePageStore.getState().resetPage();
	});

	test("starts on the default page", () => {
		expect(usePageStore.getState().activePage).toBe(DEFAULT_PAGE);
	});

	test("switching to a ready page updates the active page", () => {
		usePageStore.getState().setActivePage({ page: "edit" });
		expect(usePageStore.getState().activePage).toBe("edit");
	});

	test("switching to a not-ready page is ignored", () => {
		const notReady = PAGE_IDS.find((id) => !PAGE_META[id].ready);
		expect(notReady).toBeDefined();
		if (!notReady) return;
		usePageStore.getState().setActivePage({ page: notReady });
		expect(usePageStore.getState().activePage).toBe(DEFAULT_PAGE);
	});
});

describe("feature flags", () => {
	beforeEach(() => {
		useFlagStore.setState({ overrides: {} });
	});

	test("pages-shell defaults off", () => {
		expect(FLAG_META["pages-shell"].defaultValue).toBe(false);
		expect(isFlagEnabled("pages-shell")).toBe(false);
	});

	test("an override flips the resolved value", () => {
		useFlagStore.getState().setFlag({ id: "pages-shell", enabled: true });
		expect(isFlagEnabled("pages-shell")).toBe(true);
	});

	test("resetting a flag falls back to the default", () => {
		useFlagStore.getState().setFlag({ id: "pages-shell", enabled: true });
		useFlagStore.getState().resetFlag({ id: "pages-shell" });
		expect(isFlagEnabled("pages-shell")).toBe(false);
	});
});
