import { describe, expect, it } from 'vitest';
import { cleanMessages, cleanSystemPrompt } from './clean';

describe('clean prompt', () => {
	const prompt = cleanSystemPrompt('structure', 'flag-gaps');

	it('tells the model to leave URLs, code and digits unchanged', () => {
		expect(prompt).toMatch(/Leave URLs, code and digits exactly as written/);
	});

	it('leaves joining ای, ام, ات, اش to the model, and warns about the vocative ای', () => {
		for (const suffix of ['ای', 'ام', 'ات', 'اش']) expect(prompt).toContain(suffix);
		expect(prompt).toContain('vocative');
	});

	it('explains the inline Markdown and that code is copied byte for byte', () => {
		expect(prompt).toContain('`code`, **bold**, *italic*');
		expect(prompt).toContain('byte for byte');
	});

	it('sends previousRaw and previousClean only when given', () => {
		const messages = cleanMessages({
			blocks: [
				{ id: 'a', text: 'نو' },
				{ id: 'b', text: 'دو و نیم', previousRaw: 'دو', previousClean: 'پاک: دو' },
			],
			contextBefore: [],
			contextAfter: [],
			rewriteLevel: 'structure',
			enrichment: 'flag-gaps',
		});
		expect(messages[0].content).toContain('previousRaw');
		expect(JSON.parse(messages[1].content).blocks).toEqual([
			{ id: 'a', text: 'نو' },
			{ id: 'b', text: 'دو و نیم', previousRaw: 'دو', previousClean: 'پاک: دو' },
		]);
	});
});
