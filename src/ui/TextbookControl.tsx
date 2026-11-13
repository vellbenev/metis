import { useEffect, useRef, useState } from 'react';
import type { TextbookReport } from '../textbook/build';

const fa = (n: number) => n.toLocaleString('fa-IR');

function summary(report: TextbookReport): string {
	const parts = [report.changed ? `جزوه به‌روز شد (${fa(report.regenerated.length)} بخش)` : 'چیز تازه‌ای برای جزوه نبود'];
	if (report.outlineError) parts.push('فهرست جزوه تغییر نکرد؛ دوباره امتحان کنید');
	if (report.failed.length > 0) parts.push(`${fa(report.failed.length)} بخش ساخته نشد و دست‌نخورده ماند`);
	return parts.join('. ');
}

export interface TextbookControlProps {
	/** Files whose clean twin is newer than the textbook. */
	count(): Promise<number>;
	build(): Promise<TextbookReport>;
	undo(): Promise<boolean>;
	/** Shows the textbook; `report` is set right after a build, for highlighting. */
	onShow(report?: TextbookReport): void;
	/** Changes when a clean may have changed the count. */
	refreshKey?: unknown;
}

/** The quiet vault-level Textbook control: build only when pressed, a stale count, never a popup. */
export function TextbookControl({ count, build, undo, onShow, refreshKey }: TextbookControlProps) {
	const [stale, setStale] = useState<number>();
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState<string>();

	const countRef = useRef(count);
	countRef.current = count;
	const refresh = () => countRef.current().then(setStale, () => setStale(undefined));
	useEffect(() => {
		void countRef.current().then(setStale, () => setStale(undefined));
	}, [refreshKey]);

	async function act(run: () => Promise<void>) {
		setBusy(true);
		setMessage(undefined);
		try {
			await run();
		} catch (e) {
			setMessage(`جزوه ساخته نشد: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			setBusy(false);
			void refresh();
		}
	}

	return (
		<div className='textbook-control'>
			<button
				type='button'
				name='textbook'
				disabled={busy}
				onClick={() =>
					act(async () => {
						const report = await build();
						setMessage(summary(report));
						onShow(report);
					})
				}
			>
				{busy ? 'در حال ساخت جزوه…' : 'جزوه'}
			</button>
			{stale !== undefined && stale > 0 && (
				<span className='textbook-stale' title={`${fa(stale)} فایل تازه‌تر از جزوه`} aria-label={`${fa(stale)} فایل تازه‌تر از جزوه`}>
					{fa(stale)}
				</span>
			)}
			<button type='button' name='textbook-show' disabled={busy} onClick={() => onShow()}>
				نمایش
			</button>
			<button
				type='button'
				name='textbook-undo'
				disabled={busy}
				onClick={() =>
					act(async () => {
						setMessage((await undo()) ? 'ساخت قبلی جزوه برگردانده شد' : 'چیزی برای برگرداندن نیست');
						onShow();
					})
				}
			>
				برگرداندن
			</button>
			{message && (
				<span className='textbook-status' role='status'>
					{message}
				</span>
			)}
		</div>
	);
}
