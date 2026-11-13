// @vitest-environment jsdom
import { IDBFactory } from 'fake-indexeddb';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockProvider } from '../provider/mock';
import { TEST_LATIN_TERMS } from '../provider/testModel';
import type { ProviderSettings } from '../provider/types';
import { SettingsEntry } from './SettingsEntry';
import { SettingsScreen } from './SettingsScreen';
import { createIdbSettingsStore, createMemorySettingsStore, type SettingsStore } from './store';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const saved: ProviderSettings = {
	clean: { baseUrl: 'http://localhost:11434/v1', model: 'qwen3:8b' },
	textbook: { baseUrl: 'https://openrouter.example/api/v1', apiKey: 'sk-secret', model: 'x/y' },
	enrichment: 'flag-gaps',
};

const goodReply = JSON.stringify({ text: `متن تمیز ${TEST_LATIN_TERMS.join(' ')}` });

let root: Root;
let container: HTMLElement;
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
	container = document.createElement('div');
	document.body.appendChild(container);
	root = createRoot(container);
	fetchSpy = vi.fn(
		async (_url: string, _init?: RequestInit) =>
			new Response(JSON.stringify({ choices: [{ message: { content: goodReply } }] }), { status: 200 }),
	);
	vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
	vi.unstubAllGlobals();
});

async function render(node: React.ReactNode) {
	await act(async () => root.render(node));
	await settle();
}

async function settle() {
	for (let i = 0; i < 5; i++) await act(async () => await new Promise(r => setTimeout(r, 0)));
}

const el = <T extends HTMLElement>(name: string) => container.querySelector<T>(`[name="${name}"]`)!;

async function click(name: string) {
	await act(async () => el(name).click());
	await settle();
}

async function type(name: string, value: string) {
	const input = el<HTMLInputElement>(name);
	const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
	await act(async () => {
		setter.call(input, value);
		input.dispatchEvent(new Event('input', { bubbles: true }));
	});
}

async function choose(name: string, value: string) {
	const select = el<HTMLSelectElement>(name);
	await act(async () => {
		select.value = value;
		select.dispatchEvent(new Event('change', { bubbles: true }));
	});
}

describe('settings screen', () => {
	it('loads saved settings into the form without calling any model', async () => {
		const mock = createMockProvider(goodReply);
		await render(<SettingsScreen store={createMemorySettingsStore(saved)} createProvider={() => mock} />);
		expect(el<HTMLInputElement>('clean-model').value).toBe('qwen3:8b');
		expect(el<HTMLInputElement>('textbook-apiKey').value).toBe('sk-secret');
		expect(el<HTMLInputElement>('textbook-apiKey').type).toBe('password');
		expect(el<HTMLSelectElement>('enrichment').value).toBe('flag-gaps');
		expect(mock.callCount).toBe(0);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('editing and saving writes to the store and never calls a model', async () => {
		const store = createIdbSettingsStore(new IDBFactory());
		await store.save(saved);
		await render(<SettingsScreen store={store} />);
		await type('clean-model', 'llama3.2');
		await type('clean-apiKey', 'sk-local');
		await choose('enrichment', 'light-add');
		await click('save');
		expect(await store.load()).toEqual({
			...saved,
			clean: { ...saved.clean, model: 'llama3.2', apiKey: 'sk-local' },
			enrichment: 'light-add',
		});
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('Test model calls the model only on click, once, at the profile baseUrl, and reports the checks (I6)', async () => {
		await render(<SettingsScreen store={createMemorySettingsStore(saved)} />);
		expect(fetchSpy).not.toHaveBeenCalled();
		await click('textbook-test');
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(String(fetchSpy.mock.calls[0][0])).toBe('https://openrouter.example/api/v1/chat/completions');
		const report = container.querySelector('[data-profile="textbook"] .settings-report')!;
		expect(report.getAttribute('data-ok')).toBe('true');
		expect(report.textContent).toContain('JSON');
		expect(report.textContent).toMatch(/\d+ ms/);
	});

	it('every request from the screen goes to a configured baseUrl', async () => {
		await render(<SettingsScreen store={createMemorySettingsStore(saved)} />);
		await type('clean-baseUrl', 'http://127.0.0.1:9000/v1/');
		await click('clean-test');
		await click('textbook-test');
		const urls = fetchSpy.mock.calls.map(c => String(c[0]));
		expect(urls).toEqual([
			'http://127.0.0.1:9000/v1/chat/completions',
			'https://openrouter.example/api/v1/chat/completions',
		]);
	});

	it('shows the OLLAMA_ORIGINS hint when local Ollama fails at the network level', async () => {
		fetchSpy.mockImplementation(async () => {
			throw new TypeError('Failed to fetch');
		});
		await render(<SettingsScreen store={createMemorySettingsStore(saved)} />);
		await click('clean-test');
		const alert = container.querySelector('[data-profile="clean"] [role="alert"]')!;
		expect(alert.getAttribute('data-kind')).toBe('cors-local');
		expect(alert.textContent).toContain(`OLLAMA_ORIGINS=${location.origin}`);
	});

	it('shows which Latin terms the model dropped', async () => {
		const mock = createMockProvider(JSON.stringify({ text: 'فقط فارسی' }));
		await render(<SettingsScreen store={createMemorySettingsStore(saved)} createProvider={() => mock} />);
		await click('clean-test');
		const report = container.querySelector('[data-profile="clean"] .settings-report')!;
		expect(report.getAttribute('data-ok')).toBe('false');
		expect(report.textContent).toContain('prover');
	});

	it('Test model is disabled until a model is set', async () => {
		await render(<SettingsScreen store={createMemorySettingsStore()} />);
		expect(el<HTMLButtonElement>('clean-test').disabled).toBe(true);
		await type('clean-model', 'qwen3:8b');
		expect(el<HTMLButtonElement>('clean-test').disabled).toBe(false);
	});
});

describe('settings entry', () => {
	it('opens the settings screen on demand and calls no model', async () => {
		const store: SettingsStore = createMemorySettingsStore(saved);
		await render(<SettingsEntry store={store} />);
		expect(container.querySelector('.settings')).toBeNull();
		await click('settings');
		expect(container.querySelector('.settings')).not.toBeNull();
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});
