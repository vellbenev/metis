// Minimal Markdown escaping for exported text. A character gets a backslash only where it would otherwise start
// Markdown syntax, so ordinary text (my_var_name, a*b, <T>, a & b, [۱], ZWNJ, Persian) comes out byte-identical.

import type { JSONNode } from '../core/blocks';

const PROVENANCE = new Set(['rewrite', 'gap', 'aiAdded']);
const isText = (n: JSONNode) => typeof n.text === 'string';
const isCode = (n: JSONNode) => (n.marks ?? []).some(m => m.type === 'code');
const unaccepted = (n: JSONNode) => (n.marks ?? []).some(m => m.type === 'aiAdded' && m.attrs?.accepted !== true);

/** What decides where the serialiser puts delimiters: formatting marks, and the aiAdded comment boundaries. */
const markKey = (n: JSONNode) =>
	JSON.stringify([
		(n.marks ?? []).filter(m => !PROVENANCE.has(m.type)).map(m => [m.type, m.attrs ?? null]),
		unaccepted(n),
	]);

const WS = /\s/u;
const PUNCT = /[\p{P}\p{S}]/u;
const ASCII_PUNCT = /[!-/:-@[-`{-~]/;
const ws = (c: string) => WS.test(c);
const punct = (c: string) => PUNCT.test(c);
const alnum = (c: string) => !ws(c) && !punct(c);

/** One character of the block's inline text; `node < 0` for virtual characters (line breaks, mark boundaries). */
interface Ch {
	c: string;
	node: number;
	escapable: boolean;
}

function flatten(children: JSONNode[]): Ch[] {
	const out: Ch[] = [];
	children.forEach((n, i) => {
		// Delimiters are inserted where the formatting changes; they count as punctuation for flanking.
		if (i > 0 && isText(n) && isText(children[i - 1]) && markKey(n) !== markKey(children[i - 1])) {
			out.push({ c: '>', node: -1, escapable: false });
		}
		if (!isText(n)) {
			out.push({ c: '\n', node: -1, escapable: false }); // hardBreak (or another inline node): a new line
			return;
		}
		const code = isCode(n);
		for (const c of n.text!) out.push({ c: code ? 'x' : c, node: i, escapable: !code });
	});
	return out;
}

/** Maximal runs of `ch` made only of escapable characters, as [start, end). */
function runs(s: Ch[], ch: string): [number, number][] {
	const out: [number, number][] = [];
	for (let i = 0; i < s.length; i++) {
		if (s[i].c !== ch || !s[i].escapable) continue;
		let j = i;
		while (j < s.length && s[j].c === ch && s[j].escapable) j++;
		out.push([i, j]);
		i = j - 1;
	}
	return out;
}

function escapePositions(s: Ch[], kind: 'paragraph' | 'heading' | 'other'): Set<number> {
	const esc = new Set<number>();
	const at = (i: number) => (i < 0 || i >= s.length ? '\n' : s[i].c);
	const mark = (from: number, to: number) => {
		for (let i = from; i < to; i++) if (s[i].escapable) esc.add(i);
	};
	const text = s.map(x => x.c).join('');

	// Backslash: only before ASCII punctuation, where it would escape it.
	for (let i = 0; i < s.length; i++) {
		if (s[i].c === '\\' && s[i].escapable && ASCII_PUNCT.test(at(i + 1))) esc.add(i);
	}

	// Emphasis delimiters (CommonMark flanking rules).
	for (const ch of ['*', '_']) {
		const flanking = runs(s, ch).filter(([a, b]) => {
			const p = at(a - 1);
			const n = at(b);
			const left = !ws(n) && (!punct(n) || ws(p) || punct(p));
			const right = !ws(p) && (!punct(p) || ws(n) || punct(n));
			return left || right;
		});
		for (const [a, b] of flanking) {
			const intraword = alnum(at(a - 1)) && alnum(at(b));
			// Intraword `_` never opens or closes emphasis; intraword `*` can, but only with a partner.
			if (intraword && (ch === '_' || flanking.length === 1)) continue;
			mark(a, b);
		}
	}

	// Code spans and strikethrough need a closing run; a lone backtick or tilde run is literal.
	for (const ch of ['`', '~']) {
		const r = runs(s, ch);
		if (r.length >= 2) for (const [a, b] of r) mark(a, b);
	}

	// Links: only text that looks like `[..](..)`, `[..][..]` or a reference definition.
	if (/\]\s*[([]/.test(text) || (kind === 'paragraph' && /(^|\n) {0,3}\[[^\]]*\]:/.test(text))) {
		for (let i = 0; i < s.length; i++) if (s[i].c === '[' || s[i].c === ']') mark(i, i + 1);
	}

	for (let i = 0; i < s.length; i++) {
		// HTML comments (so note text can never pass for an ai-added marker) and entity references.
		if (s[i].c === '<' && text.startsWith('!--', i + 1)) mark(i, i + 1);
		if (s[i].c === '&' && /^&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/.test(text.slice(i))) mark(i, i + 1);
	}

	if (kind === 'paragraph') {
		// Line starts (the block start and after each hard break) that would begin another block.
		for (let start = 0; start <= s.length; start = text.indexOf('\n', start) + 1) {
			const end = text.indexOf('\n', start) < 0 ? s.length : text.indexOf('\n', start);
			const line = text.slice(start, end);
			const j = start + (/^ {0,3}/.exec(line)?.[0].length ?? 0);
			const rest = text.slice(j, end);
			if (/^#{1,6}(\s|$)/.test(rest) || /^>/.test(rest) || /^[-+*](\s|$)/.test(rest) || /^(`{3,}|~{3,})/.test(rest)) {
				mark(j, j + 1);
			} else if (/^([-*_])([ \t]*\1){2,}[ \t]*$/.test(rest) || (start > 0 && /^=+[ \t]*$/.test(rest))) {
				mark(j, j + 1);
			} else {
				const ol = /^\d{1,9}[.)](\s|$)/.exec(rest);
				if (ol) mark(j + ol[0].search(/[.)]/), j + ol[0].search(/[.)]/) + 1);
			}
			if (end >= s.length) break;
		}
	}

	if (kind === 'heading') {
		// A trailing ` #` run would be read as the heading's closing sequence.
		const m = /\s(#+)\s*$/.exec(text);
		if (m) mark(m.index + 1, m.index + 2);
	}
	return esc;
}

/** Copies of a textblock's inline children with the needed backslashes added. Code text is never touched. */
export function escapeInline(children: JSONNode[], kind: 'paragraph' | 'heading' | 'other'): JSONNode[] {
	const s = flatten(children);
	const esc = escapePositions(s, kind);
	if (esc.size === 0) return children;
	const texts = children.map(n => (isText(n) ? '' : undefined));
	s.forEach((ch, i) => {
		if (ch.node < 0) return;
		texts[ch.node] += (esc.has(i) ? '\\' : '') + ch.c;
	});
	return children.map((n, i) => (isText(n) && !isCode(n) ? { ...n, text: texts[i]! } : n));
}
