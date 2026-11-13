// Serialises everything that writes one file's clean twin (Clean, undo, accept, remove), so an
// action never interleaves with another and never writes over a newer twin with an older one.

const chains = new WeakMap<object, Map<string, Promise<unknown>>>();

/** Runs `fn` after every earlier task for the same (store, fileId) has settled. */
export function withFileLock<T>(store: object, fileId: string, fn: () => Promise<T>): Promise<T> {
	let byFile = chains.get(store);
	if (!byFile) chains.set(store, (byFile = new Map()));
	const previous = byFile.get(fileId) ?? Promise.resolve();
	const run = previous.then(fn, fn);
	const tail = run.catch(() => {});
	byFile.set(fileId, tail);
	void tail.then(() => {
		if (byFile.get(fileId) === tail) byFile.delete(fileId);
	});
	return run;
}
