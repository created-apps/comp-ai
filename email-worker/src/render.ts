/**
 * Rendering: blocks + merge variables → subject, HTML and plain text.
 *
 * Both parts come from one source so they can never say different things.
 */

import type { Block, EmailTemplate } from './templates/blocks.js';
import { SITE_URL } from './templates/blocks.js';

const PLACEHOLDER = /\{\{([^}]+)\}\}/g;

export class MissingVariablesError extends Error {
  constructor(readonly missing: string[]) {
    super(`missing merge variables: ${missing.join(', ')}`);
    this.name = 'MissingVariablesError';
  }
}

/**
 * Substitute {{Name}} placeholders.
 *
 * `Student/Parent Name` falls back to `Student Name` — the copy addresses either,
 * and the backend does not always know which. An unresolved placeholder is never
 * left in the output: it would ship "Hi {{Student Name}}," to a real family.
 *
 * A key the sender supplied as an empty string is NOT missing. Absent means the
 * backend never mentioned it; empty means it did and there was nothing to say —
 * a student with no grade, school or country on file produces an empty "Student
 * Context", and treating that as missing failed the whole internal review email
 * permanently over an optional line. Whether an empty value is acceptable is
 * decided by the template's `requires` list, not here.
 */
export function fill(text: string, variables: Record<string, string>): { out: string; missing: string[] } {
  const missing: string[] = [];
  const out = text.replace(PLACEHOLDER, (_match, rawKey: string) => {
    const key = rawKey.trim();
    if (key in variables) return variables[key] ?? '';

    if (key === 'Student/Parent Name') {
      const fallback = variables['Parent Name'] ?? variables['Student Name'];
      if (fallback) return fallback;
      return 'there';
    }
    missing.push(key);
    return '';
  });
  return { out, missing };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface Rendered {
  subject: string;
  html: string;
  text: string;
}

export function render(template: EmailTemplate, variables: Record<string, string>): Rendered {
  const missing = new Set<string>();

  const sub = (value: string): string => {
    const { out, missing: m } = fill(value, variables);
    m.forEach((key) => missing.add(key));
    return out;
  };

  const subject = sub(template.subject);
  const htmlParts: string[] = [];
  const textParts: string[] = [];

  for (const block of template.blocks) {
    renderBlock(block, sub, htmlParts, textParts, variables);
  }

  // Required variables are checked against what the template actually declares,
  // not just what it happened to reference, so an empty {{Competition 2}} stops
  // the send instead of going out with a blank line where a name should be.
  const required = template.requires ?? [];
  const absent = required.filter((key) => !variables[key]?.trim());
  const all = [...new Set([...missing, ...absent])];
  if (all.length > 0) throw new MissingVariablesError(all);

  return { subject, html: wrap(subject, htmlParts.join('\n')), text: textParts.join('\n\n').trim() };
}

function renderBlock(
  block: Block,
  sub: (v: string) => string,
  html: string[],
  text: string[],
  variables: Record<string, string>,
): void {
  switch (block.type) {
    case 'repeat': {
      // Stop at the first missing slot rather than emitting empty headings for
      // the unused ones.
      for (let i = 1; i <= block.max; i++) {
        const name = variables[`${block.namePrefix} ${i}`];
        if (!name?.trim()) break;
        const body = variables[`${block.bodyPrefix} ${i}`] ?? '';
        html.push(
          `<h2 style="margin:24px 0 8px;font-size:17px;line-height:1.4;font-weight:700;">${escapeHtml(name)}</h2>`,
        );
        if (body) {
          html.push(`<p style="margin:0 0 16px;line-height:1.6;">${escapeHtml(body)}</p>`);
        }
        text.push(name.toUpperCase());
        if (body) text.push(body);
      }
      break;
    }
    case 'p': {
      const value = sub(block.text);
      // A paragraph that is nothing but an optional variable disappears when
      // that variable is empty, rather than leaving a blank line in the text
      // part and an empty <p> in the HTML.
      if (value.trim() === '') break;
      html.push(`<p style="margin:0 0 16px;line-height:1.6;">${escapeHtml(value)}</p>`);
      text.push(value);
      break;
    }
    case 'h': {
      const value = sub(block.text);
      html.push(
        `<h2 style="margin:28px 0 12px;font-size:17px;line-height:1.4;font-weight:700;">${escapeHtml(value)}</h2>`,
      );
      text.push(value.toUpperCase());
      break;
    }
    case 'ul':
    case 'ol': {
      const items = block.items.map(sub);
      const tag = block.type;
      html.push(
        `<${tag} style="margin:0 0 16px;padding-left:22px;line-height:1.6;">` +
          items.map((i) => `<li style="margin-bottom:6px;">${escapeHtml(i)}</li>`).join('') +
          `</${tag}>`,
      );
      text.push(
        items.map((i, idx) => (tag === 'ol' ? `${idx + 1}. ${i}` : `• ${i}`)).join('\n'),
      );
      break;
    }
    case 'quote': {
      const value = sub(block.text);
      html.push(
        `<blockquote style="margin:0 0 16px;padding:12px 16px;border-left:3px solid #d4d4d8;color:#3f3f46;font-style:italic;line-height:1.6;">${escapeHtml(value)}</blockquote>`,
      );
      text.push(`"${value}"`);
      break;
    }
    case 'cta': {
      const label = sub(block.label);
      // The url is substituted too, so a template can link to a specific record
      // (a review, a run) rather than only to a fixed marketing page.
      const url = sub(block.url);
      html.push(
        `<p style="margin:24px 0;"><a href="${escapeHtml(url)}" style="display:inline-block;background:#1d4ed8;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;">${escapeHtml(label)}</a></p>`,
      );
      text.push(`${label}: ${url}`);
      break;
    }
    case 'hr': {
      html.push('<hr style="border:none;border-top:1px solid #e4e4e7;margin:28px 0;" />');
      text.push('---');
      break;
    }
  }
}

function wrap(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f5;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:28px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:14px;padding:34px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;color:#18181b;">
<tr><td>
${body}
<p style="margin:28px 0 0;line-height:1.6;">Warmly,<br />Team CreatED<br /><a href="${SITE_URL}" style="color:#1d4ed8;">${SITE_URL.replace('https://', '')}</a></p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}
