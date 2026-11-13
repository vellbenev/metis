import { describe, expect, it } from 'vitest';
import { cleanMessages, cleanSystemPrompt, type CleanPromptInput } from './clean';

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

	it('lists the batch Latin terms only when there are some, and says each must be kept', () => {
		const base: CleanPromptInput = { blocks: [{ id: 'a', text: 'prover' }], contextBefore: [], contextAfter: [], rewriteLevel: 'structure', enrichment: 'flag-gaps' };
		expect(prompt).toContain('Every term listed in "latinTerms" must appear in your output');
		expect(JSON.parse(cleanMessages({ ...base, latinTerms: ['prover'] })[1].content).latinTerms).toEqual(['prover']);
		expect(JSON.parse(cleanMessages({ ...base, latinTerms: [] })[1].content)).not.toHaveProperty('latinTerms');
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
