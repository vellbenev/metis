import type { Enrichment, ProviderProfile, ProviderSettings } from '../provider/types';

// Provider settings (including API keys) live only in browser storage, never in a vault (I5).

export const OLLAMA_DEFAULT_BASE_URL = 'http://localhost:11434/v1';

export const DEFAULT_SETTINGS: ProviderSettings = {
	clean: { baseUrl: OLLAMA_DEFAULT_BASE_URL, model: '' },
	textbook: { baseUrl: OLLAMA_DEFAULT_BASE_URL, model: '' },
	enrichment: 'flag-gaps',
};

export interface SettingsStore {
	load(): Promise<ProviderSettings>;
	save(settings: ProviderSettings): Promise<void>;
}

const enrichments: readonly Enrichment[] = ['off', 'flag-gaps', 'light-add'];

function profileFrom(value: unknown, fallback: ProviderProfile): ProviderProfile {
	const v = (value ?? {}) as Partial<Record<keyof ProviderProfile, unknown>>;
	const profile: ProviderProfile = {
		baseUrl: typeof v.baseUrl === 'string' ? v.baseUrl : fallback.baseUrl,
		model: typeof v.model === 'string' ? v.model : fallback.model,
	};
	if (typeof v.apiKey === 'string' && v.apiKey !== '') profile.apiKey = v.apiKey;
	return profile;
}

/** Fills missing or malformed fields from the defaults. */
export function normaliseSettings(value: unknown): ProviderSettings {
	const v = (value ?? {}) as Partial<Record<keyof ProviderSettings, unknown>>;
	return {
		clean: profileFrom(v.clean, DEFAULT_SETTINGS.clean),
		textbook: profileFrom(v.textbook, DEFAULT_SETTINGS.textbook),
		enrichment: enrichments.includes(v.enrichment as Enrichment)
			? (v.enrichment as Enrichment)
			: DEFAULT_SETTINGS.enrichment,
	};
}

export function createMemorySettingsStore(initial?: ProviderSettings): SettingsStore {
	let stored: ProviderSettings | undefined = initial && structuredClone(initial);
	return {
		async load() {
			return normaliseSettings(stored && structuredClone(stored));
		},
		async save(settings) {
			stored = structuredClone(normaliseSettings(settings));
		},
	};
}

const STORE = 'settings';
const KEY = 'provider';

function request<T>(req: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

export function createIdbSettingsStore(factory: IDBFactory = indexedDB, dbName = 'metis-settings'): SettingsStore {
	let db: Promise<IDBDatabase> | undefined;
	const open = () => {
		db ??= new Promise((resolve, reject) => {
			const req = factory.open(dbName, 1);
			req.onupgradeneeded = () => req.result.createObjectStore(STORE);
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error);
		});
		return db;
	};
	return {
		async load() {
			const tx = (await open()).transaction(STORE, 'readonly');
			return normaliseSettings(await request(tx.objectStore(STORE).get(KEY)));
		},
		async save(settings) {
			const tx = (await open()).transaction(STORE, 'readwrite');
			await request(tx.objectStore(STORE).put(normaliseSettings(settings), KEY));
		},
	};
}
