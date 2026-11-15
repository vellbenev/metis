import { describe, expect, it } from 'vitest';
import { HELP, parseArgs, STATES } from './shoot.mjs';

describe('shoot.mjs arguments', () => {
	it('defaults to every state and viewport into .shots', () => {
		expect(parseArgs([])).toEqual({ states: STATES, viewports: ['desktop', 'narrow'], out: '.shots', list: false, help: false });
	});

	it('takes repeated, comma-separated and --flag=value forms', () => {
		const o = parseArgs(['--state', 'note,clean', '--state=error', '--viewport', 'narrow', '--out=x']);
		expect(o).toMatchObject({ states: ['note', 'clean', 'error'], viewports: ['narrow'], out: 'x' });
	});

	it('all means all', () => {
		const o = parseArgs(['--state', 'all', '--viewport', 'all']);
		expect(o.states).toEqual(STATES);
		expect(o.viewports).toEqual(['desktop', 'narrow']);
	});

	it('rejects unknown states, viewports, options and missing values', () => {
		expect(() => parseArgs(['--state', 'nope'])).toThrow(/unknown state/);
		expect(() => parseArgs(['--viewport', 'phone'])).toThrow(/unknown viewport/);
		expect(() => parseArgs(['--bogus'])).toThrow(/unknown option/);
		expect(() => parseArgs(['--out'])).toThrow(/needs a value/);
	});

	it('help documents every option and state', () => {
		for (const s of ['--state', '--viewport', '--out', '--list', '--help', ...STATES]) expect(HELP).toContain(s);
		expect(parseArgs(['-h']).help).toBe(true);
		expect(parseArgs(['--list']).list).toBe(true);
	});
});
