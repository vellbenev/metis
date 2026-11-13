export interface ProviderProfile {
	baseUrl: string;
	apiKey?: string;
	model: string;
}

export type Enrichment = 'off' | 'flag-gaps' | 'light-add';

export interface ProviderSettings {
	clean: ProviderProfile;
	textbook: ProviderProfile;
	enrichment: Enrichment;
}

export type ProfileName = 'clean' | 'textbook';

export interface ChatMessage {
	role: 'system' | 'user' | 'assistant';
	content: string;
}

export interface ChatRequest {
	messages: ChatMessage[];
	/** Ask the model for a JSON object (`response_format: { type: 'json_object' }`). */
	json?: boolean;
	temperature?: number;
	signal?: AbortSignal;
}

export interface ChatResponse {
	content: string;
}

/** A chat model. Implemented by the OpenAI-compatible client and by the in-process mock. */
export interface Provider {
	complete(request: ChatRequest): Promise<ChatResponse>;
}
