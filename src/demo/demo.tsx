// Dev-only demo mode (`?demo=<state>`), loaded by main.tsx only behind import.meta.env.DEV.
// Seeds an in-memory vault, renders the app with it, then clicks to the state and sets
// <html data-demo-ready> (or data-demo-error) for scripts/shoot.mjs.

import type { ReactNode } from 'react';
import { App } from '../App';
import { setAppSettingsStore } from '../settings/SettingsEntry';
import { DEMO_MARKER, DEMO_STATES, seedDemo, type DemoState } from './seed';

const html = document.documentElement;

async function waitFor<T>(find: () => T | null | undefined, what: string, ms = 10_000): Promise<T> {
	const end = Date.now() + ms;
	for (;;) {
		const found = find();
		if (found) return found;
		if (Date.now() > end) throw new Error(`demo: timed out waiting for ${what}`);
		await new Promise(r => setTimeout(r, 50));
	}
}

const button = (match: (b: HTMLButtonElement) => boolean) => [...document.querySelectorAll('button')].find(match);

export async function demoApp(state: string): Promise<{ app: ReactNode; drive(): Promise<void> }> {
	if (!DEMO_STATES.includes(state as DemoState)) throw new Error(`unknown demo state: ${state}`);
	html.dataset.demo = DEMO_MARKER;
	// No network in demo mode (I6): the provider gets a 401, which the error state shows.
	globalThis.fetch = async () =>
		new Response(JSON.stringify({ error: { message: 'invalid API key (demo)' } }), {
			status: 401,
			headers: { 'Content-Type': 'application/json' },
		});
	const setup = await seedDemo(state as DemoState);
	setAppSettingsStore(setup.settings);

	async function drive() {
		try {
			if (setup.open) {
				const title = setup.open.at(-1);
				(await waitFor(() => button(b => b.classList.contains('tree-note') && b.textContent === title), 'note')).click();
				await waitFor(() => document.querySelector('.note-bar'), 'note bar');
			}
			if (setup.press) {
				const name = setup.press;
				(await waitFor(() => button(b => b.name === name), name)).click();
			}
			if (state === 'clean') await waitFor(() => document.querySelector('.clean-pane .ai-added'), 'clean twin');
			if (state === 'textbook') await waitFor(() => document.querySelector('.textbook-stale'), 'stale count');
			if (state === 'settings') await waitFor(() => document.querySelector('.settings input'), 'settings');
			if (state === 'error') await waitFor(() => document.querySelector('.clean-bar .clean-status'), 'clean error');
			await document.fonts.ready;
			html.dataset.demoReady = state;
		} catch (e) {
			html.dataset.demoError = e instanceof Error ? e.message : String(e);
		}
	}

	return { app: <App vault={setup.vault} />, drive };
}
