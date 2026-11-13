// Deterministic Persian normalisation (SPEC 6.1, I8). Pure: same input, same output, no I/O.
// Applied to a copy of the raw doc before hashing and before the model; never to the raw note itself.
// Latin text, URLs and code (code marks, code blocks, `backtick` spans) are never modified.

import type { JSONNode } from './blocks';

const ZWNJ = '‌';
/** Any character of the Arabic script blocks (letters, digits, punctuation). */
const ARABIC_CHAR = /[؀-ۿﭐ-﷿ﹰ-﻿]/u;
/** A letter of the Arabic script (Persian letters included). */
const FA_LETTER = '(?:(?=\\p{L})\\p{sc=Arabic})';
const faLetter = new RegExp(`^${FA_LETTER}$`, 'u');
const latinAlnum = /^[A-Za-z0-9]$/;

/** Spans left exactly as they are: URLs and `code`. */
const PROTECTED = /(?:https?:\/\/|www\.)\S+|`[^`]*`/gu;

// Only unambiguous forms. ای, ام, ات, اش are also words of their own (vocative ای, ...), so joining
// them is left to the clean prompt.
const SUFFIXES = ['هایی', 'های', 'ها', 'ترین', 'تر'];
// The prefix must be a whole word (no letter or ZWNJ right before it), followed by spaces and a Persian letter.
const PREFIX_MI = new RegExp(`(?<![\\p{L}\\u200C])(ن?می) +(?=${FA_LETTER})`, 'gu');
// A Persian word, spaces, then a suffix that ends the word.
const SUFFIX = new RegExp(`(${FA_LETTER}) +(${SUFFIXES.join('|')})(?![\\p{L}\\u200C])`, 'gu');

function mapChars(text: string): string {
	return text
		.replace(/ي/g, 'ی')
		.replace(/ك/g, 'ک')
		.replace(/[٠-٩]/g, d => String.fromCharCode(d.charCodeAt(0) - 0x0660 + 0x06f0))
		.replace(/ـ/g, '');
}

const prevNonSpace = (s: string, i: number) => {
	while (i >= 0 && s[i] === ' ') i--;
	return i >= 0 ? s[i] : '';
};
const nextNonSpace = (s: string, i: number) => {
	while (i < s.length && s[i] === ' ') i++;
	return i < s.length ? s[i] : '';
};

const PERSIAN_PUNCT: Record<string, string> = { ',': '،', ';': '؛', '?': '؟', '،': '،', '؛': '؛', '؟': '؟' };

/**
 * Persian punctuation, only in Persian runs (the previous non-space character is a Persian letter):
 * ASCII `, ; ?` become `، ؛ ؟` unless Latin text follows; no space before them; one space after
 * them when a letter follows directly.
 */
function punctuation(text: string): string {
	let out = '';
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		const persian = PERSIAN_PUNCT[ch];
		if (persian === undefined || !faLetter.test(prevNonSpace(text, i - 1))) {
			out += ch;
			continue;
		}
		const isAscii = ch !== persian;
		if (isAscii && latinAlnum.test(nextNonSpace(text, i + 1))) {
			out += ch;
			continue;
		}
		out = out.replace(/ +$/, '') + persian;
		const next = text[i + 1];
		if (next !== undefined && /\p{L}/u.test(next)) out += ' ';
	}
	return out;
}

function zwnj(text: string): string {
	return text.replace(PREFIX_MI, `$1${ZWNJ}`).replace(SUFFIX, `$1${ZWNJ}$2`);
}

/** Collapses runs of spaces, except between two non-Persian characters (Latin text keeps its spacing). */
function spaces(text: string): string {
	return text.replace(/ {2,}/g, (run, offset: number) => {
		const before = text[offset - 1] ?? '';
		const after = text[offset + run.length] ?? '';
		return ARABIC_CHAR.test(before) || ARABIC_CHAR.test(after) ? ' ' : run;
	});
}

function normaliseSegment(text: string): string {
	return spaces(zwnj(punctuation(mapChars(text))));
}

/** Normalises a string of Persian (possibly mixed with Latin) text. URLs and `code` spans are kept. */
export function normalizePersian(text: string): string {
	let out = '';
	let last = 0;
	for (const m of text.matchAll(PROTECTED)) {
		out += normaliseSegment(text.slice(last, m.index)) + m[0];
		last = m.index! + m[0].length;
	}
	return out + normaliseSegment(text.slice(last));
}

/** A normalised deep copy of a node. Text with a `code` mark and everything inside a code block is kept. */
export function normalizeNode(node: JSONNode): JSONNode {
	if (node.type === 'codeBlock') return structuredClone(node);
	const out: JSONNode = { ...structuredClone(node) };
	if (typeof node.text === 'string' && !node.marks?.some(m => m.type === 'code')) {
		out.text = normalizePersian(node.text);
	}
	if (node.content) out.content = node.content.map(normalizeNode);
	return out;
}
