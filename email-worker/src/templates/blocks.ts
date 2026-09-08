/**
 * Email copy is authored as blocks, not as HTML strings.
 *
 * One source renders both the HTML and the plain-text alternative, so the two
 * can never drift — a text part that says something different from the HTML part
 * is a classic way to land in spam. It also means the marketing copy stays
 * readable and editable by someone who does not write HTML.
 */

export type Block =
  | { type: 'p'; text: string }
  | { type: 'h'; text: string }
  | { type: 'ul'; items: string[] }
  | { type: 'ol'; items: string[] }
  | { type: 'quote'; text: string }
  | { type: 'cta'; label: string; url: string }
  /**
   * Repeats a numbered family of variables — "Competition 1"/"Why it fits 1",
   * "Competition 2"/… — stopping at the first gap. The report is 5-8 items and
   * the count varies per student, so the template cannot hard-code slots.
   */
  | { type: 'repeat'; namePrefix: string; bodyPrefix: string; max: number }
  | { type: 'hr' };

export const p = (text: string): Block => ({ type: 'p', text });
export const h = (text: string): Block => ({ type: 'h', text });
export const ul = (items: string[]): Block => ({ type: 'ul', items });
export const ol = (items: string[]): Block => ({ type: 'ol', items });
export const quote = (text: string): Block => ({ type: 'quote', text });
export const cta = (label: string, url: string): Block => ({ type: 'cta', label, url });
export const repeat = (namePrefix: string, bodyPrefix: string, max = 8): Block => ({
  type: 'repeat',
  namePrefix,
  bodyPrefix,
  max,
});
export const hr = (): Block => ({ type: 'hr' });

export const CONSULT_URL = 'https://www.create-ed.in/schedule-a-consultation';
export const SITE_URL = 'https://www.create-ed.in';

export const bookCall = (label = 'Schedule a Consultation'): Block => cta(label, CONSULT_URL);

export interface EmailTemplate {
  subject: string;
  blocks: Block[];
  /** Placeholders this template needs. Missing ones abort the send. */
  requires?: string[];
}
