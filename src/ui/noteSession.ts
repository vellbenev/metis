// Binds the editor to one raw note at a time: loads it, and saves edits back after a short pause.
// This is the editor side of I1: the only caller of VaultStore.saveNote.

import type { Editor } from '@tiptap/core';
import type { JSONNode } from '../core/blocks';
import type { VaultPath, VaultStore } from '../vault/store';
import type { RawNote } from '../vault/types';

interface Open {
	store: VaultStore;
	path: VaultPath;
	note: RawNote;
	dirty: boolean;
}

const startsWith = (path: VaultPath, prefix: VaultPath) =>
	prefix.length <= path.length && prefix.every((name, i) => path[i] === name);

export interface NoteSessionOptions {
	delay?: number;
	/** Called with the last save error, or undefined once a save succeeds again. */
	onError?(error: Error | undefined): void;
}

export class NoteSession {
	private current: Open | undefined;
	private timer: ReturnType<typeof setTimeout> | undefined;
	// Every save runs after the previous one; never rejects, so one failure cannot block later saves.
	private saving: Promise<void> = Promise.resolve();
	private release: (() => void) | undefined;
	private delay: number;

	constructor(
		private editor: Editor,
		private options: NoteSessionOptions = {},
	) {
		this.delay = options.delay ?? 600;
		editor.on('update', this.onUpdate);
	}

	get path(): VaultPath | undefined {
		return this.current?.path;
	}

	get fileId(): string | undefined {
		return this.current?.note.fileId;
	}

	private onUpdate = () => {
		if (!this.current) return;
		this.current.dirty = true;
		clearTimeout(this.timer);
		this.timer = setTimeout(() => this.flush().catch(() => {}), this.delay);
	};

	/** Opens a note. If pending edits of the current note cannot be saved, throws and stays on it. */
	async open(store: VaultStore, path: VaultPath): Promise<void> {
		await this.flush();
		const note = await store.loadNote(path);
		this.current = undefined; // ignore updates caused by loading
		this.editor.commands.setContent(note.doc, { emitUpdate: false });
		this.current = { store, path, note, dirty: false };
	}

	/** Writes pending edits now. Rejects if the write fails; the edits stay pending. */
	flush(): Promise<void> {
		clearTimeout(this.timer);
		const run = this.saving.then(async () => {
			const open = this.current;
			if (!open?.dirty) return;
			open.dirty = false;
			const note: RawNote = { ...open.note, doc: this.editor.getJSON() as JSONNode };
			try {
				await open.store.saveNote(open.path, note);
			} catch (e) {
				open.dirty = true;
				const error = e instanceof Error ? e : new Error(String(e));
				this.options.onError?.(error);
				throw error;
			}
			open.note = note;
			this.options.onError?.(undefined);
		});
		this.saving = run.catch(() => {});
		return run;
	}

	/**
	 * Saves pending edits, then holds every further save until `resume()`.
	 * Used around a rename so no save can land on the old path while files move.
	 */
	async pause(): Promise<void> {
		await this.flush();
		const gate = new Promise<void>(resolve => (this.release = resolve));
		this.saving = this.saving.then(() => gate);
	}

	resume(): void {
		this.release?.();
		this.release = undefined;
	}

	/** Call after a folder or note was renamed, so the open note keeps saving to the right file. */
	async moved(from: VaultPath, to: VaultPath): Promise<void> {
		const open = this.current;
		if (!open || !startsWith(open.path, from)) return;
		open.path = [...to, ...open.path.slice(from.length)];
		open.note = { ...open.note, title: (await open.store.loadNote(open.path)).title };
	}

	destroy(): void {
		this.resume();
		this.flush().catch(() => {});
		this.editor.off('update', this.onUpdate);
	}
}
