// Dev-only demo vaults for screenshots (scripts/shoot.mjs). Loaded only behind import.meta.env.DEV.
// Everything lives in memory: a MemoryDir vault, an in-memory settings store, the mock provider.
// Derived data is made by the real clean and textbook pipelines, so it has the real on-disk format.

import basics from '../../fixtures/persian/zkp-01-basics.txt?raw';
import day2 from '../../fixtures/persian/zkp-01-basics.day2.txt?raw';
import snark from '../../fixtures/persian/zkp-02-snark.txt?raw';
import zwnj from '../../fixtures/persian/export-zwnj.txt?raw';
import mdChars from '../../fixtures/persian/export-markdown-chars.txt?raw';
import { runClean } from '../clean/clean';
import type { JSONNode } from '../core/blocks';
import { createMockProvider } from '../provider/mock';
import type { ChatRequest } from '../provider/types';
import { createMemorySettingsStore, DEFAULT_SETTINGS, type SettingsStore } from '../settings/store';
import { buildTextbook } from '../textbook/build';
import { textbookPorts } from '../textbook/ports';
import { memoryVault } from '../vault/backends';
import type { VaultPath, VaultStore } from '../vault/store';

export const DEMO_MARKER = 'metis-demo-mode';

export const DEMO_STATES = ['empty', 'first-run', 'note', 'clean', 'long-note', 'textbook', 'settings', 'error'] as const;
export type DemoState = (typeof DEMO_STATES)[number];

export interface DemoSetup {
	/** Undefined: no vault chosen yet. */
	vault?: VaultStore;
	settings: SettingsStore;
	/** The note to open once the tree shows. */
	open?: VaultPath;
	/** Then press this button (by `name`). */
	press?: 'settings' | 'textbook-show' | 'clean';
}

const FOLDER = 'رمزنگاری';
const BASICS: VaultPath = [FOLDER, 'اثبات دانش صفر - جلسه‌ی اول'];
const SNARK: VaultPath = [FOLDER, 'zk-SNARK و zk-STARK'];
export const LONG_TITLE =
	'یادداشت‌های بلند درس رمزنگاری کاربردی: اثبات دانش صفر، zk-SNARK، zk-STARK، Fiat-Shamir و trusted setup در بلاکچین';

const lines = (text: string) =>
	text
		.split('\n')
		.map(l => l.trim())
		.filter(Boolean);

const doc = (paragraphs: string[]): JSONNode => ({
	type: 'doc',
	content: paragraphs.map((text, i) => ({ type: 'paragraph', attrs: { id: `b${i}` }, content: [{ type: 'text', text }] })),
});

/** About 200 lines cycled from every Persian fixture. */
export function longLines(count = 200): string[] {
	const pool = [basics, day2, snark, zwnj, mdChars].flatMap(lines);
	return Array.from({ length: count }, (_, i) => pool[i % pool.length]);
}

/** Clean model: echoes each block; the cave example gets an aiAdded span, the "??" question a gap. */
function cleanReply(req: ChatRequest): string {
	const input: { blocks: { id: string; text: string }[] } = JSON.parse(req.messages[1].content);
	const blocks = input.blocks.map(b => {
		let text = b.text;
		if (text.includes('علی بابا')) text += ' <ai>این مثال نشان می‌دهد که تکرار، احتمال تقلب را کم می‌کند.</ai>';
		if (text.startsWith('؟؟')) text = `<gap>${text}</gap>`;
		return { type: 'paragraph', text, sources: [b.id] };
	});
	return JSON.stringify({ blocks });
}

/** Textbook model: one section per file, the notes echoed, one gap. */
function textbookReply(req: ChatRequest): string {
	const input = JSON.parse(req.messages[1].content);
	if (req.messages[0].content.includes('outline (table of contents)')) {
		const assigned = new Set(input.outline.flatMap((s: { files: string[] }) => s.files));
		const ops = input.files
			.filter((f: { fileId: string }) => !assigned.has(f.fileId))
			.map((f: { fileId: string; text?: string }) => ({
				op: 'add',
				title: f.text?.includes('zk-snark') ? 'zk-SNARK و zk-STARK' : 'پایه‌های اثبات دانش صفر',
				files: [f.fileId],
			}));
		return JSON.stringify({ ops });
	}
	const blocks = input.files.flatMap((f: { text: string }) => lines(f.text).map(text => ({ type: 'paragraph', text })));
	return JSON.stringify({ blocks, gaps: ['فرق interactive و non-interactive در یادداشت‌ها روشن نیست.'] });
}

async function addNote(vault: VaultStore, path: VaultPath, paragraphs: string[]): Promise<void> {
	const note = await vault.createNote(path.slice(0, -1), path.at(-1)!);
	await vault.saveNote(path, { ...note, doc: doc(paragraphs) });
}

const clean = (vault: VaultStore, path: VaultPath) =>
	runClean(
		{ notes: { loadNote: p => vault.loadNote(p) }, derived: vault.derived, provider: createMockProvider(cleanReply) },
		path,
		{ rewriteLevel: vault.meta.defaults.rewriteLevel, enrichment: 'light-add' },
	);

/** The basics note cleaned once, then day 2 added and cleaned again, so only the new block is highlighted. */
async function zkpVault(): Promise<VaultStore> {
	const vault = await memoryVault('اثبات دانش صفر');
	await vault.createFolder([], FOLDER);
	await addNote(vault, BASICS, lines(basics));
	await addNote(vault, SNARK, lines(snark));
	await clean(vault, BASICS);
	await clean(vault, SNARK);
	await addNote(vault, [FOLDER, 'تمرین'], lines(zwnj));
	return vault;
}

async function addDay2(vault: VaultStore): Promise<void> {
	const note = await vault.loadNote(BASICS);
	await vault.saveNote(BASICS, { ...note, doc: doc([...lines(basics), ...lines(day2)]) });
	await clean(vault, BASICS);
}

export async function seedDemo(state: DemoState): Promise<DemoSetup> {
	const settings = createMemorySettingsStore();
	switch (state) {
		case 'first-run':
			return { settings };
		case 'empty':
			return { settings, vault: await memoryVault('مخزن تازه') };
		case 'note':
			return { settings, vault: await zkpVault(), open: SNARK };
		case 'clean': {
			const vault = await zkpVault();
			await addDay2(vault);
			return { settings, vault, open: BASICS };
		}
		case 'long-note': {
			const vault = await zkpVault();
			const path = [FOLDER, LONG_TITLE];
			await addNote(vault, path, longLines());
			return { settings, vault, open: path };
		}
		case 'textbook': {
			const vault = await zkpVault();
			await buildTextbook(
				{ ...textbookPorts(vault.derived), provider: createMockProvider(textbookReply) },
				{ enrichment: 'flag-gaps' },
			);
			await addDay2(vault); // the basics twin is now newer than the textbook: stale count 1
			return { settings, vault, press: 'textbook-show' };
		}
		case 'settings':
			// A configured local model; no API key, so nothing secret is ever shown or stored.
			return {
				settings: createMemorySettingsStore({
					...DEFAULT_SETTINGS,
					clean: { ...DEFAULT_SETTINGS.clean, model: 'qwen3:8b' },
					textbook: { ...DEFAULT_SETTINGS.textbook, model: 'qwen3:14b' },
				}),
				vault: await zkpVault(),
				press: 'settings',
			};
		case 'error':
			// demo.tsx answers every model request with a 401, so pressing Clean shows a provider error.
			return { settings, vault: await zkpVault(), open: [FOLDER, 'تمرین'], press: 'clean' };
	}
}
