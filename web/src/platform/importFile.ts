import { strFromU8, unzipSync, type Unzipped } from 'fflate';
import type { ReaderDocument } from '@shared/domain/types';
import { documentFromPicked } from '@shared/features/import/DocumentImporter';
import type { EpubContent, PickedDocument } from '@shared/features/import/extractText';
import { saveCover } from './storage';

/** What the file input offers: the formats the iOS picker opens. */
export const ACCEPTED_FILES = '.txt,.text,.md,.epub,.pdf,.docx,text/plain,application/epub+zip,application/pdf';

/**
 * Reads a file the person picked into the same PickedDocument the iOS picker
 * returns (VttsDocuments.m, VttsReadium.swift), then hands it to the shared
 * extractText through documentFromPicked.
 */
export async function importFile(file: File): Promise<ReaderDocument> {
  const ext = file.name.split('.').pop()?.toLowerCase();
  let picked: PickedDocument;
  if (ext === 'epub') picked = await readEpub(file);
  else if (ext === 'pdf') picked = await readPdf(file);
  else if (ext === 'docx') picked = readDocx(file.name, unzipSync(new Uint8Array(await file.arrayBuffer())));
  else if (ext === 'doc') throw new Error('Old .doc files are not supported. Save it as .docx and try again.');
  else picked = { name: file.name, kind: 'txt', text: await file.text() };
  return documentFromPicked(picked);
}

function readDocx(name: string, zip: Unzipped): PickedDocument {
  const files: Record<string, string> = {};
  for (const path of ['word/document.xml', 'docProps/core.xml']) {
    if (zip[path]) files[path] = strFromU8(zip[path]);
  }
  return { name, kind: 'docx', files };
}

// EPUB

const BLOCKS = 'p, h1, h2, h3, h4, h5, h6, li, blockquote, pre, dt, dd, figcaption';

function parseXml(text: string, type: DOMParserSupportedType = 'application/xhtml+xml'): Document {
  const doc = new DOMParser().parseFromString(text, type);
  // Plenty of EPUBs carry XHTML that is not well-formed; the HTML parser forgives it.
  return doc.querySelector('parsererror') ? new DOMParser().parseFromString(text, 'text/html') : doc;
}

/** `href` relative to the file at `base`, as a path inside the zip. */
function resolvePath(base: string, href: string): string {
  const parts = base.split('/').slice(0, -1);
  for (const part of decodeURIComponent(href.split('#')[0]).split('/')) {
    if (part === '..') parts.pop();
    else if (part && part !== '.') parts.push(part);
  }
  return parts.join('/');
}

async function readEpub(file: File): Promise<EpubContent> {
  const zip = unzipSync(new Uint8Array(await file.arrayBuffer()));
  const text = (path: string) => (zip[path] ? strFromU8(zip[path]) : null);

  const container = text('META-INF/container.xml');
  const opfPath = container && parseXml(container, 'application/xml').querySelector('rootfile')?.getAttribute('full-path');
  const opfText = opfPath ? text(opfPath) : null;
  if (!opfPath || !opfText) throw new Error('This EPUB has no package file.');
  const opf = parseXml(opfText, 'application/xml');

  const manifest = new Map<string, { path: string; type: string; properties: string }>();
  for (const item of opf.querySelectorAll('manifest > item')) {
    manifest.set(item.getAttribute('id') ?? '', {
      path: resolvePath(opfPath, item.getAttribute('href') ?? ''),
      type: item.getAttribute('media-type') ?? '',
      properties: item.getAttribute('properties') ?? '',
    });
  }

  const paragraphs: string[] = [];
  const levels: number[] = [];
  const files: string[] = [];
  for (const ref of opf.querySelectorAll('spine > itemref')) {
    const item = manifest.get(ref.getAttribute('idref') ?? '');
    const body = item && text(item.path);
    if (!item || !body) continue;
    for (const block of parseXml(body).querySelectorAll(BLOCKS)) {
      // A <p> inside an <li> or <blockquote> is read with its parent.
      if (block.parentElement?.closest(BLOCKS)) continue;
      const content = (block as HTMLElement).textContent?.trim();
      if (!content) continue;
      paragraphs.push(content);
      levels.push(/^h[1-6]$/i.test(block.tagName) ? Number(block.tagName[1]) : 0);
      files.push(item.path);
    }
  }

  const title = opf.getElementsByTagName('dc:title')[0]?.textContent?.trim() ?? null;
  const cover = await epubCover(opf, manifest, zip);
  return { name: file.name, kind: 'epub', title, paragraphs, levels, files, contents: epubContents(manifest, text), cover };
}

/** The EPUB 3 nav document's table of contents, else the EPUB 2 NCX. */
function epubContents(
  manifest: Map<string, { path: string; type: string; properties: string }>,
  text: (path: string) => string | null,
): { title: string; file: string }[] {
  const items = [...manifest.values()];
  const nav = items.find(i => i.properties.split(' ').includes('nav'));
  const navText = nav && text(nav.path);
  if (nav && navText) {
    const doc = parseXml(navText);
    const toc = [...doc.querySelectorAll('nav')].find(n => n.getAttribute('epub:type') === 'toc') ?? doc.querySelector('nav');
    const links = [...(toc?.querySelectorAll('a[href]') ?? [])];
    if (links.length) {
      return links.map(a => ({ title: a.textContent?.trim() ?? '', file: resolvePath(nav.path, a.getAttribute('href') ?? '') }));
    }
  }
  const ncx = items.find(i => i.type === 'application/x-dtbncx+xml');
  const ncxText = ncx && text(ncx.path);
  if (!ncx || !ncxText) return [];
  return [...parseXml(ncxText, 'application/xml').querySelectorAll('navPoint')].map(point => ({
    title: point.querySelector('navLabel text')?.textContent?.trim() ?? '',
    file: resolvePath(ncx.path, point.querySelector('content')?.getAttribute('src') ?? ''),
  }));
}

async function epubCover(
  opf: Document,
  manifest: Map<string, { path: string; type: string; properties: string }>,
  zip: Unzipped,
): Promise<string | null> {
  const metaId = opf.querySelector('meta[name="cover"]')?.getAttribute('content');
  const item =
    [...manifest.values()].find(i => i.properties.split(' ').includes('cover-image')) ??
    (metaId ? manifest.get(metaId) : undefined);
  if (!item || !item.type.startsWith('image/') || !zip[item.path]) return null;
  const name = `cover-${crypto.randomUUID()}`;
  await saveCover(name, new Blob([zip[item.path]], { type: item.type }));
  return name;
}

// PDF

async function readPdf(file: File): Promise<PickedDocument> {
  const pdfjs = await import('pdfjs-dist');
  const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;

  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const pages: string[] = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    let pageText = '';
    for (const item of (await page.getTextContent()).items) {
      if (!('str' in item)) continue;
      pageText += item.str + (item.hasEOL ? '\n' : '');
    }
    pages.push(pageText);
  }

  const info = (await pdf.getMetadata().catch(() => null))?.info as { Title?: string } | undefined;
  const cover = await pdfCover(await pdf.getPage(1)).catch(() => null);
  return { name: file.name, kind: 'pdf', title: info?.Title ?? null, pages, cover };
}

/** The first page as a small JPEG, the way the iOS library shows PDFs. */
async function pdfCover(page: import('pdfjs-dist').PDFPageProxy): Promise<string | null> {
  const viewport = page.getViewport({ scale: 1 });
  const scaled = page.getViewport({ scale: 360 / viewport.width });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(scaled.width);
  canvas.height = Math.round(scaled.height);
  await page.render({ canvas, viewport: scaled }).promise;
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.8));
  if (!blob) return null;
  const name = `cover-${crypto.randomUUID()}`;
  await saveCover(name, blob);
  return name;
}
