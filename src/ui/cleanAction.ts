// Wires the Clean button to the clean pipeline. The pipeline gets narrow ports only (I1): a reader
// that can load raw notes and the derived-data store, never the vault itself.

import { runClean, type CleanReport } from '../clean/clean';
import { createOpenAIProvider } from '../provider/openai';
import type { Provider, ProviderProfile } from '../provider/types';
import type { SettingsStore } from '../settings/store';
import type { VaultPath, VaultStore } from '../vault/store';
import { withFileLock } from './fileLock';

export async function cleanNote(
	vault: VaultStore,
	path: VaultPath,
	settings: SettingsStore,
	createProvider: (profile: ProviderProfile) => Provider = createOpenAIProvider,
): Promise<CleanReport> {
	const { clean, enrichment } = await settings.load();
	const { fileId } = await vault.loadNote(path);
	// Under the same per-file lock as the clean pane's undo/accept/remove.
	return withFileLock(vault.derived, fileId, () =>
		runClean(
			{ notes: { loadNote: p => vault.loadNote(p) }, derived: vault.derived, provider: createProvider(clean) },
			path,
			{ rewriteLevel: vault.meta.defaults.rewriteLevel, enrichment },
		),
	);
}
