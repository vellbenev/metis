import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import type { ProviderSettings } from '../provider/types';
import { createIdbSettingsStore, createMemorySettingsStore, DEFAULT_SETTINGS, normaliseSettings } from './store';

const custom: ProviderSettings = {
	clean: { baseUrl: 'http://localhost:11434/v1', model: 'qwen3:8b' },
	textbook: { baseUrl: 'https://openrouter.example/api/v1', apiKey: 'sk-secret', model: 'x/y' },
	enrichment: 'light-add',
};

describe('settings defaults', () => {
	it('default enrichment is flag-gaps', () => {
		expect(DEFAULT_SETTINGS.enrichment).toBe('flag-gaps');
	});

	it('normalise fills missing fields and rejects unknown enrichment values', () => {
		expect(normaliseSettings(undefined)).toEqual(DEFAULT_SETTINGS);
		expect(normaliseSettings({ enrichment: 'everything', clean: { model: 'm', apiKey: '' } })).toEqual({
			...DEFAULT_SETTINGS,
			clean: { ...DEFAULT_SETTINGS.clean, model: 'm' },
		});
	});
});

describe.each([
	['IndexedDB', () => createIdbSettingsStore(new IDBFactory())],
	['memory', () => createMemorySettingsStore()],
])('%s settings store', (_name, make) => {
	it('loads defaults when nothing was saved', async () => {
		expect(await make().load()).toEqual(DEFAULT_SETTINGS);
	});

	it('round-trips both profiles, the API key and enrichment', async () => {
		const store = make();
		await store.save(custom);
		expect(await store.load()).toEqual(custom);
	});

	it('returns copies, not the stored object', async () => {
		const store = make();
		await store.save(custom);
		const loaded = await store.load();
		loaded.textbook.model = 'changed';
		expect((await store.load()).textbook.model).toBe('x/y');
	});
});

describe('IndexedDB persistence (I5)', () => {
	it('settings and API keys persist in IndexedDB across store instances', async () => {
		const factory = new IDBFactory();
		await createIdbSettingsStore(factory).save(custom);
		expect(await createIdbSettingsStore(factory).load()).toEqual(custom);
		expect(await createIdbSettingsStore(factory, 'other-db').load()).toEqual(DEFAULT_SETTINGS);
	});
});
