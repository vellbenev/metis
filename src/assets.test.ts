import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// I6: fonts and assets are bundled; nothing in the shell loads from a remote origin.
const root = join(import.meta.dirname, '..');
const remote = /(?:https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}/i;

function filesUnder(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap(e =>
		e.isDirectory() ? filesUnder(join(dir, e.name)) : [join(dir, e.name)],
	);
}

describe('bundled assets (I6)', () => {
	it('index.html and app sources reference no remote URLs', () => {
		const files = [join(root, 'index.html'), ...filesUnder(join(root, 'src')).filter(f => !/\.test\.tsx?$/.test(f))];
		for (const file of files) expect(readFileSync(file, 'utf8'), file).not.toMatch(remote);
	});

	it('the Vazirmatn font is imported from the local package and its CSS points at bundled files', () => {
		const main = readFileSync(join(root, 'src', 'main.tsx'), 'utf8');
		const imports = [...main.matchAll(/import '(@fontsource\/vazirmatn\/[^']+)'/g)].map(m => m[1]);
		expect(imports.length).toBeGreaterThan(0);
		for (const spec of imports) {
			const css = readFileSync(join(root, 'node_modules', spec), 'utf8');
			const urls = [...css.matchAll(/url\(([^)]+)\)/g)].map(m => m[1]);
			expect(urls.length).toBeGreaterThan(0);
			for (const url of urls) expect(url).toMatch(/^\.\/files\/[\w.-]+\.woff2?$/);
		}
	});

	it('the page is RTL Persian with the paper theme', () => {
		expect(readFileSync(join(root, 'index.html'), 'utf8')).toMatch(/<html lang="fa" dir="rtl">/);
		const css = readFileSync(join(root, 'src', 'styles.css'), 'utf8');
		expect(css).toContain('--paper: #f5ecd3');
		expect(css).toContain('--ink: #2b2417');
		expect(css).toContain("font-family: 'Vazirmatn'");
	});
});
