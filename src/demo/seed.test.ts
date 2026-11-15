import { describe, expect, it } from 'vitest';
import { loadFixture } from '../test/fixtures';
import { staleCount } from '../textbook/build';
import { textbookPorts } from '../textbook/ports';
import { DEMO_STATES, LONG_TITLE, longLines, seedDemo } from './seed';

const lines = (path: string) =>
	loadFixture(path)
		.split('\n')
		.map(l => l.trim())
		.filter(Boolean);

describe('demo seeding', () => {
	it('first-run has no vault and no model; empty has a vault with no notes', async () => {
		const first = await seedDemo('first-run');
		expect(first.vault).toBeUndefined();
		expect((await first.settings.load()).clean.model).toBe('');
		const empty = await seedDemo('empty');
		expect((await empty.vault!.tree()).children).toEqual([]);
	});

	it('every state seeds, and the notes it opens exist', async () => {
		for (const state of DEMO_STATES) {
			const setup = await seedDemo(state);
			if (setup.open) await expect(setup.vault!.loadNote(setup.open)).resolves.toBeDefined();
		}
	});

	it('clean: the twin has an aiAdded and a gap span, and only the day-2 blocks are new', async () => {
		const { vault, open } = await seedDemo('clean');
		const { fileId } = await vault!.loadNote(open!);
		const twin = (await vault!.derived.loadClean(fileId))!;
		const json = JSON.stringify(twin.doc);
		expect(json).toContain('"aiAdded"');
		expect(json).toContain('"gap"');
		const fresh = twin.doc.content!.filter(n => n.attrs?.changedIn === twin.lastClean);
		expect(fresh.length).toBeGreaterThan(0);
		expect(fresh.length).toBeLessThan(twin.doc.content!.length);
	});

	it('clean: the raw note is exactly the fixture text, without derived marks (I1)', async () => {
		const { vault, open } = await seedDemo('clean');
		const note = await vault!.loadNote(open!);
		const text = note.doc.content!.map(b => b.content?.map(c => c.text).join(''));
		expect(text).toEqual([...lines('persian/zkp-01-basics.txt'), ...lines('persian/zkp-01-basics.day2.txt')]);
		expect(JSON.stringify(note.doc)).not.toContain('"marks"');
	});

	it('long-note: 200 lines and a very long title', async () => {
		const { vault, open } = await seedDemo('long-note');
		const note = await vault!.loadNote(open!);
		expect(note.title).toBe(LONG_TITLE);
		expect(LONG_TITLE.length).toBeGreaterThan(80);
		expect(note.doc.content).toHaveLength(200);
		expect(longLines()).toHaveLength(200);
	});

	it('textbook: sections exist and the stale count is above zero', async () => {
		const { vault, press } = await seedDemo('textbook');
		expect(press).toBe('textbook-show');
		const outline = (await vault!.derived.loadOutline())!;
		const textbook = (await vault!.derived.loadTextbook())!;
		expect(outline.sections.length).toBeGreaterThanOrEqual(2);
		expect(Object.keys(textbook.sections)).toHaveLength(outline.sections.length);
		const { clean, store } = textbookPorts(vault!.derived);
		expect(await staleCount(clean, store)).toBeGreaterThan(0);
	});

	it('settings: a model is set but no API key anywhere (I5)', async () => {
		const s = await (await seedDemo('settings')).settings.load();
		expect(s.clean.model).not.toBe('');
		expect(s.clean.apiKey).toBeUndefined();
		expect(s.textbook.apiKey).toBeUndefined();
	});
});
