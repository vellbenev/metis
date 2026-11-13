// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runClean } from '../clean/clean';
import type { BlockRef } from '../cleanView/model';
import { canonicalHash, type JSONNode } from '../core/blocks';
import { createMockProvider } from '../provider/mock';
import type { ChatRequest } from '../provider/types';
import { MemoryDir, type Dir } from '../vault/dir';
import { createVault, type VaultStore } from '../vault/store';
import { CleanPane, type CleanPaneProps } from './CleanPane';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLElement;
let dir: MemoryDir;
let vault: VaultStore;
let fileId: string;

/** Raw blocks r1 and r2 merge into one clean block; r3 gets its own, with an aiAdded and a gap span. */
const model = (req: ChatRequest) => {
	const ids: string[] = JSON.parse(req.messages[1].content).blocks.map((b: { id: string }) => b.id);
	const blocks = [];
	if (ids.includes('r1')) blocks.push({ type: 'paragraph', text: 'اثبات دانش صفر', sources: ['r1', 'r2'] });
	if (ids.includes('r3'))
		blocks.push({ type: 'paragraph', text: 'یک <ai>افزوده</ai> و <gap>مبهم</gap>', sources: ['r3'] });
	if (ids.includes('r4')) blocks.push({ type: 'paragraph', text: 'تازه', sources: ['r4'] });
	return JSON.stringify({ blocks });
};

const para = (id: string, text: string): JSONNode => ({
	type: 'paragraph',
	attrs: { id },
	content: [{ type: 'text', text }],
});

async function write(content: JSONNode[]) {
	const note = await vault.loadNote(['n']);
	await vault.saveNote(['n'], { ...note, doc: { type: 'doc', content } });
}
const clean = () =>
	runClean(
		{ notes: { loadNote: p => vault.loadNote(p) }, derived: vault.derived, provider: createMockProvider(model) },
		['n'],
		{ rewriteLevel: 'structure', enrichment: 'light-add' },
	);

async function files(d: Dir, prefix = ''): Promise<Map<string, string>> {
	const out = new Map<string, string>();
	for (const entry of await d.list()) {
		const path = prefix + entry.name;
		if (entry.kind === 'file') out.set(path, (await d.readFile(entry.name))!);
		else for (const [p, t] of await files((await d.getDir(entry.name))!, `${path}/`)) out.set(p, t);
	}
	return out;
}
const allFiles = () => files(dir);
const rawHashes = async () =>
	Promise.all(
		[...(await allFiles())]
			.filter(([p]) => p.startsWith('notes/'))
			.map(([, t]) => canonicalHash({ type: 'f', text: t })),
	);

beforeEach(async () => {
	container = document.createElement('div');
	document.body.appendChild(container);
	root = createRoot(container);
	dir = new MemoryDir();
	vault = await createVault(dir, 'ZKP');
	fileId = (await vault.createNote([], 'n')).fileId;
	await write([para('r1', 'اثبات'), para('r2', 'دانش صفر'), para('r3', 'یک')]);
	await clean();
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
});

const flush = () =>
	act(async () => {
		for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0));
	});

async function render(props: Partial<CleanPaneProps> = {}) {
	const full: CleanPaneProps = { derived: vault.derived, fileId, onSelect: () => {}, ...props };
	act(() => root.render(<CleanPane {...full} />));
	await flush();
	return (next: Partial<CleanPaneProps>) => act(() => root.render(<CleanPane {...full} {...next} />));
}

const $ = (sel: string) => container.querySelector<HTMLElement>(sel);
const $$ = (sel: string) => [...container.querySelectorAll<HTMLElement>(sel)];
const blocks = () => $$('[data-clean-id]');
const click = async (el: HTMLElement) => {
	act(() => el.click());
	await flush();
};

describe('CleanPane', () => {
	it('shows the clean twin RTL with one element per clean block', async () => {
		await render();
		expect($('.clean-pane')?.getAttribute('dir')).toBe('rtl');
		expect(blocks().map(b => b.textContent)).toEqual(['اثبات دانش صفر', expect.stringContaining('یک افزوده')]);
	});

	it('clicking a clean block selects it and reports its source raw blocks', async () => {
		const onSelect = vi.fn();
		const onLinkedRaw = vi.fn();
		const rerender = await render({ onSelect, onLinkedRaw });
		await click(blocks()[0]);
		expect(onSelect).toHaveBeenCalledWith({ side: 'clean', id: blocks()[0].dataset.cleanId });

		const ref: BlockRef = { side: 'clean', id: blocks()[0].dataset.cleanId! };
		rerender({ selected: ref, onLinkedRaw });
		await flush();
		expect(onLinkedRaw).toHaveBeenLastCalledWith(['r1', 'r2'], true);
		expect(blocks()[0].classList.contains('linked')).toBe(true);
		expect(blocks()[1].classList.contains('linked')).toBe(false);
	});

	it('a selected raw block highlights its clean counterpart', async () => {
		const onLinkedRaw = vi.fn();
		await render({ selected: { side: 'raw', id: 'r2' }, onLinkedRaw });
		expect(blocks().map(b => b.classList.contains('linked'))).toEqual([true, false]);
		expect(onLinkedRaw).toHaveBeenLastCalledWith(['r2'], false);
	});

	it('highlights blocks changed in the last clean; dismiss is UI state and writes nothing', async () => {
		await write([para('r1', 'اثبات'), para('r2', 'دانش صفر'), para('r3', 'یک'), para('r4', 'چهار')]);
		await clean();
		await render();
		expect(blocks().map(b => b.classList.contains('changed'))).toEqual([false, false, true]);

		const before = await allFiles();
		await click($('[name="dismiss-highlights"]')!);
		expect($$('.changed')).toHaveLength(0);
		expect($('[name="dismiss-highlights"]')).toBeNull();
		expect(await allFiles()).toEqual(before); // nothing stored, raw untouched (I1)
	});

	it('I4: aiAdded is visually distinct until accepted; accept and remove are one click and persisted', async () => {
		const hashes = await rawHashes();
		const onChanged = vi.fn();
		await render({ onChanged });
		expect($$('.ai-added').map(s => s.firstChild?.textContent)).toEqual(['افزوده']);

		await click($('[name="ai-accept"]')!);
		expect($$('.ai-added')).toHaveLength(0);
		expect(blocks()[1].textContent).toContain('افزوده');
		expect(JSON.stringify(await vault.derived.loadClean(fileId))).toContain('"accepted":true');
		expect(onChanged).toHaveBeenCalled();

		// Undo the clean, clean again: the span is back, unaccepted; then remove it.
		await click($('[name="undo-clean"]')!);
		await clean();
		act(() => root.render(<CleanPane derived={vault.derived} fileId={fileId} version={2} onSelect={() => {}} />));
		await flush();
		expect($$('.ai-added')).toHaveLength(1);
		await click($('[name="ai-remove"]')!);
		expect(blocks()[1].textContent).not.toContain('افزوده');
		expect(JSON.stringify(await vault.derived.loadClean(fileId))).not.toContain('افزوده');
		expect(await rawHashes()).toEqual(hashes);
	});

	it('lists gaps with a link to their block', async () => {
		const onSelect = vi.fn();
		await render({ onSelect });
		const items = $$('.clean-gaps button');
		expect(items.map(b => b.textContent)).toEqual(['مبهم']);
		await click(items[0]);
		expect(onSelect).toHaveBeenCalledWith({ side: 'clean', id: blocks()[1].dataset.cleanId });
	});

	it('undo restores the previous clean exactly and is disabled when nothing is left', async () => {
		const before = await allFiles();
		await write([para('r1', 'اثبات'), para('r2', 'دانش صفر'), para('r3', 'یک'), para('r4', 'چهار')]);
		const raw = await allFiles();
		await clean();
		await render();
		expect(blocks()).toHaveLength(3);
		await click($('[name="undo-clean"]')!);
		expect(blocks()).toHaveLength(2);
		const after = await allFiles();
		for (const [p, t] of after) if (p.startsWith('.metis/')) expect(t, p).toBe(before.get(p));
		for (const [p, t] of raw) if (p.startsWith('notes/')) expect(after.get(p), p).toBe(t);

		await click($('[name="undo-clean"]')!);
		expect(blocks()).toHaveLength(0);
		expect($('.clean-empty')).not.toBeNull();
	});
});
