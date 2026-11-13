// Bidi isolation for mixed Persian/Latin text in an RTL page: each Latin run (a URL, a model name,
// "OLLAMA_ORIGINS=http://...", a few English words) is wrapped in <bdi dir="ltr"> so its punctuation
// and digits stay in order and do not reorder the Persian around it.

import { Fragment, type ReactNode } from 'react';

export type BidiSegment = { text: string; ltr: boolean };

const STRONG = '\\p{Script=Latin}0-9';
/**
 * A Latin run starts with a Latin letter or digit and ends with one (or `/`, for URLs); inside, it may
 * hold spaces and ASCII punctuation, so "chat completion" or "http://localhost:11434/v1" stay one run.
 * A `.` right before the first letter at the start of a word (.NET), and `+` or `#` right after the
 * last one (C++, C#), belong to the run.
 */
const RUN = new RegExp(`(?:(?<!\\S)\\.)?[${STRONG}](?:[${STRONG} !-/:-@[-\`{-~]*[${STRONG}/])?(?:(?<=[${STRONG}])[+#]+)?`, 'gu');

/** Splits text into Latin (ltr) and other segments, in order; joined, they give the text back. */
export function splitLatinRuns(text: string): BidiSegment[] {
	const out: BidiSegment[] = [];
	let last = 0;
	for (const m of text.matchAll(RUN)) {
		if (m.index > last) out.push({ text: text.slice(last, m.index), ltr: false });
		out.push({ text: m[0], ltr: true });
		last = m.index + m[0].length;
	}
	if (last < text.length) out.push({ text: text.slice(last), ltr: false });
	return out;
}

/** Text with every Latin run isolated in <bdi dir="ltr">. */
export function Bidi({ text }: { text: string }): ReactNode {
	return splitLatinRuns(text).map((s, i) =>
		s.ltr ? (
			<bdi key={i} dir='ltr'>
				{s.text}
			</bdi>
		) : (
			<Fragment key={i}>{s.text}</Fragment>
		),
	);
}
