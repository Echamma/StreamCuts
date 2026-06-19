import { create } from "zustand";

interface TextEditRequest {
	trackId: string;
	elementId: string;
}

interface TextEditRequestStore {
	pendingRequest: TextEditRequest | null;
	requestTextEdit: (req: TextEditRequest) => void;
	clearRequest: () => void;
}

export const useTextEditRequestStore = create<TextEditRequestStore>((set) => ({
	pendingRequest: null,
	requestTextEdit: (req) => set({ pendingRequest: req }),
	clearRequest: () => set({ pendingRequest: null }),
}));
