/**
 * Raw file content as the native picker returns it. EPUB and PDF come from Readium
 * (VttsReadium.swift); Word and TXT from VttsDocuments.m.
 */
export type PickedDocument =
  | { name: string; kind: 'txt'; text: string }
  | { name: string; kind: 'epub'; title: string | null; paragraphs: string[]; cover?: string | null }
  | { name: string; kind: 'pdf'; title: string | null; pages: string[]; cover?: string | null }
  | { name: string; kind: 'docx'; files: Record<string, string> };

export interface ExtractedText {
  title?: string;
  /** Paragraphs separated by a blank line. */
  text: string;
}

export function extractText(doc: PickedDocument): ExtractedText {
  switch (doc.kind) {
    case 'txt':
      return { text: doc.text };
    case 'pdf':
      return { title: doc.title?.trim() || undefined, text: pdfToText(doc.pages) };
    case 'docx':
      return docxToText(doc.files);
    case 'epub':
      return { title: doc.title?.trim() || undefined, text: tidy(doc.paragraphs.map(tidy).filter(Boolean).join('\n\n')) };
  }
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (match, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

function tidy(text: string): string {
  return text
    .split('\n')
    .map(line => line.replace(/[ \t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * PDF text comes with hard line breaks at the page width; rejoin them into paragraphs.
 * A line that ends a sentence, or stops well short of the page width (a heading, the
 * last line of a paragraph), ends its paragraph.
 */
export function pdfToText(pages: string[]): string {
  return pages
    .map(page => {
      const lines = page.split(/\r?\n/).map(line => line.trim());
      const fullWidth = Math.max(...lines.map(line => line.length));
      let out = '';
      let previous = '';
      for (const line of lines) {
        if (!line) {
          if (out && !out.endsWith('\n\n')) out += '\n\n';
        } else if (!out || out.endsWith('\n\n')) {
          out += line;
        } else if (/-$/.test(previous) && /^\p{Ll}/u.test(line)) {
          out = out.slice(0, -1) + line;
        } else if (/[.!?…:"”]$/.test(previous) || previous.length < fullWidth * 0.6) {
          out += '\n\n' + line;
        } else {
          out += ' ' + line;
        }
        previous = line;
      }
      return out.trim();
    })
    .filter(Boolean)
    .join('\n\n');
}

function xmlTag(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(xml);
  const value = match ? tidy(decodeEntities(match[1].replace(/<[^>]+>/g, ''))) : '';
  return value || undefined;
}

export function docxToText(files: Record<string, string>): ExtractedText {
  const xml = files['word/document.xml'];
  if (!xml) throw new Error('This Word file has no document body.');
  const paragraphs = xml.split(/<\/w:p>/).map(chunk => {
    let text = '';
    const runs = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br\b[^>]*\/>/g;
    for (let m = runs.exec(chunk); m; m = runs.exec(chunk)) {
      if (m[1] !== undefined) text += m[1];
      else text += m[0].startsWith('<w:tab') ? '\t' : '\n';
    }
    return decodeEntities(text);
  });
  const core = files['docProps/core.xml'];
  return {
    title: core ? xmlTag(core, 'dc:title') : undefined,
    text: tidy(paragraphs.filter(p => p.trim()).join('\n\n')),
  };
}
