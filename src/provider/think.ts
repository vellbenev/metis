// Reasoning models (Qwen3, DeepSeek-R1, ...) may put their reasoning in <think>...</think> before the
// answer. It is never part of the answer, so it is removed before any reply is parsed. Only a leading
// reasoning prefix is removed: tags later in the reply may be the user's own text (a note about AI that
// quotes <think>) and are kept as they are.

const LEADING_OPEN = /^\s*<think>/i;
const CLOSE = /<\/think>/i;
/** The answer has already started: JSON or a code fence. */
const ANSWER_START = /^\s*(?:[{[]|```)/;

/**
 * Removes the reasoning prefix of a model reply:
 * - one or more `<think>...</think>` blocks at the start (leading whitespace allowed, tags matched
 *   case-insensitively, any number of lines);
 * - an orphan `</think>` (some chat templates put the opening tag in the prompt): everything up to and
 *   including the first `</think>`, but only when the reply has no `<think>` before it and does not
 *   start like an answer (`{`, `[` or a code fence);
 * - an unclosed leading `<think>` (the reply was cut off while reasoning): the result is empty, so the
 *   reply fails validation and is retried or reported, rather than reasoning being parsed as the answer.
 * Tags anywhere else are kept. A reply without a reasoning prefix is returned unchanged; otherwise the
 * result is trimmed.
 */
export function stripThinking(content: string): string {
	let text = content;
	let stripped = false;
	const close = CLOSE.exec(text);
	if (close && !ANSWER_START.test(text) && !/<think>/i.test(text.slice(0, close.index))) {
		text = text.slice(close.index + close[0].length);
		stripped = true;
	}
	while (LEADING_OPEN.test(text)) {
		const end = CLOSE.exec(text);
		if (!end) return '';
		text = text.slice(end.index + end[0].length);
		stripped = true;
	}
	return stripped ? text.trim() : content;
}
