// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { memoryVault } from '../vault/backends';
import type { VaultStore } from '../vault/store';
import { FileTree } from './FileTree';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLElement;
afterEach(() => {
	act(() => root?.unmount());
	host?.remove();
});

async function render(store: VaultStore, props: Partial<Parameters<typeof FileTree>[0]> = {}) {
	host = document.createElement('div');
	document.body.append(host);
	root = createRoot(host);
	const onOpen = vi.fn();
	await act(async () => root!.render(<FileTree store={store} onOpen={onOpen} {...props} />));
	return { onOpen };
}

const texts = (selector: string) => [...host.querySelectorAll(selector)].map(e => e.textContent);
const button = (label: string, within: ParentNode = host) =>
	[...within.querySelectorAll('button')].find(b => b.textContent === label || b.title === label)!;

async function typeAndSubmit(value: string) {
	const input = host.querySelector('input')!;
	await act(async () => {
		const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
		setter.call(input, value);
		input.dispatchEvent(new Event('input', { bubbles: true }));
	});
	await act(async () => {
		input.form!.requestSubmit();
	});
	await act(async () => {}); // let the store call and refresh settle
}

describe('FileTree', () => {
	it('shows the vault tree, folders before notes', async () => {
		const store = await memoryVault('ZKP');
		await store.createFolder([], 'مبانی');
		await store.createNote(['مبانی'], 'جلسه‌ی اول');
		await store.createNote([], 'آزاد');
		await render(store);
		expect(host.querySelector('nav')!.textContent).toContain('ZKP');
		expect(texts('.tree-name')).toEqual(['مبانی']);
		expect(texts('.tree-note')).toEqual(['جلسه‌ی اول', 'آزاد']);
	});

	it('creates folders and notes through the store and opens the new note', async () => {
		const store = await memoryVault('ZKP');
		const { onOpen } = await render(store);
		await act(async () => button('پوشه‌ی تازه').click());
		await typeAndSubmit('zkp');
		expect(texts('.tree-name')).toEqual(['zkp']);

		const folder = host.querySelector('.tree-folder:not(.tree-root)')!;
		await act(async () => button('یادداشت تازه', folder).click());
		await typeAndSubmit('basics');
		expect(texts('.tree-note')).toEqual(['basics']);
		expect(onOpen).toHaveBeenCalledWith(['zkp', 'basics']);
		expect((await store.loadNote(['zkp', 'basics'])).title).toBe('basics');
	});

	it('opens a note on click and renames it on double click', async () => {
		const store = await memoryVault('ZKP');
		await store.createNote([], 'old');
		const beforeChange = vi.fn();
		const afterChange = vi.fn();
		const onMoved = vi.fn();
		const { onOpen } = await render(store, { beforeChange, afterChange, onMoved, activePath: ['old'] });
		const note = host.querySelector('.tree-note')!;
		expect(note.getAttribute('aria-current')).toBe('page');
		await act(async () => (note as HTMLElement).click());
		expect(onOpen).toHaveBeenCalledWith(['old']);

		await act(async () => note.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
		await typeAndSubmit('new');
		expect(beforeChange).toHaveBeenCalled();
		expect(onMoved).toHaveBeenCalledWith(['old'], ['new']);
		expect(afterChange).toHaveBeenCalledTimes(1);
		expect(texts('.tree-note')).toEqual(['new']);
	});

	it('shows store errors quietly instead of throwing', async () => {
		const store = await memoryVault('ZKP');
		await store.createFolder([], 'f');
		await render(store);
		await act(async () => button('پوشه‌ی تازه').click());
		await typeAndSubmit('f');
		expect(host.querySelector('[role=alert]')!.textContent).toMatch(/already exists/);
	});

	it('resumes autosave even when a rename fails', async () => {
		const store = await memoryVault('ZKP');
		await store.createNote([], 'a');
		await store.createNote([], 'b');
		const afterChange = vi.fn();
		const onMoved = vi.fn();
		await render(store, { afterChange, onMoved });
		await act(async () =>
			host.querySelector('.tree-note')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })),
		);
		await typeAndSubmit('b');
		expect(host.querySelector('[role=alert]')!.textContent).toMatch(/already exists/);
		expect(afterChange).toHaveBeenCalledTimes(1);
		expect(onMoved).not.toHaveBeenCalled();
	});

	it('keeps ZWNJ in names and lets Latin names set their own direction', async () => {
		const store = await memoryVault('ZKP');
		await store.createFolder([], 'درس‌ها');
		await store.createNote(['درس‌ها'], 'zk-SNARK');
		await render(store);
		expect(texts('.tree-name')).toEqual(['درس‌ها']);
		expect(texts('.tree-note')).toEqual(['zk-SNARK']);
		for (const el of host.querySelectorAll('.tree-name, .tree-note')) expect(el.getAttribute('dir')).toBe('auto');
	});

	it('warns about notes that share a fileId', async () => {
		const store = await memoryVault('ZKP');
		const note = await store.createNote([], 'a');
		await store.saveNote(['b'], note); // a duplicate, as a crash during a rename could leave
		await render(store);
		const warning = host.querySelector('[role=status]')!;
		expect(warning.textContent).toContain('a');
		expect(warning.textContent).toContain('b');
		expect(texts('.tree-note')).toEqual(['a', 'b']);
	});
});
