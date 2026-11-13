// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockProvider } from '../provider/mock';
import type { ChatRequest, ProviderProfile } from '../provider/types';
import { createMemorySettingsStore, DEFAULT_SETTINGS } from '../settings/store';
import { memoryVault } from '../vault/backends';
import type { CleanNote } from '../vault/types';
import { buildVaultTextbook, loadVaultTextbook, undoVaultTextbook, vaultStaleCount } from './textbookAction';
import { TextbookControl } from './TextbookControl';
import { TextbookView } from './TextbookView';

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

const reply = (req: ChatRequest) => {
	const inp = JSON.parse(req.messages[1].content);
	if (req.messages[0].content.includes('outline (table of contents)')) {
		return JSON.stringify({ ops: inp.files.map((f: { fileId: string }) => ({ op: 'add', title: `بخش ${f.fileId}`, files: [f.fileId] })) });
	}
	return JSON.stringify({
		blocks: [{ type: 'paragraph', text: 'prover <ai>به verifier</ai> اثبات <gap>؟</gap> می‌دهد' }],
		gaps: ['soundness تعریف نشده'],
	});
};

const twin = (fileId: string, revision: number): CleanNote => ({
	version: 1,
	fileId,
	revision,
	doc: {
		type: 'doc',
		content: [
			{ type: 'paragraph', attrs: { id: 'c1', sources: ['r1'], changedIn: revision }, content: [{ type: 'text', text: 'prover اثبات می‌دهد', marks: [{ type: 'rewrite' }] }] },
		],
	},
});

async function setup() {
	const vault = await memoryVault('ZKP');
	await vault.derived.saveClean(twin('f1', 1));
	await vault.derived.saveClean(twin('f2', 1));
	const mock = createMockProvider(reply);
	const textbookProfile: ProviderProfile = { baseUrl: 'http://localhost:11434/v1', model: 'textbook-model' };
	const settings = createMemorySettingsStore({ ...DEFAULT_SETTINGS, textbook: textbookProfile, enrichment: 'light-add' });
	const createProvider = vi.fn((_: ProviderProfile) => mock);
	const onShow = vi.fn();
	const render = (refreshKey = 0) =>
		act(async () =>
			root.render(
				<TextbookControl
					refreshKey={refreshKey}
					count={() => vaultStaleCount(vault)}
					build={() => buildVaultTextbook(vault, settings, createProvider)}
					undo={() => undoVaultTextbook(vault)}
					onShow={onShow}
				/>,
			),
		);
	return { vault, mock, createProvider, onShow, render };
}

const q = (sel: string) => container.querySelector<HTMLElement>(sel);
async function settle() {
	for (let i = 0; i < 8; i++) await act(async () => await new Promise(r => setTimeout(r, 0)));
}
async function click(name: string) {
	await act(async () => q(`[name="${name}"]`)!.click());
	await settle();
}

describe('Textbook control', () => {
	it('shows a quiet stale count, does nothing until pressed, then builds with the textbook profile', async () => {
		const { vault, mock, createProvider, onShow, render } = await setup();
		const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
		await render();
		await settle();
		expect(mock.callCount).toBe(0);
		expect(q('.textbook-stale')?.textContent).toBe('۲');

		await click('textbook');
		expect(createProvider).toHaveBeenCalledWith({ baseUrl: 'http://localhost:11434/v1', model: 'textbook-model' });
		expect(mock.callCount).toBe(3);
		expect(q('.textbook-stale')).toBeNull();
		expect(q('[role="status"]')?.textContent).toContain('جزوه به‌روز شد');
		expect(onShow).toHaveBeenLastCalledWith(expect.objectContaining({ changed: true }));

		// A clean elsewhere bumps the refresh key; the count follows without any model call.
		await vault.derived.saveClean(twin('f2', 2));
		await render(1);
		await settle();
		expect(q('.textbook-stale')?.textContent).toBe('۱');
		expect(mock.callCount).toBe(3);

		// Never a popup.
		expect(alert).not.toHaveBeenCalled();
		expect(document.querySelector('[role="dialog"], [role="alert"], dialog')).toBeNull();
		alert.mockRestore();
	});

	it('undo restores the state before the last build', async () => {
		const { vault, render } = await setup();
		await render();
		await click('textbook');
		expect(await vault.derived.loadOutline()).toBeDefined();
		await click('textbook-undo');
		expect(await vault.derived.loadOutline()).toBeUndefined();
		expect(q('.textbook-stale')?.textContent).toBe('۲');
	});

	it('reports a provider error without throwing', async () => {
		const { vault } = await setup();
		await act(async () =>
			root.render(
				<TextbookControl
					count={() => vaultStaleCount(vault)}
					build={() => Promise.reject(new Error('offline'))}
					undo={() => undoVaultTextbook(vault)}
					onShow={() => {}}
				/>,
			),
		);
		await click('textbook');
		expect(q('[role="status"]')?.textContent).toContain('offline');
		expect((q('[name="textbook"]') as HTMLButtonElement).hasAttribute('disabled')).toBe(false);
	});
});

describe('Textbook view', () => {
	it('shows sections in outline order, highlights what the build changed, marks aiAdded and lists gaps', async () => {
		const { vault, createProvider } = await setup();
		const report = await buildVaultTextbook(vault, createMemorySettingsStore({ ...DEFAULT_SETTINGS, enrichment: 'light-add' }), createProvider);
		await act(async () => root.render(<TextbookView load={() => loadVaultTextbook(vault)} report={report} version={1} />));
		await settle();
		const sections = [...container.querySelectorAll('.textbook-section')];
		expect(sections.map(s => s.querySelector('h2')?.textContent)).toEqual(['بخش f1', 'بخش f2']);
		expect(sections.every(s => s.classList.contains('changed'))).toBe(true);
		expect(q('.ai-added')?.textContent).toBe('به verifier');
		expect(q('.gap')?.textContent).toBe('؟');
		expect(container.querySelectorAll('.textbook-gaps li')).toHaveLength(4);
		expect(q('.textbook-gaps')?.textContent).toContain('soundness تعریف نشده');

		await act(async () => root.render(<TextbookView load={() => loadVaultTextbook(vault)} version={2} />));
		await settle();
		expect(container.querySelectorAll('.textbook-section.changed')).toHaveLength(0);
	});
});
