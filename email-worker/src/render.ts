/**
 * Rendering: blocks + merge variables → subject, HTML and plain text.
 *
 * Both parts come from one source so they can never say different things.
 */

import type { Block, EmailTemplate } from './templates/blocks.js';
import { assetUrl, SITE_URL } from './templates/blocks.js';

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

  return {
    subject,
    html: wrap(subject, htmlParts.join('\n'), template),
    text: textParts.join('\n\n').trim(),
  };
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
          `<h2 style="margin:20px 0 8px;font-size:17.3px;line-height:1.4;font-weight:700;color:#ec4e20;font-family:Arial, Helvetica, sans-serif;">${escapeHtml(name)}</h2>`,
        );
        if (body) {
          html.push(
            `<p style="margin:0 0 16px;font-size:14.7px;line-height:22.1px;color:#272e1c;font-family:Arial, Helvetica, sans-serif;">${escapeHtml(body)}</p>`,
          );
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
      const isGreeting = /^Hi\s|^Hello\s/i.test(value.trim());
      const isEmphasisHeading = /^(Strong competition participation|At CreatED, our program|The projects that tend)/i.test(value.trim());
      const fontWeight = isGreeting || isEmphasisHeading ? 'font-weight:700;' : 'font-weight:normal;';
      html.push(
        `<p style="margin:0 0 16px;font-size:14.7px;line-height:22.1px;color:#000000;font-family:Arial, Helvetica, sans-serif;${fontWeight}">${escapeHtml(value)}</p>`,
      );
      text.push(value);
      break;
    }
    case 'h': {
      const value = sub(block.text);
      html.push(
        `<h2 style="margin:24px 0 10px;font-size:17.3px;line-height:1.4;font-weight:700;color:#272e1c;font-family:Arial, Helvetica, sans-serif;">${escapeHtml(value)}</h2>`,
      );
      text.push(value.toUpperCase());
      break;
    }
    case 'ul': {
      const items = block.items.map(sub);
      const rows = items
        .map(
          (item) => `<tr>
  <td style="width:20px;vertical-align:top;padding-right:8px;text-align:right;font-size:14.7px;color:#000000;line-height:22.1px;">•</td>
  <td style="font-size:14.7px;color:#000000;vertical-align:top;line-height:22.1px;font-family:Arial, Helvetica, sans-serif;">${escapeHtml(item)}</td>
</tr>`,
        )
        .join('');
      html.push(
        `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;border-collapse:collapse;font-family:Arial, Helvetica, sans-serif;"><tbody>${rows}</tbody></table>`,
      );
      text.push(items.map((i) => `• ${i}`).join('\n'));
      break;
    }
    case 'ol': {
      const items = block.items.map(sub);
      const rows = items
        .map(
          (item, idx) => `<tr>
  <td style="width:24px;vertical-align:top;padding-right:8px;font-size:14.7px;color:#000000;line-height:22.1px;">${idx + 1}.</td>
  <td style="font-size:14.7px;color:#000000;vertical-align:top;line-height:22.1px;font-family:Arial, Helvetica, sans-serif;">${escapeHtml(item)}</td>
</tr>`,
        )
        .join('');
      html.push(
        `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;border-collapse:collapse;font-family:Arial, Helvetica, sans-serif;"><tbody>${rows}</tbody></table>`,
      );
      text.push(items.map((i, idx) => `${idx + 1}. ${i}`).join('\n'));
      break;
    }
    case 'quote': {
      const value = sub(block.text);
      html.push(
        `<div style="margin:0 0 16px;padding:2px 0;font-style:italic;font-size:14.7px;line-height:22.1px;color:#272e1c;font-family:Arial, Helvetica, sans-serif;">“${escapeHtml(value)}”</div>`,
      );
      text.push(`"${value}"`);
      break;
    }
    case 'cta': {
      const label = sub(block.label);
      // The url is substituted too, so a template can link to a specific record
      // (a review, a run) rather than only to a fixed marketing page.
      const url = sub(block.url);
      const msoWidth = Math.max(180, Math.min(280, label.length * 11 + 40));
      html.push(
        `<table cellpadding="0" cellspacing="0" border="0" style="width:100%;margin:20px 0 24px;">
  <tbody><tr><td align="center">
    <!--[if mso]>
    <table cellpadding="0" cellspacing="0" border="0" width="${msoWidth}" style="width:${msoWidth}px;">
      <tbody><tr><td>
      <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${escapeHtml(url)}" style="height:42px;width:${msoWidth}px;v-text-anchor:middle;" arcsize="100%" fillcolor="#ec4e20">
        <v:stroke dashstyle="Solid" weight="0px" color="#ec4e20"/>
        <w:anchorlock/>
        <v:textbox inset="0px,0px,0px,0px"><center style="color:#ffffff;font-family:Arial, sans-serif;font-size:13.5px;font-weight:700;">${escapeHtml(label)}</center></v:textbox>
      </v:roundrect>
      </td></tr></tbody>
    </table>
    <![endif]-->
    <!--[if !mso]><!-->
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;border-collapse:separate;border-spacing:0;">
      <tbody><tr>
        <td bgcolor="#ec4e20" style="background-color:#ec4e20;border-radius:100px;text-align:center;">
          <a href="${escapeHtml(url)}" target="_blank" rel="noopener" style="color:#ffffff;text-decoration:none;display:block;padding:11px 26px;text-align:center;font-family:Arial, Helvetica, sans-serif;font-size:13.5px;font-weight:700;line-height:19px;letter-spacing:0em;">
            <span style="color:#ffffff;">${escapeHtml(label)}</span>
          </a>
        </td>
      </tr></tbody>
    </table>
    <!--<![endif]-->
  </td></tr></tbody>
</table>`,
      );
      text.push(`${label}: ${url}`);
      break;
    }
    case 'card': {
      const title = sub(block.title);
      const titleHtml = `<div style="font-size:24px;line-height:1.3;font-weight:700;color:#ec4e20;font-family:'Times New Roman', Times, Georgia, serif;margin-bottom:12px;">${escapeHtml(title)}</div>`;
      let bodyHtml = '';
      if (block.fields && block.fields.length > 0) {
        bodyHtml = block.fields
          .map((f) => {
            const labelStr = f.label
              ? `<span style="font-weight:700;color:#272e1c;font-family:Arial, Helvetica, sans-serif;">${escapeHtml(sub(f.label))} </span>`
              : '';
            const italicStyle = f.italic ? 'font-style:italic;' : '';
            const boldStyle = f.bold ? 'font-weight:700;' : '';
            const valStr = `<span style="${italicStyle}${boldStyle}color:#272e1c;font-family:Arial, Helvetica, sans-serif;">${escapeHtml(sub(f.value))}</span>`;
            return `<div style="margin:0 0 8px;font-size:14.7px;line-height:22.1px;color:#272e1c;font-family:Arial, Helvetica, sans-serif;">${labelStr}${valStr}</div>`;
          })
          .join('');
      } else if (block.body) {
        bodyHtml = `<div style="margin:0 0 8px;font-size:14.7px;line-height:22.1px;color:#272e1c;font-family:Arial, Helvetica, sans-serif;">${escapeHtml(sub(block.body))}</div>`;
      }

      html.push(
        `<table border="0" cellpadding="0" cellspacing="0" align="center" width="100%" style="margin:16px 0;border-collapse:separate;background-color:#fdfc9e;background:radial-gradient(circle at 0% 0%, #fdfc9e,#ffd83d,#f5ff37);border-radius:10px;">
  <tbody>
    <tr>
      <td style="padding:20px 24px;text-align:left;">
        ${titleHtml}
        ${bodyHtml}
      </td>
    </tr>
  </tbody>
</table>`,
      );

      text.push(title.toUpperCase());
      if (block.fields) {
        for (const f of block.fields) {
          const l = f.label ? `${sub(f.label)} ` : '';
          text.push(`${l}${sub(f.value)}`);
        }
      } else if (block.body) {
        text.push(sub(block.body));
      }
      break;
    }
    case 'showcase': {
      const award = sub(block.awardTitle);
      const [s1, s2] = block.students;
      const s1Name = sub(s1.name);
      const s1Desc = sub(s1.description);
      const s2Name = sub(s2.name);
      const s2Desc = sub(s2.description);

      html.push(
        `<h3 style="margin:28px 0 16px;font-size:22px;line-height:1.4;font-weight:700;color:#ec4e20;font-family:Georgia, serif;text-align:center;">${escapeHtml(award)}</h3>
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;border-collapse:separate;">
  <tbody>
    <tr>
      <td width="48%" style="width:48%;vertical-align:top;padding:0 8px 16px 0;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0">
          <tbody>
            <tr><td align="center"><img src="${assetUrl(s1.image)}" width="262" height="175" alt="${escapeHtml(s1Name)}" style="display:block;width:100%;max-width:262px;height:auto;border-radius:6px;border:0;" /></td></tr>
            <tr><td style="padding:10px 0 4px;text-align:center;font-size:15px;font-weight:800;color:#000000;font-family:Arial, Helvetica, sans-serif;">${escapeHtml(s1Name)}</td></tr>
            <tr><td style="font-size:12px;line-height:19px;color:#000000;text-align:justify;font-family:Arial, Helvetica, sans-serif;">${escapeHtml(s1Desc)}</td></tr>
          </tbody>
        </table>
      </td>
      <td width="4%" style="width:4%;font-size:0;line-height:0;">&nbsp;</td>
      <td width="48%" style="width:48%;vertical-align:top;padding:0 0 16px 8px;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0">
          <tbody>
            <tr><td align="center"><img src="${assetUrl(s2.image)}" width="262" height="175" alt="${escapeHtml(s2Name)}" style="display:block;width:100%;max-width:262px;height:auto;border-radius:6px;border:0;" /></td></tr>
            <tr><td style="padding:10px 0 4px;text-align:center;font-size:15px;font-weight:800;color:#000000;font-family:Arial, Helvetica, sans-serif;">${escapeHtml(s2Name)}</td></tr>
            <tr><td style="font-size:12px;line-height:19px;color:#000000;text-align:justify;font-family:Arial, Helvetica, sans-serif;">${escapeHtml(s2Desc)}</td></tr>
          </tbody>
        </table>
      </td>
    </tr>
  </tbody>
</table>`,
      );

      text.push(award.toUpperCase());
      text.push(`${s1Name}\n${s1Desc}`);
      text.push(`${s2Name}\n${s2Desc}`);
      break;
    }
    case 'hr': {
      html.push('<hr style="border:none;border-top:1px solid #e4e4e7;margin:24px 0;" />');
      text.push('---');
      break;
    }
  }
}

function wrap(title: string, body: string, template?: EmailTemplate): string {
  const banner = template?.banner;
  const bannerHtml = banner
    ? `<table cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;margin:0 auto;">
  <tbody><tr><td align="center" style="width:100%;">
    <img src="${assetUrl(banner.image)}" width="${banner.width ?? 600}" height="${banner.height ?? 'auto'}" alt="${escapeHtml(banner.alt ?? title)}" style="display:block;width:600px;height:auto;max-width:100%;border:0;" />
  </td></tr></tbody>
</table>`
    : '';

  const footerStyle = template?.footerStyle ?? 'yellow-simple';
  let footerHtml = '';
  if (footerStyle === 'yellow-simple') {
    const logoUrl = assetUrl('0a6938caf31b699ae76ebd063ede5497.png');
    footerHtml = `<table border="0" cellpadding="0" cellspacing="0" align="center" width="100%" style="width:100%;background-color:#ffd647;">
  <tbody><tr><td style="text-align:right;padding:24px;">
    <table cellpadding="0" cellspacing="0" border="0" align="right" style="margin-left:auto;">
      <tbody><tr><td>
        <img src="${logoUrl}" width="108" height="33" alt="CreatED" style="display:block;width:108px;height:auto;max-width:100%;border:0;" />
      </td></tr></tbody>
    </table>
  </td></tr></tbody>
</table>`;
  } else if (footerStyle === 'gradient') {
    const footerLogoHtml = template?.footerLogo
      ? `<table cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto 16px;">
      <tbody><tr><td>
        <img src="${assetUrl(template.footerLogo)}" width="125" height="37" alt="CreatED" style="display:block;width:125px;height:auto;max-width:100%;border:0;" />
      </td></tr></tbody>
    </table>`
      : '';
    footerHtml = `<table border="0" cellpadding="0" cellspacing="0" align="center" width="100%" style="width:100%;background-color:#ffffff;background:linear-gradient(180deg, #ffffff,#fff2bd,#ffda1e);">
  <tbody><tr><td style="text-align:center;padding:24px 24px 28px;">
    ${footerLogoHtml}
    <p style="margin:0;font-size:12px;line-height:20px;color:#272e1c;font-family:Arial, Helvetica, sans-serif;text-align:center;">
      Copyright &copy; 2026 CreatED. All rights reserved.
    </p>
  </td></tr></tbody>
</table>`;
  }

  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" lang="en">
<head>
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
<meta name="format-detection" content="telephone=no, date=no, address=no, email=no" />
<meta name="x-apple-disable-message-reformatting" />
<title>${escapeHtml(title)}</title>
<style>
body{margin:0;padding:0;-webkit-text-size-adjust:100%;text-size-adjust:100%;background-color:#f0f1f5;}
table{mso-table-lspace:0;mso-table-rspace:0;border-collapse:collapse;}
p,span,h1,h2,h3,h4,h5,h6{margin:0;padding:0;}
p{line-height:inherit;}
a[x-apple-data-detectors]{color:inherit!important;text-decoration:inherit!important;}
#MessageViewBody a{color:inherit;text-decoration:none;}
img+div{display:none;}
@media (max-width:599px){
  .ecw{width:100%!important;min-width:0!important;}
}
</style>
<!--[if mso]>
<noscript>
<xml>
<w:WordDocument xmlns:w="urn:schemas-microsoft-com:office:word"><w:DontUseAdvancedTypographyReadingMail/></w:WordDocument>
<o:OfficeDocumentSettings><o:AllowPNG/><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings>
</xml>
</noscript>
<![endif]-->
</head>
<body style="width:100%;-webkit-text-size-adjust:100%;text-size-adjust:100%;background-color:#f0f1f5;margin:0;padding:0;">
<table width="100%" border="0" cellpadding="0" cellspacing="0" bgcolor="#f0f1f5" style="background-color:#f0f1f5;">
<tbody><tr><td style="background-color:#f0f1f5;padding:0;">
<!--[if mso]><center><table align="center" border="0" cellpadding="0" cellspacing="0" width="600"><tbody><tr><td><![endif]-->
<table align="center" width="600" border="0" cellpadding="0" cellspacing="0" role="presentation" class="ecw" style="max-width:600px;margin:0 auto;background-color:#ffffff;width:600px;min-width:600px;">
<tbody>
  ${bannerHtml ? `<tr><td style="vertical-align:top;">${bannerHtml}</td></tr>` : ''}
  <tr>
    <td style="vertical-align:top;padding:24px 28px 16px;">
      <table align="center" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="color:#000000;font-size:14.7px;line-height:22.1px;font-family:Arial, Helvetica, sans-serif;">
        <tbody><tr><td>
          ${body}
          <p style="margin:24px 0 0;font-size:14.7px;line-height:22.1px;color:#000000;font-family:Arial, Helvetica, sans-serif;">
            Warmly,<br />
            Team CreatED<br />
            <a href="${SITE_URL}" target="_blank" rel="noopener" style="color:#1264a3;text-decoration:none;">${SITE_URL.replace('https://', '')}</a>
          </p>
        </td></tr></tbody>
      </table>
    </td>
  </tr>
  ${footerHtml ? `<tr><td style="vertical-align:top;">${footerHtml}</td></tr>` : ''}
</tbody>
</table>
<!--[if mso]></td></tr></tbody></table></center><![endif]-->
</td></tr></tbody>
</table>
</body>
</html>`;
}
