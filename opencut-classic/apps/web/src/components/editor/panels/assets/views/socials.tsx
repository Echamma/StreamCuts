"use client";

import { PanelView } from "@/components/editor/panels/assets/views/base-panel";
import {
	Section,
	SectionContent,
	SectionField,
	SectionFields,
	SectionHeader,
	SectionTitle,
} from "@/components/section";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useSocialsStore } from "@/socials/store";

export function SocialsView() {
	const about = useSocialsStore((state) => state.about);
	const links = useSocialsStore((state) => state.links);
	const setAbout = useSocialsStore((state) => state.setAbout);
	const updateLink = useSocialsStore((state) => state.updateLink);
	const addLink = useSocialsStore((state) => state.addLink);
	const removeLink = useSocialsStore((state) => state.removeLink);

	return (
		<PanelView title="Socials">
			<div className="flex flex-col gap-4 pb-4">
				<div className="rounded-md border bg-accent/35 p-3">
					<p className="text-sm font-medium">Saved locally for short-form copy.</p>
					<p className="mt-1 text-xs leading-5 text-muted-foreground">
						Your bio and links get appended when you use{" "}
						<span className="font-medium text-foreground">
							Copy description
						</span>{" "}
						on generated shorts.
					</p>
				</div>

				<Section showTopBorder={false}>
					<SectionHeader>
						<SectionTitle>About you</SectionTitle>
					</SectionHeader>
					<SectionContent className="pt-0">
						<Textarea
							value={about}
							onChange={(event) => setAbout(event.currentTarget.value)}
							rows={6}
							placeholder="Tell viewers who you are, what you post, or why they should follow."
						/>
					</SectionContent>
				</Section>

				<Section showTopBorder={false}>
					<SectionHeader
						actions={
							<Button variant="outline" size="sm" onClick={addLink}>
								Add link
							</Button>
						}
					>
						<SectionTitle>Links</SectionTitle>
					</SectionHeader>
					<SectionContent className="pt-0">
						<SectionFields>
							{links.map((link) => (
								<div
									key={link.id}
									className="rounded-md border bg-background p-3"
								>
									<div className="grid gap-3">
										<SectionField label="Label">
											<Input
												value={link.label}
												onChange={(event) =>
													updateLink({
														id: link.id,
														patch: { label: event.currentTarget.value },
													})
												}
												placeholder="TikTok"
											/>
										</SectionField>
										<SectionField label="URL or handle">
											<Input
												value={link.url}
												onChange={(event) =>
													updateLink({
														id: link.id,
														patch: { url: event.currentTarget.value },
													})
												}
												placeholder="https://tiktok.com/@you or @you"
											/>
										</SectionField>
										<div className="flex justify-end">
											<Button
												variant="ghost"
												size="sm"
												onClick={() => removeLink(link.id)}
											>
												Remove
											</Button>
										</div>
									</div>
								</div>
							))}
						</SectionFields>
					</SectionContent>
				</Section>
			</div>
		</PanelView>
	);
}
