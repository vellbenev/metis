# Metis — SPEC (v0.1, draft)

Owner: Hooman. This file is the source of truth. Slices are implemented from here; if something is ambiguous, ask the
owner (do not guess silently).

## 1. What Metis is

Metis is a local-first web app for taking fast, messy notes in Persian while learning (videos, whitepapers, books,
anything). The user only writes. Two explicit buttons turn the writing into something worth revisiting:

1. **Clean** (per file): produces a tidy "clean twin" of the note file, shown side by side with the raw note, and
   updated incrementally when the user adds more later.
2. **Textbook / جزوه** (per vault): builds one evolving textbook from all clean twins in a vault.

A **vault** is one topic (e.g. "ZKP") containing folders and note files.

## 2. Principles (decide hard questions with these)

1. Writing has zero friction. The editor never asks, blocks, or suggests anything.
2. Raw is sacred. Nothing the user typed is ever modified by a derived process.
3. AI runs only when the user presses a button. No background or automatic AI.
4. Show what changed, don't ask for approval. Highlight changes; always offer undo.
5. Local-first. No backend, no accounts, no telemetry. The user brings the model (Ollama or any OpenAI-compatible API
   such as OpenRouter).
6. Less is more. A feature must reduce note-taking friction or increase understanding, otherwise it does not ship.

## 3. Concepts

- **Vault**: a topic; maps to one folder on disk.
- **Folder / File**: user-organised structure inside a vault.
- **Block**: a top-level node of the rich-text document (paragraph, heading, list, quote, code, ...). Every block has a
  stable `id`. Only top-level nodes are blocks and carry ids; nested nodes (list items, table cells, ...) belong to
  their block, so a list is one block. Changing a block's type in place (paragraph -> heading, list, quote, ... and
  back) keeps its id. An empty block is a paragraph with no content at all (no text, no inline nodes); horizontal rules,
  images and code blocks are never empty. Empty blocks (e.g. the trailing empty paragraph the editor keeps) are skipped
  when hashing and syncing (S4). Ids only need to be unique within one note; other notes may reuse an id, and the clean
  twin and textbook refer to a block by (file, id).
- **Clean twin**: derived document for one file, block-mapped to the raw file.
- **Textbook**: derived document for one vault, built from clean twins, organised in sections.
- **Provenance**: every piece of derived text is either `rewrite` (derived from the user's words) or `aiAdded` (the
  model added it). Raw text is always the user's.

## 4. Invariants (tests MUST enforce these)

- **I1 Raw immutable**: no clean/textbook/provider code ever writes to `notes/**`. A test hashes raw files before and
  after a clean run and requires equality.
- **I2 Stable block IDs**: editing a block's text never changes its id. Split keeps the id on the first part and mints a
  new id for the rest. Merging two blocks keeps the first block's id. Moving a block (drag) keeps its id. Changing a
  block's type in place keeps its id. On paste, a block whose id already exists in the document gets a new id
  (copy-paste); otherwise it keeps its id (cut-paste is a move). IDs survive save/load round trips. No id appears twice
  in the same note (cut-paste and undo may bring back a previously deleted id).
- **I3 Incremental**: a clean block is regenerated only if at least one of its source raw blocks changed (new hash) or
  was deleted. A raw block whose hash is unchanged and that shares no clean block with a changed or deleted block causes
  zero model calls and its clean block stays byte-identical. Tested with a mock provider that counts calls.
- **I4 Provenance**: every text span in a clean doc or textbook carries provenance; `aiAdded` spans carry the `aiAdded`
  mark and are visually distinct until accepted. Code block text (clean twin and textbook) carries no mark (TipTap code
  blocks allow none); the rule skips code blocks everywhere.
- **I5 No secrets in vaults**: API keys live only in browser storage, never in any file under a vault.
- **I6 Network discipline**: the app makes no network request except to the configured provider `baseUrl`. All fonts and
  assets are bundled (no CDNs).
- **I7 Textbook stability**: section ids and outline order are stable; a section is regenerated only if one of its
  source files changed since it was built.
- **I8 Deterministic normalisation**: Persian normalisation (section 6.1) is a pure function with unit tests; it never
  touches Latin text or code.

## 5. On-disk format

```
<vault>/
  metis.vault.json                 # { version, name, createdAt, defaults: { rewriteLevel } }
  notes/
    <folder>/<file>.metis.json     # RAW. Written only by the editor.
  .metis/
    sync/<fileId>.json             # SyncState
    clean/<fileId>.json            # CleanNote (derived)
    history/<fileId>/<revision>.json   # snapshots for undo
    textbook/outline.json          # TextbookOutline
    textbook/textbook.json         # Textbook (derived)
    textbook/history/<n>.json      # textbook snapshots for undo: { version, outline, textbook }
```

Folders and files under `notes/` mirror what the user sees. Everything under `.metis/` is derived and may be deleted and
rebuilt (at the cost of model calls).

```ts
type BlockId = string; // nanoid(12), unique within a note

interface RawNote {
	// notes/**/*.metis.json
	version: 1;
	fileId: string; // stable uuid
	title: string;
	doc: TipTapJSON; // every top-level node has attrs.id: BlockId
}

interface SyncState {
	// .metis/sync/<fileId>.json
	version: 1;
	revision: number; // +1 per successful clean
	blocks: Record<BlockId, { rawHash: string; rawText?: string; cleanIds: BlockId[]; lastRevision: number }>;
	// rawText: the normalised raw text (as sent to the model) at the last clean of that block. States written before
	// it existed lack it; they are read as "no previous raw text", and an unchanged block keeps its entry as is.
}

interface CleanNote {
	// .metis/clean/<fileId>.json
	version: 1;
	fileId: string;
	revision: number;
	doc: TipTapJSON; // top-level nodes: attrs.id, attrs.sources: BlockId[], attrs.changedIn: number
}
// inline marks in derived docs: `rewrite` (default), `aiAdded` {accepted: boolean}, `gap` (unclear in the notes)

interface TextbookOutline {
	version: 1;
	sections: { id: string; title: string; sourceFileIds: string[]; order: number }[];
}
interface Textbook {
	version: 1;
	builtAt: number;
	sections: Record<string /*sectionId*/, { doc: TipTapJSON; sourceRevisions: Record<string /*fileId*/, number> }>;
	gaps: { sectionId: string; note: string }[];
}
```

`rawHash` = sha256 (hex) of the canonical JSON of the _normalised_ block (6.1). Canonical form:

- remove `attrs.id`; then omit `attrs` entirely if it is empty, and omit any attribute whose value is `null` or
  `undefined`;
- sort object keys lexicographically at every level; keep array order (content, marks) as is;
- serialise as compact UTF-8 JSON, no whitespace.

The position of a block in the document is not part of its hash.

Storage rules:

- Folders may nest to any depth; notes may also sit directly under `notes/`.
- Renaming a note also changes its `title`.
- `createdAt` in `metis.vault.json` is milliseconds since epoch.
- A history snapshot is `{ version, clean, sync }`.
- A folder vault is not remembered between sessions; the user picks it again.
- Names are compared case-insensitively after NFC normalisation, so collisions are detected on every disk.

## 6. Clean pipeline (per file, incremental)

### 6.1 Persian normalisation (deterministic, before hashing and before the model)

- Arabic `ي`→`ی`, `ك`→`ک`; Arabic-Indic digits `٠-٩`→Persian `۰-۹`; Latin digits are left alone.
- Remove tatweel; collapse repeated spaces; normalise Persian punctuation (`،` `؛` `؟`) only in Persian runs.
- ZWNJ (نیم‌فاصله), unambiguous forms only: prefixes `می` / `نمی` (`می رود`→`می‌رود`) and suffixes `ها` / `های` /
  `هایی`, `تر` / `ترین` (`کتاب ها`→`کتاب‌ها`). `ای`, `ام`, `ات`, `اش` are never joined here (they can be words of
  their own, e.g. vocative `ای`); the clean prompt handles them.
- Never modify Latin text, URLs, or code spans.
- Known gap: a ZWNJ join across two text nodes (e.g. a word and a bold `ها`) is not made.

### 6.2 Steps

1. Normalise a copy of the raw doc.
2. Hash every non-empty top-level raw block (empty block = a paragraph with no content, section 3) and compare with
   `SyncState`: classify `new`, `changed`, `unchanged`, `deleted`. Unchanged blocks that share a clean block with a
   changed or deleted block are re-cleaned too (I3).
3. Code blocks and blocks without text (horizontal rule, image, ...) are copied to the clean twin as they are, with no
   model call. Group the other new/changed blocks: adjacent blocks form a batch of at most 8 (default); raw blocks that
   share a clean block always go in the same batch, even if not adjacent or over the cap. Include up to 2 (default)
   neighbouring clean blocks on each side as read-only context.
4. Call the `clean` provider profile with the vault's default rewrite level (no per-file override yet). Inline code,
   bold and italic are sent as simple Markdown (`` `code` ``, `**bold**`, `*italic*`) and restored as marks. Expected
   output: `{"blocks": [...]}` (a bare array is also accepted) of clean blocks, each with `sources: BlockId[]` (ids
   from the batch only).
5. Validate (schema, source ids exist, every batch block is a source of some output block, no empty output, every
   input inline code span copied byte-identical, every Latin term of the batch kept (6.4); an invented code span becomes
   plain text; a `*` or `**` with no partner is read as text, the other markers still format). Retry once on invalid
   output; on second failure leave that batch untouched and report it. A missing Latin term also gets one retry, but
   if the retry is otherwise valid and still misses a term it is accepted: every clean block whose sources include a
   raw block with that term gets a `gap` mark on all its text (except `aiAdded` spans), and the run reports the raw
   block and its missing terms (`unresolvedTerms`). A provider error (network, auth, ...) aborts the whole run and
   writes nothing.
6. Splice into the CleanNote: unchanged blocks are untouched; changed blocks are replaced; deleted raw blocks remove
   their clean blocks; a block that was only moved (same id, same hash, new position) causes no model call and its clean
   block is just reordered; final order follows raw order.
7. Snapshot the previous CleanNote + SyncState into `history/`, write the new ones, set `changedIn = revision` on
   touched blocks.
8. Undo = restore the latest snapshot.

### 6.3 Rewrite levels

`light` (fix typos/spacing/ZWNJ only), `structure` (default: tidy sentences, headings, lists, semi-formal Persian),
`full` (rewrite for flow). Vault default, file override.

### 6.4 Clean prompt rules (src/prompts/clean.ts)

- Be faithful: never add claims the user did not make.
- For a `changed` block that was cleaned before, the model also receives the previous raw text (`SyncState.rawText`,
  when stored) and the previous clean text and must keep the wording of the parts that did not change (no churn).
- Leave URLs, code and digits unchanged. Keep the inline Markdown; copy `code` spans byte for byte.
- Join `ای`, `ام`, `ات`, `اش` with ZWNJ only where they are suffixes (not the vocative `ای`).
- Semi-formal Persian; convert colloquial speech to clean written Persian without losing meaning.
- Keep Latin technical terms in Latin (`zk-SNARK`, `prover`); do not translate them. Enforced in code: the batch's
  Latin terms are listed in the request (`latinTerms`), and an output missing one is retried, then accepted with a
  `gap` mark (6.2 step 5). A term is a run of Latin letters and digits that starts with a letter, with inner `-`, `_`
  or `.` joining parts (`zk-SNARK`, `Node.js`, `ERC-20`). Not terms: inline code, URLs, e-mail addresses, tokens
  shorter than 3 characters (`x`, `ok`, `vs`, `ZK`), tokens without two Latin letters in a row (`v1.2`, `e.g`, `x2`),
  and the stoplist `ok okay eg ie etc vs aka btw fyi cf via et al` (case and dots ignored). In the output a term must
  occur as a whole Latin word; case, formatting, hyphen variants (`‑`, `–`) and a Persian suffix (`prover‌ها`) are
  accepted. Singular and regular English plural (`-s`, `-es`, `-ies`) count as the same term both ways: input
  `provers` is kept by `prover‌ها` or `prover`, input `prover` by `provers`.
- Unclear or incomplete notes: wrap the span in a `gap` mark; never guess.
- Enrichment setting `off` | `flag-gaps` (default) | `light-add`. Only `light-add` may add text, and only inside an
  incomplete sentence, a few words to a sentence, marked `aiAdded`. Never new headings, never new paragraphs.

## 7. Textbook pipeline (per vault)

- Input: clean twins only (never raw).
- Outline is a stable skeleton (`outline.json`). On each build the model proposes a small _delta_ (add / rename / merge
  / reorder sections, and assign: put a file into an existing section); the delta is applied, highlighted, and undoable
  (snapshot under `textbook/history/`).
- Unaccepted `aiAdded` text in a clean twin is left out of the textbook input. Raw note titles never reach the model,
  so section titles come from clean content.
- A section is regenerated only if any of its source files has a newer clean revision than `sourceRevisions` (I7), or
  if its file list changed (merge, assign).
- Strict by default: content comes from the notes. Gaps are collected in `gaps`. With `light-add` the model may complete
  an incomplete sentence inline (marked `aiAdded`), never add a section or heading.
- **Stale indicator** (pure function `countStaleFiles`): the number of files whose clean revision is newer than what the
  textbook was built from; a file in no section counts as stale. Shown as a quiet count beside the vault, never a popup. There is no threshold and no rule:
  the user decides when to build.

## 8. AI provider layer

```ts
interface ProviderProfile {
	baseUrl: string;
	apiKey?: string;
	model: string;
}
interface ProviderSettings {
	clean: ProviderProfile;
	textbook: ProviderProfile;
	enrichment: 'off' | 'flag-gaps' | 'light-add';
}
```

- One client for the OpenAI-compatible `POST {baseUrl}/chat/completions` API (works for Ollama `/v1` and OpenRouter).
- The client strips a leading reasoning prefix from every reply before anyone parses it (both profiles and Test
  model): `<think>...</think>` blocks at the start; an orphan `</think>` drops everything before it, only when no
  `<think>` precedes it and the reply does not start with `{`, `[` or a code fence; an unclosed leading `<think>` makes
  the reply empty, so it fails validation. Tags elsewhere (quoted by the notes) are kept.
- Settings live in browser storage (IndexedDB), never in a vault (I5).
- **Test model** button: sends a fixed Persian paragraph from the fixtures and checks: non-empty reply, Latin terms
  preserved, valid JSON when JSON was requested; reports latency. Latin runs in the results are isolated (`<bdi
  dir="ltr">`) so mixed Persian/Latin text renders in order.
- On a network error that looks like CORS against a local Ollama, show: set `OLLAMA_ORIGINS` to this app's origin.

## 9. UI

- Minimal and calm. Paper theme: background about `#f5ecd3`, text about `#2b2417`; RTL by default; Persian font
  (Vazirmatn) bundled locally.
- Layout: slim file tree, editor, optional parallel clean-twin pane. Clicking a block in one pane highlights its
  counterpart in the other (via `sources`).
- One prominent button per file: **Clean**. Vault level: a quieter **Textbook** control with the stale-file count.
- New/changed blocks (`changedIn === revision`) are highlighted until the next clean or until dismissed. `aiAdded` and
  `gap` spans have their own subtle styles.
- Rich text: headings, lists, quotes, code, bold/italic. No tags, no templates, no sidebar clutter.

## 10. Stack (proposed; Hooman may change it before slice 1)

**Decided.** TypeScript, React, Vite (static build, no server), TipTap v3 (>= 3.7, ProseMirror) for the editor, Vitest
for tests, File System Access API for vault storage with an IndexedDB fallback. No backend.

Licensing rule: only permissive open-source dependencies (MIT, Apache-2.0, BSD, ISC). Dev-only test tools such as
`fake-indexeddb` (Apache-2.0) are fine. Never use copyleft (GPL/AGPL) or anything paid or account-bound: no
`@tiptap-pro/*`, no TipTap Cloud. The TipTap core and its open-source extensions (including `@tiptap/markdown`) are
free.

Note: `@tiptap/markdown` is an early release with possible edge cases; the custom marks (`aiAdded`, `gap`) need custom
serialisers.

## 11. Slices

Order: **S1 -> (S2 || S3) -> S4 -> S5 -> S6 -> S7**. S2 and S3 are independent and may run in parallel.

Definition of done for every slice: tests pass; relevant invariants covered by tests; review has no must-fix items; no
network access except to the configured provider.

### S1 — Scaffold + block editor

- Vite + React + TS + Vitest project; `npm test` works.
- TipTap editor, RTL, paper theme, bundled Vazirmatn.
- Every top-level block gets a stable id (I2): edit and in-place type change keep it, split mints a new id for the
  second part, merge keeps the first id, drag-move and cut-paste keep the id, copy-paste mints new ids, save/load
  round-trip preserves them. Each case needs a test.
- Check the licence of any id package (e.g. TipTap's unique-id extension) before using it; if it is not MIT/free, write
  a small ProseMirror plugin instead.
- `canonicalHash` follows the canonical form in section 5 (empty `attrs` omitted, keys sorted). Test: a block hashes the
  same with `attrs: {id}` as without `attrs`.
- Pure `src/core/blocks.ts` with the canonical hash function.
- Fixtures in `fixtures/persian/` are loadable in tests.

### S2 — Vault store

- `VaultStore` interface + implementations: File System Access API, IndexedDB fallback, in-memory (for tests).
- Create vault, create/rename folders and files, load/save `RawNote`, derived data under `.metis/` (section 5).
- One contract test suite run against every implementation.
- UI: minimal file tree wired to the store.

### S3 — Provider layer

- OpenAI-compatible client, two profiles (`clean`, `textbook`), enrichment setting.
- Settings screen with the Test model button (section 8). Settings in IndexedDB (I5).
- Mock provider (in-process) usable by all later tests, with a call counter (needed for I3).
- Tests: request shape, error mapping, no request goes anywhere except `baseUrl` (I6).

### S4 — Incremental clean

- Normalisation (6.1) with unit tests (I8).
- Block diff, batching, prompt, validation, splice, snapshot (6.2).
- Fixtures: `zkp-01-basics.txt` -> clean; append `zkp-01-basics.day2.txt` -> clean again: only new/changed blocks hit
  the mock provider (I3); raw hashes unchanged (I1).
- Clean button on a file; clean twin stored under `.metis/`.
- Clean and textbook code receive only a note reader and the derived-data store, never the full `VaultStore` (keeps I1
  structural).

### S5 — Parallel view, highlights, undo

- Side-by-side clean pane with block linking.
- Highlight new/changed blocks; dismiss; Undo restores the previous snapshot exactly.
- `aiAdded` accept/remove with one click; `gap` list.

### S6 — Textbook

- Outline + delta, per-section regeneration (I7), gaps list.
- Textbook control and the stale-file count (`countStaleFiles`, section 7).
- Tests with the mock provider: unchanged sections are not regenerated; outline ids stable.

### S7 — Markdown export

- Export a raw note, its clean twin, or the textbook as `.md` (via `@tiptap/markdown`).
- Export never modifies any vault file (I1). Unaccepted `aiAdded` spans are wrapped in HTML comments
  (`<!-- ai-added -->...<!-- /ai-added -->`) so provenance survives; `gap` spans export as plain text.
- Persian text, ZWNJ and Latin terms survive export unchanged (tests with fixtures).

## 12. Out of scope for v1

Collaboration, sync/cloud, accounts, mobile app, tags/templates/plugins, video timestamps, automatic or background AI,
image/PDF import, Markdown import, exports other than Markdown (PDF, DOCX, ...).

## 13. Decisions and open questions

Decided by Hooman:

1. Stack: Vite + React + TipTap (open-source core only).
2. Raw format is TipTap JSON; Markdown export is wanted (slice S7).
3. No thresholds for the textbook: only a quiet stale-file count.
4. Default enrichment mode is `flag-gaps`. The user can switch to `light-add` after testing the chosen model with the
   Test model button.
5. Textbook (accepted from the S6 build): the `assign` delta op; undo snapshots at `.metis/textbook/history/<n>.json`; a
   section is also regenerated when its file list changes; a file in no section is stale; unaccepted `aiAdded` text is
   left out of the textbook input; section titles come from clean content (section 7).
6. Model replies: `<think>` blocks are stripped in the provider client (section 8); Latin terms are enforced in code
   (6.4).
