import { useCallback, useMemo } from "react";
import { useEditor, useSelection } from "@/editor/use-editor";
import type { ElementRef } from "@/timeline/types";

export function useElementSelection() {
	const editor = useEditor();
	const selectedElements = useSelection((e) => e.selection.getSelectedElements());

	// O(1) membership lookups — keyed as "trackId:elementId".
	const selectedSet = useMemo(
		() => new Set(selectedElements.map((e) => `${e.trackId}:${e.elementId}`)),
		[selectedElements],
	);

	const isElementSelected = useCallback(
		({ trackId, elementId }: ElementRef) =>
			selectedSet.has(`${trackId}:${elementId}`),
		[selectedSet],
	);

	const selectElement = useCallback(
		({ trackId, elementId }: ElementRef) => {
			editor.selection.setSelectedElements({
				elements: [{ trackId, elementId }],
			});
		},
		[editor],
	);

	const addElementToSelection = useCallback(
		({ trackId, elementId }: ElementRef) => {
			if (selectedSet.has(`${trackId}:${elementId}`)) return;

			editor.selection.setSelectedElements({
				elements: [...selectedElements, { trackId, elementId }],
			});
		},
		[selectedElements, selectedSet, editor],
	);

	const removeElementFromSelection = useCallback(
		({ trackId, elementId }: ElementRef) => {
			editor.selection.setSelectedElements({
				elements: selectedElements.filter(
					(element) =>
						!(element.trackId === trackId && element.elementId === elementId),
				),
			});
		},
		[selectedElements, editor],
	);

	const toggleElementSelection = useCallback(
		({ trackId, elementId }: ElementRef) => {
			if (selectedSet.has(`${trackId}:${elementId}`)) {
				removeElementFromSelection({ trackId, elementId });
			} else {
				addElementToSelection({ trackId, elementId });
			}
		},
		[selectedSet, addElementToSelection, removeElementFromSelection],
	);

	const clearElementSelection = useCallback(() => {
		editor.selection.clearSelection();
	}, [editor]);

	const setElementSelection = useCallback(
		({ elements }: { elements: ElementRef[] }) => {
			editor.selection.setSelectedElements({ elements });
		},
		[editor],
	);


	/**
	 * Merges elements into the current selection, deduplicating by identity.
	 * Used for additive box-select where the pre-drag selection is preserved.
	 */
	const mergeElementsIntoSelection = useCallback(
		({ elements }: { elements: ElementRef[] }) => {
			const incomingSet = new Set(elements.map((e) => `${e.trackId}:${e.elementId}`));
			const merged = [
				...selectedElements.filter(
					(se) => !incomingSet.has(`${se.trackId}:${se.elementId}`),
				),
				...elements,
			];
			editor.selection.setSelectedElements({ elements: merged });
		},
		[selectedElements, editor],
	);


	/**
	 * Handles click interaction on an element.
	 * - Regular click: select only this element
	 * - Multi-key click (Ctrl/Cmd): toggle this element in selection
	 */
	const handleElementClick = useCallback(
		({
			trackId,
			elementId,
			isMultiKey,
		}: ElementRef & { isMultiKey: boolean }) => {
			if (isMultiKey) {
				toggleElementSelection({ trackId, elementId });
			} else {
				selectElement({ trackId, elementId });
			}
		},
		[toggleElementSelection, selectElement],
	);

	return {
		selectedElements,
		isElementSelected,
		selectElement,
		setElementSelection,
		mergeElementsIntoSelection,
		addElementToSelection,
		removeElementFromSelection,
		toggleElementSelection,
		clearElementSelection,
		handleElementClick,
	};
}
