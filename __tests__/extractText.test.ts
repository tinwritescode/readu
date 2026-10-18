import { documentFromPicked } from '../src/features/import/DocumentImporter';
import { pdfToText } from '../src/features/import/extractText';

describe('PDF', () => {
  it('rejoins wrapped lines into paragraphs and fixes hyphenation', () => {
    const page = 'The quick brown fox jumps over the\nlazy dog. It was a sunny\nafter-\nnoon in the park.\n\nNew paragraph here';
    expect(pdfToText([page])).toBe(
      'The quick brown fox jumps over the lazy dog. It was a sunny afternoon in the park.\n\nNew paragraph here',
    );
  });

  it('starts a new paragraph after a short heading line', () => {
    const page =
      'Chapter 3\nThe rain had not stopped for three days and the river was rising\nfaster than anyone in the village could remember';
    expect(pdfToText([page])).toBe(
      'Chapter 3\n\nThe rain had not stopped for three days and the river was rising faster than anyone in the village could remember',
    );
  });

  it('keeps pages apart and uses the PDF title', () => {
    const doc = documentFromPicked({ name: 'report.pdf', kind: 'pdf', title: 'Annual report', pages: ['One.', '', 'Two.'] });
    expect(doc).toMatchObject({ title: 'Annual report', format: 'pdf', text: 'One.\n\nTwo.' });
  });

  it('explains a scanned PDF with no text layer', () => {
    expect(() => documentFromPicked({ name: 'scan.pdf', kind: 'pdf', title: null, pages: ['', ' '] })).toThrow(
      /may be a scan/,
    );
  });
});

describe('Word', () => {
  const body = (paragraphs: string) =>
    `<?xml version="1.0"?><w:document><w:body>${paragraphs}</w:body></w:document>`;

  it('reads paragraphs, joins runs, and decodes entities', () => {
    const doc = documentFromPicked({
      name: 'Letter.docx',
      kind: 'docx',
      files: {
        'word/document.xml': body(
          '<w:p><w:pPr><w:tabs><w:tab w:val="left"/></w:tabs></w:pPr><w:r><w:t>Dear </w:t></w:r><w:r><w:t xml:space="preserve">Tom &amp; Ann,</w:t></w:r></w:p>' +
            '<w:p></w:p>' +
            '<w:p><w:r><w:t>Xin chào</w:t><w:br/><w:t>line two</w:t></w:r></w:p>',
        ),
      },
    });
    expect(doc).toMatchObject({ title: 'Letter', format: 'docx', text: 'Dear Tom & Ann,\n\nXin chào\nline two' });
  });

  it('prefers the title from document properties', () => {
    const doc = documentFromPicked({
      name: 'x.docx',
      kind: 'docx',
      files: {
        'word/document.xml': body('<w:p><w:r><w:t>Hi</w:t></w:r></w:p>'),
        'docProps/core.xml': '<cp:coreProperties><dc:title>My essay</dc:title></cp:coreProperties>',
      },
    });
    expect(doc.title).toBe('My essay');
  });
});

describe('EPUB', () => {
  it('joins Readium paragraphs and uses the book title', () => {
    const doc = documentFromPicked({
      name: 'moby.epub',
      kind: 'epub',
      title: 'Moby Dick',
      paragraphs: ['Loomings', 'Call me\n   Ishmael.', '  ', 'I stuffed a shirt\nor two.'],
    });
    expect(doc).toMatchObject({
      title: 'Moby Dick',
      format: 'epub',
      text: 'Loomings\n\nCall me\nIshmael.\n\nI stuffed a shirt\nor two.',
    });
  });

  it('keeps the cover Readium saved, and omits a missing one', () => {
    const picked = { name: 'm.epub', kind: 'epub' as const, title: null, paragraphs: ['Hi'] };
    expect(documentFromPicked({ ...picked, cover: 'A1.jpg' }).cover).toBe('A1.jpg');
    expect(documentFromPicked({ ...picked, cover: null })).not.toHaveProperty('cover');
  });

  it('falls back to the file name and rejects a book with no text', () => {
    expect(documentFromPicked({ name: 'b.epub', kind: 'epub', title: null, paragraphs: ['Hi'] }).title).toBe('b');
    expect(() => documentFromPicked({ name: 'c.epub', kind: 'epub', title: null, paragraphs: [] })).toThrow(/no text/);
  });
});

it('plain text keeps the file name as title', () => {
  expect(documentFromPicked({ name: 'notes.final.txt', kind: 'txt', text: 'hello' })).toMatchObject({
    title: 'notes.final',
    text: 'hello',
  });
});
