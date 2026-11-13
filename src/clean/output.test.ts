import { describe, expect, it } from 'vitest';
import { parseCleanOutput } from './output';

const ids = ['a', 'b'];
const p = (content: unknown, enrichment: 'off' | 'flag-gaps' | 'light-add' = 'flag-gaps') =>
	parseCleanOutput(typeof content === 'string' ? content : JSON.stringify(content), ids, enrichment);
const block = (extra: Record<string, unknown>) => ({ type: 'paragraph', text: 'متن', sources: ['a'], ...extra });

describe('parseCleanOutput', () => {
	it('accepts {blocks: [...]}, a bare array, and a fenced reply', () => {
		expect(p({ blocks: [block({})] }).ok).toBe(true);
		expect(p([block({})]).ok).toBe(true);
		expect(p('```json\n' + JSON.stringify({ blocks: [block({})] }) + '\n```').ok).toBe(true);
	});

	it('rejects bad JSON, a wrong shape and empty output', () => {
		expect(p('nope')).toEqual({ ok: false, error: 'not valid JSON' });
		expect(p({ items: [] }).ok).toBe(false);
		expect(p({ blocks: [] })).toEqual({ ok: false, error: 'no blocks' });
		expect(p({ blocks: [block({ text: '   ' })] }).ok).toBe(false);
		expect(p({ blocks: [block({ type: 'bulletList', text: undefined, items: [] })] }).ok).toBe(false);
	});

	it('rejects source ids outside the batch and missing sources', () => {
		expect(p({ blocks: [block({ sources: ['zzz'] })] }).ok).toBe(false);
		expect(p({ blocks: [block({ sources: [] })] }).ok).toBe(false);
		expect(p({ blocks: [block({ sources: undefined })] }).ok).toBe(false);
	});

	it('rejects unknown types, bad heading levels and unbalanced tags', () => {
		expect(p({ blocks: [block({ type: 'table' })] }).ok).toBe(false);
		expect(p({ blocks: [block({ type: 'heading', level: 5 })] }).ok).toBe(false);
		expect(p({ blocks: [block({ text: 'الف <gap>ب' })] }).ok).toBe(false);
		expect(p({ blocks: [block({ text: 'الف <gap><ai>ب</ai></gap>' })] }, 'light-add').ok).toBe(false);
	});

	it('allows <ai> only with light-add, and never a block made only of added text', () => {
		expect(p({ blocks: [block({ text: 'الف <ai>ب</ai>' })] }, 'off').ok).toBe(false);
		expect(p({ blocks: [block({ text: 'الف <ai>ب</ai>' })] }, 'light-add').ok).toBe(true);
		expect(p({ blocks: [block({ text: '<ai>همه‌اش افزوده</ai>' })] }, 'light-add').ok).toBe(false);
	});
});
