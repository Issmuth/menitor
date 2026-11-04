// Read just the doc section a task links to (C-10), so a task loads only what it needs.

import fs from 'node:fs';
import path from 'node:path';

/** Sections longer than this are cut, with a note saying so. */
export const MAX_SECTION_CHARS = 4000;

/**
 * A heading's anchor, the way GitHub makes it: lowercase, punctuation dropped, spaces to hyphens.
 * @param {string} heading
 */
export function slugify(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/<[^>]*>/g, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

/**
 * Find the section under the heading whose anchor matches. The section runs to the next
 * heading of the same or a higher level. Headings inside code fences don't count.
 * @param {string} markdown
 * @param {string} anchor
 * @returns {{ heading: string, text: string } | null}
 */
export function extractSection(markdown, anchor) {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const want = anchor.replace(/^#/, '').toLowerCase();
  /** @type {Map<string, number>} */
  const seen = new Map();
  let fence = false;
  let start = -1;
  let level = 0;
  let heading = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (fence) continue;
    const m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const depth = m[1].length;
    if (start !== -1 && depth <= level) {
      return { heading, text: lines.slice(start, i).join('\n').trim() };
    }
    if (start === -1) {
      // GitHub numbers repeated headings: setup, setup-1, setup-2.
      const base = slugify(m[2]);
      const count = seen.get(base) ?? 0;
      seen.set(base, count + 1);
      const slug = count ? `${base}-${count}` : base;
      if (slug === want) {
        start = i;
        level = depth;
        heading = m[2];
      }
    }
  }
  return start === -1 ? null : { heading, text: lines.slice(start).join('\n').trim() };
}

/**
 * Read a docs link such as "docs/prd.md#sign-up" relative to the project root.
 * @param {string} root
 * @param {string} link
 * @returns {{ file: string, anchor: string | null, found: 'section' | 'file' | 'missing-file' | 'missing-section', text: string, truncated: boolean }}
 */
export function readDocLink(root, link) {
  const [file, anchor = null] = link.split('#');
  const abs = path.resolve(root, file);
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel) || !fs.existsSync(abs)) {
    return { file, anchor, found: 'missing-file', text: '', truncated: false };
  }
  const markdown = fs.readFileSync(abs, 'utf8');
  let text = markdown.trim();
  /** @type {'section' | 'file' | 'missing-section'} */
  let found = 'file';
  if (anchor) {
    const section = extractSection(markdown, anchor);
    if (section) {
      text = section.text;
      found = 'section';
    } else {
      found = 'missing-section';
    }
  }
  const truncated = text.length > MAX_SECTION_CHARS;
  return { file, anchor, found, text: truncated ? text.slice(0, MAX_SECTION_CHARS) : text, truncated };
}
