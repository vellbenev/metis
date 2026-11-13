// Pure helpers for top-level blocks of a TipTap JSON document.

export type BlockId = string;

export interface JSONNode {
	type: string;
	attrs?: Record<string, unknown>;
	content?: JSONNode[];
	marks?: { type: string; attrs?: Record<string, unknown> }[];
	text?: string;
	[key: string]: unknown;
}

function cleanAttrs(attrs: unknown, dropId: boolean): Record<string, unknown> | undefined {
	if (attrs === null || typeof attrs !== 'object') return undefined;
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(attrs as Record<string, unknown>)) {
		if (dropId && key === 'id') continue;
		if (value === null || value === undefined) continue;
		out[key] = value;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (value === null || typeof value !== 'object') return value;
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(value).sort()) {
		const v = (value as Record<string, unknown>)[key];
		if (v === undefined) continue;
		out[key] = sortKeys(v);
	}
	return out;
}

// Applies the attrs rules of SPEC section 5 to a node and everything below it.
// `attrs.id` is removed only at the top level, where block ids live.
function stripNode(node: unknown, isTop: boolean): unknown {
	if (Array.isArray(node)) return node.map(n => stripNode(n, false));
	if (node === null || typeof node !== 'object') return node;
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
		if (key === 'attrs') {
			const attrs = cleanAttrs(value, isTop);
			if (attrs) out.attrs = attrs;
		} else {
			out[key] = stripNode(value, false);
		}
	}
	return out;
}

/** Canonical JSON of a block (SPEC section 5): no id, no empty/null attrs, sorted keys, compact. */
export function canonicalJSON(block: JSONNode): string {
	return JSON.stringify(sortKeys(stripNode(block, true)));
}

/** sha256 (lowercase hex) of the canonical JSON of a block, UTF-8 encoded. */
export async function canonicalHash(block: JSONNode): Promise<string> {
	const bytes = new TextEncoder().encode(canonicalJSON(block));
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

/** Ids of the top-level blocks of a document, in order. */
export function blockIds(doc: JSONNode): (BlockId | undefined)[] {
	return (doc.content ?? []).map(b => b.attrs?.id as BlockId | undefined);
}
