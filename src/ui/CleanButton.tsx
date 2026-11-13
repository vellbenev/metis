import { useState } from 'react';
import type { CleanReport } from '../clean/clean';

const fa = (n: number) => n.toLocaleString('fa-IR');

function summary(report: CleanReport): string {
	const parts = [report.changed ? `پاک‌نویس به‌روز شد (نسخه‌ی ${fa(report.revision)})` : 'چیز تازه‌ای برای پاک‌نویس نبود'];
	if (report.failed.length > 0) {
		parts.push(`${fa(report.failed.length)} بخش پاک‌نویس نشد و دست‌نخورده ماند؛ دوباره امتحان کنید`);
	}
	return parts.join('. ');
}

/** The per-file Clean button. Runs the clean only when pressed (no automatic AI). */
export function CleanButton({ run }: { run(): Promise<CleanReport> }) {
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState<string>();

	async function press() {
		setBusy(true);
		setMessage(undefined);
		try {
			setMessage(summary(await run()));
		} catch (e) {
			setMessage(`پاک‌نویس انجام نشد: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className='clean-bar'>
			<button type='button' name='clean' className='clean-button' disabled={busy} onClick={press}>
				{busy ? 'در حال پاک‌نویس…' : 'پاک‌نویس'}
			</button>
			{message && (
				<span className='clean-status' role='status'>
					{message}
				</span>
			)}
		</div>
	);
}
