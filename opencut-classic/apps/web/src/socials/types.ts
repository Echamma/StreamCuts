export type SocialCopyProvider = "gemini" | "fallback";

export interface SocialCopy {
	platform: "tiktok";
	provider: SocialCopyProvider;
	title: string;
	description: string;
}

export interface SocialLink {
	id: string;
	label: string;
	url: string;
}
