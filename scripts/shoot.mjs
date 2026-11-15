#!/usr/bin/env node
// Screenshots of the app's demo states (dev-only `?demo=<state>`, see src/demo/) for design work.
// Starts the Vite dev server on a free port, shoots each state in headless Chromium, writes PNGs.

import { mkdir } from 'node:fs/promises';
import { createServer as netServer } from 'node:net';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const STATES = ['empty', 'first-run', 'note', 'clean', 'long-note', 'textbook', 'settings', 'error'];
export const VIEWPORTS = { desktop: { width: 1440, height: 900 }, narrow: { width: 900, height: 800 } };

export const HELP = `Usage: node scripts/shoot.mjs [options]

Screenshots of the app's demo states in headless Chromium, saved as <out>/<state>-<viewport>.png.

Options:
  --state <name|all>        State(s) to shoot; repeatable or comma-separated. Default: all.
                            States: ${STATES.join(', ')}
  --viewport <name|all>     desktop (1440x900), narrow (900x800) or all; repeatable or comma-separated.
                            Default: all.
  --out <dir>               Output directory. Default: .shots
  --list                    Print the states and viewports, then exit.
  -h, --help                Print this help, then exit.

Exits non-zero if any state fails to render.`;

function pick(values, all, kind) {
	if (values.length === 0 || values.includes('all')) return all;
	for (const v of values) if (!all.includes(v)) throw new Error(`unknown ${kind}: ${v} (expected one of: ${all.join(', ')}, all)`);
	return [...new Set(values)];
}

/** Parses the command line (without node and the script path). Throws on bad input. */
export function parseArgs(argv) {
	const raw = { state: [], viewport: [], out: '.shots', list: false, help: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const [flag, inline] = arg.startsWith('--') && arg.includes('=') ? arg.split(/=(.*)/s) : [arg, undefined];
		const value = () => {
			const v = inline ?? argv[++i];
			if (v === undefined || v === '') throw new Error(`${flag} needs a value`);
			return v;
		};
		if (flag === '--state') raw.state.push(...value().split(',').filter(Boolean));
		else if (flag === '--viewport') raw.viewport.push(...value().split(',').filter(Boolean));
		else if (flag === '--out') raw.out = value();
		else if (flag === '--list') raw.list = true;
		else if (flag === '-h' || flag === '--help') raw.help = true;
		else throw new Error(`unknown option: ${arg}`);
	}
	return {
		states: pick(raw.state, STATES, 'state'),
		viewports: pick(raw.viewport, Object.keys(VIEWPORTS), 'viewport'),
		out: raw.out,
		list: raw.list,
		help: raw.help,
	};
}

function freePort() {
	return new Promise((ok, fail) => {
		const s = netServer().once('error', fail);
		s.listen(0, '127.0.0.1', () => {
			const { port } = s.address();
			s.close(() => ok(port));
		});
	});
}

async function shoot(page, url, file) {
	await page.goto(url);
	const handle = await page.waitForFunction(
		() => document.documentElement.dataset.demoReady ?? document.documentElement.dataset.demoError,
		null,
		{ timeout: 30_000 },
	);
	const error = await page.evaluate(() => document.documentElement.dataset.demoError);
	if (error) throw new Error(error);
	await handle.dispose();
	// Let fonts load and layout settle: fonts, then two frames.
	await page.evaluate(async () => {
		await document.fonts.ready;
		await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
	});
	await page.screenshot({ path: file, animations: 'disabled', caret: 'hide' });
}

async function main() {
	let opts;
	try {
		opts = parseArgs(process.argv.slice(2));
	} catch (e) {
		console.error(`${e.message}\n\n${HELP}`);
		return 2;
	}
	if (opts.help) return console.log(HELP), 0;
	if (opts.list) return console.log(`states: ${STATES.join(' ')}\nviewports: ${Object.entries(VIEWPORTS).map(([n, v]) => `${n} (${v.width}x${v.height})`).join(' ')}`), 0;

	const root = resolve(import.meta.dirname, '..');
	const out = resolve(opts.out);
	await mkdir(out, { recursive: true });
	const [{ createServer }, { chromium }] = await Promise.all([import('vite'), import('playwright')]);

	let server, browser;
	const stop = async () => {
		await browser?.close().catch(() => {});
		await server?.close().catch(() => {});
	};
	const interrupt = () => void stop().finally(() => process.exit(130));
	process.once('SIGINT', interrupt);
	process.once('SIGTERM', interrupt);

	let failed = 0;
	try {
		const port = await freePort();
		server = await createServer({ root, logLevel: 'error', server: { port, strictPort: true, host: '127.0.0.1' } });
		await server.listen();
		browser = await chromium.launch();
		for (const viewport of opts.viewports) {
			const context = await browser.newContext({ viewport: VIEWPORTS[viewport], locale: 'fa-IR' });
			for (const state of opts.states) {
				const file = join(out, `${state}-${viewport}.png`);
				const page = await context.newPage();
				try {
					await shoot(page, `http://127.0.0.1:${port}/?demo=${state}`, file);
					console.log(file);
				} catch (e) {
					failed++;
					console.error(`FAILED ${state}-${viewport}: ${e.message}`);
				} finally {
					await page.close();
				}
			}
			await context.close();
		}
	} finally {
		await stop();
	}
	return failed ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	main().then(
		code => process.exit(code),
		e => {
			console.error(e);
			process.exit(1);
		},
	);
}
