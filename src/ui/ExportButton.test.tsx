// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MarkdownFile } from '../export/markdown';
import { downloadFile, ExportButton } from './ExportButton';

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
	vi.restoreAllMocks();
});

const press = async () => {
	await act(async () => container.querySelector<HTMLButtonElement>('.export-button')!.click());
};
const file: MarkdownFile = { fileName: 'مبانی.md', markdown: 'می‌خواهیم zk-SNARK\n' };

describe('ExportButton', () => {
	it('downloads the file the action returns', async () => {
		const download = vi.fn();
		act(() => root.render(<ExportButton label='خروجی' run={async () => file} download={download} />));
		await press();
		expect(download).toHaveBeenCalledWith(file);
		expect(container.querySelector('[role=status]')).toBeNull();
	});

	it('says so when there is nothing to export', async () => {
		const download = vi.fn();
		act(() => root.render(<ExportButton label='خروجی' empty='هنوز نیست' run={async () => undefined} download={download} />));
		await press();
		expect(download).not.toHaveBeenCalled();
		expect(container.querySelector('[role=status]')?.textContent).toBe('هنوز نیست');
	});

	it('shows an error instead of throwing', async () => {
		act(() => root.render(<ExportButton label='خروجی' run={async () => Promise.reject(new Error('x'))} download={vi.fn()} />));
		await press();
		expect(container.querySelector('[role=status]')?.textContent).toContain('x');
	});
});

describe('downloadFile', () => {
	it('hands the browser a UTF-8 Markdown blob with the file name, without fetch', async () => {
		const blobs: Blob[] = [];
		URL.createObjectURL = vi.fn((b: Blob) => (blobs.push(b), 'blob:x'));
		URL.revokeObjectURL = vi.fn();
		const fetchSpy = vi.fn();
		vi.stubGlobal('fetch', fetchSpy);
		const clicked: HTMLAnchorElement[] = [];
		vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
			clicked.push(this);
		});
		downloadFile(file);
		expect(clicked[0].download).toBe(file.fileName);
		expect(clicked[0].href).toBe('blob:x');
		expect(blobs[0].type).toBe('text/markdown;charset=utf-8');
		expect(await blobs[0].text()).toBe(file.markdown);
		expect(fetchSpy).not.toHaveBeenCalled();
		vi.unstubAllGlobals();
	});
});
