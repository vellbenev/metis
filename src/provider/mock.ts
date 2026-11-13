import type { ChatRequest, ChatResponse, Provider } from './types';

export type MockReply = string | ((request: ChatRequest, callIndex: number) => string | Promise<string>);

export interface MockProvider extends Provider {
	/** Every request received, in order. */
	readonly calls: ChatRequest[];
	readonly callCount: number;
	reset(): void;
}

/**
 * In-process provider for tests: no network, counts calls (I3).
 * `reply` is a fixed string or a function of the request; throw from it to simulate a failure.
 */
export function createMockProvider(reply: MockReply = '{}'): MockProvider {
	const calls: ChatRequest[] = [];
	return {
		calls,
		get callCount() {
			return calls.length;
		},
		reset() {
			calls.length = 0;
		},
		async complete(request: ChatRequest): Promise<ChatResponse> {
			const index = calls.length;
			calls.push(request);
			const content = typeof reply === 'string' ? reply : await reply(request, index);
			return { content };
		},
	};
}
