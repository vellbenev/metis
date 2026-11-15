import { useState } from 'react';
import type { MarkdownFile } from '../export/markdown';

/** Hands a file to the browser as a download. Nothing is written to the vault. */
export function downloadFile(file: MarkdownFile): void {
	const url = URL.createObjectURL(new Blob([file.markdown], { type: 'text/markdown;charset=utf-8' }));
	const a = document.createElement('a');
	a.href = url;
	a.download = file.fileName;
	document.body.appendChild(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 1000); // revoking at once can cancel the download
}

export interface ExportButtonProps {
	label: string;
	/** The file to download, or undefined when there is nothing to export yet. */
	run(): Promise<MarkdownFile | undefined> | MarkdownFile | undefined;
	/** Shown when `run` returns undefined. */
	empty?: string;
	download?(file: MarkdownFile): void;
}

/** A quiet Markdown export action. */
export function ExportButton({ label, run, empty = 'چیزی برای خروجی نیست.', download = downloadFile }: ExportButtonProps) {
	const [message, setMessage] = useState<string>();

	async function press() {
		setMessage(undefined);
		try {
			const file = await run();
			if (file) download(file);
			else setMessage(empty);
		} catch (e) {
			setMessage(`خروجی گرفته نشد: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	return (
		<span className='export-bar'>
			<button type='button' className='export-button' onClick={press}>
				{label}
			</button>
			{message && (
				<span className='export-status' role='status'>
					{message}
				</span>
			)}
		</span>
	);
}
