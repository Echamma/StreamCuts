import type { SocialLink } from "@/socials/types";

export function getFilledSocialLinks({ links }: { links: SocialLink[] }) {
	return links.filter(
		(link) => link.label.trim().length > 0 && link.url.trim().length > 0,
	);
}

export function buildSocialDescriptionClipboardText({
	description,
	about,
	links,
}: {
	description: string;
	about: string;
	links: SocialLink[];
}) {
	const sections = [description.trim()];
	const normalizedAbout = about.trim();
	const filledLinks = getFilledSocialLinks({ links });

	if (normalizedAbout) {
		sections.push(`About me:\n${normalizedAbout}`);
	}

	if (filledLinks.length > 0) {
		sections.push(
			`Find me here:\n${filledLinks
				.map((link) => `${link.label.trim()}: ${link.url.trim()}`)
				.join("\n")}`,
		);
	}

	return sections.filter(Boolean).join("\n\n");
}
