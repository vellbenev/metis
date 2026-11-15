import { Fragment, useState } from 'react';
import type { CleanReport } from '../clean/clean';

const fa = (n: number) => n.toLocaleString('fa-IR');

function summary(report: CleanReport): string {
	const parts = [report.changed ? `پاک‌نویس به‌روز شد (نسخه‌ی ${fa(report.revision)})` : 'چیز تازه‌ای برای پاک‌نویس نبود'];
	if (report.failed.length > 0) {
		parts.push(`${fa(report.failed.length)} بخش پاک‌نویس نشد و دست‌نخورده ماند؛ دوباره امتحان کنید`);
	}
	return parts.join('. ');
}

/** Latin terms the clean could not keep, without case-insensitive repeats, in report order. */
export function unresolvedTermList(report: CleanReport): string[] {
	const out = new Map<string, string>();
	for (const { terms } of report.unresolvedTerms ?? []) {
		for (const term of terms) if (!out.has(term.toLowerCase())) out.set(term.toLowerCase(), term);
	}
	return [...out.values()];
}

/** The per-file Clean button. Runs the clean only when pressed (no automatic AI). */
export function CleanButton({ run }: { run(): Promise<CleanReport> }) {
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState<string>();
	const [report, setReport] = useState<CleanReport>();

	async function press() {
		setBusy(true);
		setMessage(undefined);
		setReport(undefined);
		try {
			const result = await run();
			setReport(result);
			setMessage(summary(result));
		} catch (e) {
			setMessage(`پاک‌نویس انجام نشد: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			setBusy(false);
		}
	}

	const terms = report ? unresolvedTermList(report) : [];
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
			{report && report.failed.length > 0 && (
				<ul className='clean-failed'>
					{report.failed.map((f, i) => (
						<li key={i}>
							دلیل: <bdi dir='ltr'>{f.error}</bdi>
						</li>
					))}
				</ul>
			)}
			{terms.length > 0 && (
				<span className='clean-terms'>
					واژه‌های لاتینی که در پاک‌نویس نماند:{' '}
					{terms.map((t, i) => (
						<Fragment key={t}>
							{i > 0 && '، '}
							<bdi dir='ltr'>{t}</bdi>
						</Fragment>
					))}
				</span>
			)}
		</div>
	);
}
