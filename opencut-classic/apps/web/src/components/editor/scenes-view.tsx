"use client";

import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
	SheetTrigger,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Check, ListCheck, Merge, Plus, Trash2 } from "lucide-react";
import { cn } from "@/utils/ui";
import { useRef, useState } from "react";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogDescription,
	DialogFooter,
	DialogTrigger,
} from "@/components/ui/dialog";
import { canDeleteScene, getMainScene } from "@/timeline/scenes";
import { toast } from "sonner";
import { useEditor } from "@/editor/use-editor";

export function ScenesView({ children }: { children: React.ReactNode }) {
	const editor = useEditor();
	const scenes = editor.scenes.getScenes();
	const currentScene = editor.scenes.getActiveScene();
	const [isSelectMode, setIsSelectMode] = useState(false);
	const [isMergeMode, setIsMergeMode] = useState(false);
	const [selectedScenes, setSelectedScenes] = useState<Set<string>>(new Set());
	const [isCreatingScene, setIsCreatingScene] = useState(false);
	const [newSceneName, setNewSceneName] = useState("New Scene");
	const [mergeOutputName, setMergeOutputName] = useState("Merged Scene");
	const [isMergeNaming, setIsMergeNaming] = useState(false);
	const newSceneInputRef = useRef<HTMLInputElement>(null);
	const mergeInputRef = useRef<HTMLInputElement>(null);

	const handleSceneSwitch = async (sceneId: string) => {
		if (isSelectMode || isMergeMode) {
			toggleSceneSelection({ sceneId });
			return;
		}

		try {
			await editor.scenes.switchToScene({ sceneId });
		} catch (error) {
			console.error("Failed to switch scene:", error);
		}
	};

	const toggleSceneSelection = ({ sceneId }: { sceneId: string }) => {
		setSelectedScenes((prev) => {
			const newSet = new Set(prev);
			if (newSet.has(sceneId)) {
				newSet.delete(sceneId);
			} else {
				newSet.add(sceneId);
			}
			return newSet;
		});
	};

	const handleSelectMode = () => {
		setIsSelectMode(!isSelectMode);
		setIsMergeMode(false);
		setSelectedScenes(new Set());
	};

	const handleMergeMode = () => {
		setIsMergeMode(!isMergeMode);
		setIsSelectMode(false);
		setSelectedScenes(new Set());
		setIsMergeNaming(false);
	};

	const handleDeleteSelected = async () => {
		for (const sceneId of selectedScenes) {
			const scene = scenes.find((scene) => scene.id === sceneId);
			if (!scene) {
				continue;
			}

			const { canDelete, reason } = canDeleteScene({ scene });
			if (!canDelete) {
				toast.error(reason || "Failed to delete scene");
				continue;
			}

			try {
				await editor.scenes.deleteScene({ sceneId });
			} catch (error) {
				console.error("Failed to delete scene:", error);
			}
		}
		setSelectedScenes(new Set());
		setIsSelectMode(false);
	};

	const handleStartMerge = () => {
		if (selectedScenes.size < 2) {
			toast.error("Select at least 2 scenes to merge");
			return;
		}
		setMergeOutputName("Merged Scene");
		setIsMergeNaming(true);
		setTimeout(() => mergeInputRef.current?.select(), 0);
	};

	const handleConfirmMerge = async () => {
		const name = mergeOutputName.trim() || "Merged Scene";
		const sceneIds = scenes
			.filter((s) => selectedScenes.has(s.id))
			.map((s) => s.id);

		try {
			const mergedId = await editor.scenes.mergeScenes({
				sceneIds,
				outputName: name,
			});
			await editor.scenes.switchToScene({ sceneId: mergedId });
		} catch (error) {
			toast.error("Failed to merge scenes");
			console.error(error);
		}

		setSelectedScenes(new Set());
		setIsMergeMode(false);
		setIsMergeNaming(false);
	};

	const handleStartCreateScene = () => {
		setNewSceneName("New Scene");
		setIsCreatingScene(true);
		setTimeout(() => newSceneInputRef.current?.select(), 0);
	};

	const handleConfirmCreateScene = async () => {
		const name = newSceneName.trim() || "New Scene";
		try {
			const sceneId = await editor.scenes.createScene({ name, isMain: false });
			await editor.scenes.switchToScene({ sceneId });
		} catch (error) {
			console.error("Failed to create scene:", error);
		}
		setIsCreatingScene(false);
	};

	const isMainSceneSelected = (() => {
		const mainScene = getMainScene({ scenes });
		return Boolean(mainScene?.id && selectedScenes.has(mainScene.id));
	})();

	const activeLabel = isSelectMode
		? `Select scenes (${selectedScenes.size})`
		: isMergeMode
			? `Merge scenes (${selectedScenes.size} selected)`
			: "Scenes";

	const activeDescription = isSelectMode
		? "Select scenes to delete"
		: isMergeMode
			? "Select scenes to merge in order"
			: "Switch between scenes in your project";

	return (
		<Sheet>
			<SheetTrigger asChild>{children}</SheetTrigger>
			<SheetContent>
				<SheetHeader>
					<SheetTitle>{activeLabel}</SheetTitle>
					<SheetDescription>{activeDescription}</SheetDescription>
				</SheetHeader>
				<div className="flex flex-col gap-4 py-4">
					<div className="flex flex-wrap items-center gap-2">
						{!isSelectMode && !isMergeMode && (
							<Button
								className="rounded-md"
								variant="outline"
								size="sm"
								onClick={handleStartCreateScene}
							>
								<Plus />
								New scene
							</Button>
						)}
						<Button
							className="rounded-md"
							variant={isSelectMode ? "default" : "outline"}
							size="sm"
							onClick={handleSelectMode}
						>
							<ListCheck />
							{isSelectMode ? "Cancel" : "Select"}
						</Button>
						{!isSelectMode && (
							<Button
								className="rounded-md"
								variant={isMergeMode ? "default" : "outline"}
								size="sm"
								onClick={handleMergeMode}
							>
								<Merge />
								{isMergeMode ? "Cancel" : "Merge"}
							</Button>
						)}
						{isSelectMode && (
							<DeleteDialog
								count={selectedScenes.size}
								onDelete={handleDeleteSelected}
								disabled={isMainSceneSelected}
								trigger={
									<Button
										className="rounded-md"
										variant="destructive"
										disabled={isMainSceneSelected}
										size="sm"
									>
										<Trash2 />
										Delete ({selectedScenes.size})
									</Button>
								}
							/>
						)}
						{isMergeMode && !isMergeNaming && (
							<Button
								className="rounded-md"
								variant="default"
								size="sm"
								onClick={handleStartMerge}
								disabled={selectedScenes.size < 2}
							>
								<Merge />
								Create merged scene
							</Button>
						)}
					</div>

					{isCreatingScene && (
						<div className="flex gap-2">
							<Input
								ref={newSceneInputRef}
								value={newSceneName}
								onChange={(e) => setNewSceneName(e.target.value)}
								placeholder="Scene name"
								className="h-8 text-sm"
								onKeyDown={(e) => {
									if (e.key === "Enter") handleConfirmCreateScene();
									if (e.key === "Escape") setIsCreatingScene(false);
								}}
							/>
							<Button size="sm" className="h-8" onClick={handleConfirmCreateScene}>
								Create
							</Button>
						</div>
					)}

					{isMergeNaming && (
						<div className="flex gap-2">
							<Input
								ref={mergeInputRef}
								value={mergeOutputName}
								onChange={(e) => setMergeOutputName(e.target.value)}
								placeholder="Merged scene name"
								className="h-8 text-sm"
								onKeyDown={(e) => {
									if (e.key === "Enter") handleConfirmMerge();
									if (e.key === "Escape") setIsMergeNaming(false);
								}}
							/>
							<Button size="sm" className="h-8" onClick={handleConfirmMerge}>
								Merge
							</Button>
						</div>
					)}

					{scenes.length === 0 ? (
						<div className="text-muted-foreground text-sm">
							No scenes available
						</div>
					) : (
						<div className="space-y-2">
							{scenes.map((scene) => (
								<Button
									key={scene.id}
									variant="outline"
									className={cn(
										"w-full justify-between font-normal",
										currentScene?.id === scene.id &&
											!isSelectMode &&
											!isMergeMode &&
											"border-primary !text-primary",
										(isSelectMode || isMergeMode) &&
											selectedScenes.has(scene.id) &&
											"bg-accent border-foreground/30",
									)}
									onClick={() => handleSceneSwitch(scene.id)}
								>
									<span>{scene.name}</span>
									<div className="flex items-center gap-2">
										{(((isSelectMode || isMergeMode) && selectedScenes.has(scene.id)) ||
											(!isSelectMode && !isMergeMode && currentScene?.id === scene.id)) && (
											<Check className="size-4" />
										)}
									</div>
								</Button>
							))}
						</div>
					)}
				</div>
			</SheetContent>
		</Sheet>
	);
}

function DeleteDialog({
	count,
	onDelete,
	disabled,
	trigger,
}: {
	count: number;
	onDelete: () => void;
	disabled?: boolean;
	trigger: React.ReactNode;
}) {
	const [open, setOpen] = useState(false);

	const handleDelete = () => {
		onDelete();
		setOpen(false);
	};

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>{trigger}</DialogTrigger>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Delete Scenes</DialogTitle>
					<DialogDescription>
						Are you sure you want to delete {count} scene
						{count === 1 ? "" : "s"}? This action cannot be undone.
					</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<Button variant="outline" onClick={() => setOpen(false)}>
						Cancel
					</Button>
					<Button
						variant="destructive"
						onClick={handleDelete}
						disabled={disabled}
					>
						Delete
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
