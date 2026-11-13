// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockProvider } from '../provider/mock';
import type { ChatRequest } from '../provider/types';
import { createMemorySettingsStore, DEFAULT_SETTINGS } from '../settings/store';
import { memoryVault } from '../vault/backends';
import { CleanButton } from './CleanButton';
import { cleanNote } from './cleanAction';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLElement;

beforeEach(() => {
	container = document.createElement('div');
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
});

const echo = (req: ChatRequest) =>
	JSON.stringify({
		blocks: JSON.parse(req.messages[1].content).blocks.map((b: { id: string; text: string }) => ({
			type: 'paragraph',
			text: b.text,
			sources: [b.id],
		})),
	});

async function setup() {
	const vault = await memoryVault('ZKP');
	const note = await vault.createNote([], 'n');
	await vault.saveNote(['n'], {
		...note,
		doc: { type: 'doc', content: [{ type: 'paragraph', attrs: { id: 'p1' }, content: [{ type: 'text', text: 'یک' }] }] },
	});
	const mock = createMockProvider(echo);
	const settings = createMemorySettingsStore({ ...DEFAULT_SETTINGS, enrichment: 'off' });
	return { vault, note, mock, run: () => cleanNote(vault, ['n'], settings, () => mock) };
}

const button = () => container.querySelector<HTMLButtonElement>('[name="clean"]')!;
const status = () => container.querySelector('[role="status"]')?.textContent ?? '';

async function press() {
	await act(async () => button().click());
	for (let i = 0; i < 5; i++) await act(async () => await new Promise(r => setTimeout(r, 0)));
}

describe('Clean button', () => {
	it('does nothing until pressed, then stores the clean twin under .metis/', async () => {
		const { vault, note, mock, run } = await setup();
		await act(async () => root.render(<CleanButton run={run} />));
		expect(mock.callCount).toBe(0);
		await press();
		expect(mock.callCount).toBe(1);
		const clean = await vault.derived.loadClean(note.fileId);
		expect(clean?.revision).toBe(1);
		expect(clean?.doc.content?.[0].attrs?.sources).toEqual(['p1']);
		expect(status()).toContain('۱');

		await press();
		expect(mock.callCount).toBe(1);
		expect(status()).toBe('چیز تازه‌ای برای پاک‌نویس نبود');
	});

	it('passes the settings enrichment and the vault rewrite level to the prompt', async () => {
		const { mock, run } = await setup();
		await run();
		expect(mock.calls[0].messages[0].content).toContain('Rewrite level structure');
		expect(mock.calls[0].messages[0].content).toContain('Do not use <ai> tags');
		expect(mock.calls[0].json).toBe(true);
	});

	it('reports failed batches and errors without throwing', async () => {
		const run = vi
			.fn()
			.mockResolvedValueOnce({ changed: false, revision: 0, modelCalls: 2, failed: [{ blockIds: ['p1'], error: 'x' }] })
			.mockRejectedValueOnce(new Error('boom'));
		await act(async () => root.render(<CleanButton run={run} />));
		await press();
		expect(status()).toContain('دست‌نخورده');
		await press();
		expect(status()).toContain('boom');
		expect(button().disabled).toBe(false);
	});
});
