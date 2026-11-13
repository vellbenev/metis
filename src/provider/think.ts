// Reasoning models (Qwen3, DeepSeek-R1, ...) may put their reasoning in <think>...</think> before the
// answer. It is never part of the answer, so it is removed before any reply is parsed.

const OPEN = /<think>/i;
const CLOSE = /<\/think>/i;

/**
 * Removes reasoning blocks from a model reply:
 * - every `<think>...</think>` block (multiline, any number, tags matched case-insensitively);
 * - a `</think>` with no `<think>` before it (some chat templates put the opening tag in the prompt):
 *   everything up to and including it;
 * - an unclosed `<think>` (the reply was cut off while reasoning): everything from it to the end.
 *   What is left is usually empty, so the reply fails validation and is retried or reported, rather
 *   than reasoning text being parsed as the answer.
 * A reply without think tags is returned unchanged; otherwise the result is trimmed.
 */
export function stripThinking(content: string): string {
	if (!OPEN.test(content) && !CLOSE.test(content)) return content;
	let text = content;
	const close = CLOSE.exec(text);
	const open = OPEN.exec(text);
	if (close && (!open || close.index < open.index)) text = text.slice(close.index + close[0].length);
	text = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
	const unclosed = OPEN.exec(text);
	if (unclosed) text = text.slice(0, unclosed.index);
	return text.trim();
}
