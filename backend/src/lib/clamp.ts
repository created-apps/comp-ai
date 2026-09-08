/**
 * Post-parse limits for model output.
 *
 * Length and range limits must NOT be expressed as zod constraints on a
 * structured-output schema. The SDK validates the model's response against the
 * schema and throws when it does not fit, so a single reason 30 characters over
 * a `.max(320)` discards the entire result set — seven good recommendations and
 * ~35 seconds of model work lost to a presentation detail.
 *
 * So schemas describe *shape*, prompts ask for brevity, and these functions
 * enforce it afterwards where being wrong costs nothing.
 */

/**
 * Trim to `max` characters, preferring a sentence break and then a word break so
 * the result does not end mid-word. Only appends an ellipsis when it actually cut.
 */
export function clampText(value: string, max: number): string {
  const text = value.trim();
  if (text.length <= max) return text;

  const window = text.slice(0, max);

  // Prefer ending on a sentence, if one ends reasonably late in the window.
  const sentenceEnd = Math.max(
    window.lastIndexOf('. '),
    window.lastIndexOf('! '),
    window.lastIndexOf('? '),
  );
  if (sentenceEnd > max * 0.6) return window.slice(0, sentenceEnd + 1).trim();

  const wordEnd = window.lastIndexOf(' ');
  const cut = wordEnd > max * 0.6 ? window.slice(0, wordEnd) : window;
  return `${cut.trimEnd().replace(/[,;:]$/, '')}…`;
}

export function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** Keep at most `max` entries, dropping empties first. */
export function clampList(values: string[], max: number): string[] {
  return values.map((v) => v.trim()).filter(Boolean).slice(0, max);
}
