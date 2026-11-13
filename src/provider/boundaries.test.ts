import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = join(import.meta.dirname, '..');

function sources(dir: string): { path: string; text: string }[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
		const full = join(dir, e.name);
		if (e.isDirectory()) return e.name === 'test' ? [] : sources(full);
		if (!/\.(ts|tsx)$/.test(e.name) || /\.test\.tsx?$/.test(e.name)) return [];
		return [{ path: relative(src, full).split('\\').join('/'), text: readFileSync(full, 'utf8') }];
	});
}

const app = sources(src);
const importsOf = (text: string) => [...text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map(m => m[1]);

describe('no secrets in vaults (I5)', () => {
	const settingsAndProvider = app.filter(f => /^(settings|provider)\//.test(f.path));

	it('settings and provider code has no vault or file-system dependency', () => {
		expect(settingsAndProvider.length).toBeGreaterThan(0);
		for (const f of settingsAndProvider) {
			for (const spec of importsOf(f.text)) {
				expect(spec, f.path).not.toMatch(/vault|^node:|^fs$/i);
			}
			expect(f.text, f.path).not.toMatch(/showDirectoryPicker|getFileHandle|getDirectoryHandle|createWritable/);
		}
	});

	it('API keys are handled only by settings and provider code', () => {
		const offenders = app.filter(f => /apiKey/i.test(f.text) && !/^(settings|provider)\//.test(f.path));
		expect(offenders.map(f => f.path)).toEqual([]);
	});
});

describe('network discipline (I6)', () => {
	it('the OpenAI-compatible client is the only network call site in the app', () => {
		const network = /\bfetch\b|XMLHttpRequest|WebSocket|EventSource|sendBeacon/;
		expect(app.filter(f => network.test(f.text)).map(f => f.path)).toEqual(['provider/openai.ts']);
	});
});
