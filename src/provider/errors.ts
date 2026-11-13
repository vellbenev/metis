export type ProviderErrorKind =
	| 'cors-local' // network failure against a local server: most likely Ollama without OLLAMA_ORIGINS
	| 'network'
	| 'aborted'
	| 'auth' // 401, 403
	| 'not-found' // 404: wrong baseUrl or unknown model
	| 'rate-limit' // 429
	| 'server' // 5xx
	| 'http' // any other non-2xx status
	| 'bad-response'; // 2xx, but not a chat completion

export class ProviderError extends Error {
	readonly kind: ProviderErrorKind;
	readonly status?: number;

	constructor(kind: ProviderErrorKind, message: string, status?: number) {
		super(message);
		this.name = 'ProviderError';
		this.kind = kind;
		this.status = status;
	}
}

const localHosts = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]']);

/** True for a baseUrl on this machine or on Ollama's default port. */
export function isLocalBaseUrl(baseUrl: string): boolean {
	try {
		const url = new URL(baseUrl);
		return localHosts.has(url.hostname) || url.hostname.startsWith('127.') || url.port === '11434';
	} catch {
		return false;
	}
}

/** Shown when a request to a local server fails at the network level (a CORS rejection looks the same). */
export function ollamaOriginsHint(origin: string): string {
	return `اگر از Ollama استفاده می‌کنید، متغیر OLLAMA_ORIGINS را برابر origin این برنامه بگذارید: OLLAMA_ORIGINS=${origin}`;
}

export function errorFromStatus(status: number, detail: string): ProviderError {
	const suffix = detail ? ` (${detail})` : '';
	if (status === 401 || status === 403) return new ProviderError('auth', `کلید API پذیرفته نشد${suffix}`, status);
	if (status === 404) return new ProviderError('not-found', `آدرس یا model پیدا نشد${suffix}`, status);
	if (status === 429) return new ProviderError('rate-limit', `محدودیت تعداد درخواست${suffix}`, status);
	if (status >= 500) return new ProviderError('server', `خطای سرور (${status})${suffix}`, status);
	return new ProviderError('http', `درخواست ناموفق (${status})${suffix}`, status);
}

export function errorFromFetchFailure(err: unknown, baseUrl: string, origin: string): ProviderError {
	if ((err as { name?: unknown } | null)?.name === 'AbortError') return new ProviderError('aborted', 'درخواست لغو شد');
	if (isLocalBaseUrl(baseUrl)) {
		return new ProviderError('cors-local', `اتصال به ${baseUrl} برقرار نشد. ${ollamaOriginsHint(origin)}`);
	}
	return new ProviderError('network', `اتصال به ${baseUrl} برقرار نشد`);
}
