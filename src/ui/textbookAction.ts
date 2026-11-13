// Wires the Textbook control to the textbook pipeline. The pipeline gets narrow ports only (I1):
// a clean-twin reader and the textbook part of the derived store, never the vault or a raw note.

import { createOpenAIProvider } from '../provider/openai';
import type { Provider, ProviderProfile } from '../provider/types';
import type { SettingsStore } from '../settings/store';
import { buildTextbook, staleCount, undoTextbook, type TextbookReport } from '../textbook/build';
import { textbookPorts } from '../textbook/ports';
import type { VaultStore } from '../vault/store';
import type { Textbook, TextbookOutline } from '../vault/types';

export async function buildVaultTextbook(
	vault: VaultStore,
	settings: SettingsStore,
	createProvider: (profile: ProviderProfile) => Provider = createOpenAIProvider,
): Promise<TextbookReport> {
	const { textbook, enrichment } = await settings.load();
	return buildTextbook({ ...textbookPorts(vault.derived), provider: createProvider(textbook) }, { enrichment });
}

export function vaultStaleCount(vault: VaultStore): Promise<number> {
	const { clean, store } = textbookPorts(vault.derived);
	return staleCount(clean, store);
}

export function undoVaultTextbook(vault: VaultStore): Promise<boolean> {
	return undoTextbook(textbookPorts(vault.derived).store);
}

export async function loadVaultTextbook(
	vault: VaultStore,
): Promise<{ outline?: TextbookOutline; textbook?: Textbook }> {
	return { outline: await vault.derived.loadOutline(), textbook: await vault.derived.loadTextbook() };
}
