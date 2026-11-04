// Plain-language checks from the PRD: sentences under 25 words, a "Why" of two sentences or fewer,
// and no code on a task card.

export const MAX_WORDS = 25;
export const MAX_WHY_SENTENCES = 2;

/**
 * @param {string} text
 * @returns {string[]}
 */
export function sentences(text) {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * @param {string} text
 */
export function wordCount(text) {
  return text.split(/\s+/).filter(Boolean).length;
}

const CODE_LIKE = /=>|[{}]|;\s*$|\(\)\s*[{;]|<\/?[a-z]+[^>]*>|\b(?:const|let|var|function|return|import|SELECT)\s+\S/;

/**
 * Warnings for one piece of card text.
 * @param {string} where  e.g. "t7 why"
 * @param {string} text
 * @param {{ maxSentences?: number }} [options]
 * @returns {string[]}
 */
export function languageWarnings(where, text, options = {}) {
  const warnings = [];
  const parts = sentences(text);
  if (options.maxSentences !== undefined && parts.length > options.maxSentences) {
    warnings.push(`${where} has ${parts.length} sentences; keep it to ${options.maxSentences} or fewer`);
  }
  for (const s of parts) {
    const n = wordCount(s);
    if (n >= MAX_WORDS) warnings.push(`${where} has a ${n}-word sentence; keep sentences under ${MAX_WORDS} words`);
  }
  if (CODE_LIKE.test(text)) warnings.push(`${where} looks like code; a card never contains code`);
  return warnings;
}
