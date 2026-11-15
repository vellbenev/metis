// Markdown export of a raw note, its clean twin, or the textbook (SPEC S7).
// Export only reads: it gets narrow loaders, never a store that can write (I1). It never normalises text (I8).

import { MarkdownManager } from '@tiptap/markdown';
import StarterKit from '@tiptap/starter-kit';
import type { JSONNode } from '../core/blocks';
import type { CleanNote, RawNote, Textbook, TextbookOutline } from '../vault/types';

export const AI_OPEN = '<!-- ai-added -->';
export const AI_CLOSE = '<!-- /ai-added -->';

let manager: MarkdownManager | undefined;
const markdown = () => (manager ??= new MarkdownManager({ extensions: [StarterKit] }));

const unaccepted = (n: JSONNode) =>
	typeof n.text === 'string' && (n.marks ?? []).some(m => m.type === 'aiAdded' && m.attrs?.accepted !== true);

/** Text characters not used by the document, to stand for the comment delimiters while serialising. */
function sentinels(doc: JSONNode): [string, string] {
	const used = JSON.stringify(doc);
	const free: string[] = [];
	for (let c = 0xe000; free.length < 2; c++) {
		const ch = String.fromCharCode(c);
		if (!used.includes(ch)) free.push(ch);
	}
	return [free[0], free[1]];
}

/**
 * Copy of a node ready for the serialiser. Provenance marks (`rewrite`, `gap` with any attributes, `aiAdded`)
 * are dropped; each run of unaccepted `aiAdded` text is bracketed by unmarked sentinel text nodes, which become
 * the HTML comments afterwards. Using separate nodes (not a mark) keeps the run's exact boundaries: the
 * serialiser moves whitespace out of marks, and would put a comment inside a code span. Text is never changed.
 */
function prepare(node: JSONNode, open: string, close: string): JSONNode {
	const out: JSONNode = { ...node };
	if (node.marks) {
		const marks = node.marks.filter(m => m.type !== 'rewrite' && m.type !== 'gap' && m.type !== 'aiAdded');
		if (marks.length > 0) out.marks = marks;
		else delete out.marks;
	}
	if (node.content) {
		const kids = node.content;
		out.content = kids.flatMap((kid, i) => {
			const ai = unaccepted(kid);
			const before = ai && !(i > 0 && unaccepted(kids[i - 1]));
			const after = ai && !(i < kids.length - 1 && unaccepted(kids[i + 1]));
			return [
				...(before ? [{ type: 'text', text: open }] : []),
				prepare(kid, open, close),
				...(after ? [{ type: 'text', text: close }] : []),
			];
		});
	}
	return out;
}

/** A TipTap document (raw, clean or a textbook section) as Markdown, ending with one newline. */
export function docToMarkdown(doc: JSONNode): string {
	const [open, close] = sentinels(doc);
	const prepared = prepare(doc, open, close) as Parameters<MarkdownManager['serialize']>[0];
	const text = markdown().serialize(prepared).split(open).join(AI_OPEN).split(close).join(AI_CLOSE);
	return text.length === 0 ? '' : `${text.replace(/\n+$/, '')}\n`;
}

const heading = (level: number, text: string): JSONNode => ({
	type: 'heading',
	attrs: { level },
	content: text ? [{ type: 'text', text }] : [],
});

/** Sections in outline order, each under its title, then the gaps list. */
export function textbookToMarkdown(outline: TextbookOutline | undefined, textbook: Textbook | undefined): string {
	const sections = [...(outline?.sections ?? [])].sort((a, b) => a.order - b.order);
	const content: JSONNode[] = [];
	for (const s of sections) {
		content.push(heading(2, s.title), ...(textbook?.sections[s.id]?.doc.content ?? []));
	}
	const gaps = textbook?.gaps ?? [];
	if (gaps.length > 0) {
		const title = (id: string) => sections.find(s => s.id === id)?.title ?? '';
		content.push(heading(2, 'جاهای خالی'), {
			type: 'bulletList',
			content: gaps.map(g => ({
				type: 'listItem',
				content: [{ type: 'paragraph', content: [{ type: 'text', text: `${title(g.sectionId)}: ${g.note}` }] }],
			})),
		});
	}
	return docToMarkdown({ type: 'doc', content });
}

/** A file name for the download: characters that file systems reject become '-'. */
export function markdownFileName(name: string, suffix = ''): string {
	const safe = name.replace(/[/\\:*?"<>|\0]/g, '-').trim() || 'metis';
	return `${safe}${suffix}.md`;
}

export interface MarkdownFile {
	fileName: string;
	markdown: string;
}

export function exportRawNote(note: Pick<RawNote, 'title' | 'doc'>): MarkdownFile {
	return { fileName: markdownFileName(note.title), markdown: docToMarkdown(note.doc) };
}

/** The clean twin of a note, or undefined if the note was never cleaned. */
export async function exportCleanTwin(
	clean: { loadClean(fileId: string): Promise<CleanNote | undefined> },
	fileId: string,
	title: string,
): Promise<MarkdownFile | undefined> {
	const twin = await clean.loadClean(fileId);
	if (!twin) return undefined;
	return { fileName: markdownFileName(title, '.clean'), markdown: docToMarkdown(twin.doc) };
}

/** The vault's textbook, or undefined if none was built. */
export async function exportTextbook(
	store: { loadOutline(): Promise<TextbookOutline | undefined>; loadTextbook(): Promise<Textbook | undefined> },
	vaultName: string,
): Promise<MarkdownFile | undefined> {
	const [outline, textbook] = await Promise.all([store.loadOutline(), store.loadTextbook()]);
	if (!outline?.sections.length) return undefined;
	return { fileName: markdownFileName(vaultName, '.textbook'), markdown: textbookToMarkdown(outline, textbook) };
}
