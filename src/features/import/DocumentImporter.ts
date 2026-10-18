import { NativeModules } from 'react-native';
import type { ReaderDocument } from '../../domain/types';
import { extractText, type PickedDocument } from './extractText';

interface NativeVttsDocuments {
  pickDocument(): Promise<PickedDocument | null>;
}

const native = NativeModules.VttsDocuments as NativeVttsDocuments | undefined;

let nextId = 0;
const newId = () => `doc-${Date.now()}-${nextId++}`;

export function documentFromPaste(text: string): ReaderDocument {
  const firstLine = text.trim().split('\n')[0] ?? '';
  return {
    id: newId(),
    title: firstLine.slice(0, 40) || 'Pasted text',
    format: 'paste',
    text,
  };
}

export function documentFromPicked(picked: PickedDocument): ReaderDocument {
  const { title, text } = extractText(picked);
  if (!text.trim()) {
    throw new Error(
      picked.kind === 'pdf'
        ? 'This PDF has no text to read. It may be a scan.'
        : 'This file has no text to read.',
    );
  }
  const cover = 'cover' in picked ? picked.cover ?? undefined : undefined;
  return {
    id: newId(),
    title: title ?? picked.name.replace(/\.[^.]+$/, ''),
    format: picked.kind,
    text,
    ...(cover ? { cover } : {}),
  };
}

interface NativeCovers {
  coversDirectory?: string;
  deleteCover(name: string): void;
}

const covers = NativeModules.VttsDocuments as NativeCovers | undefined;

/** file:// URI of a document's cover, or undefined when it has none. */
export function coverUri(doc: ReaderDocument): string | undefined {
  return doc.cover && covers?.coversDirectory ? covers.coversDirectory + doc.cover : undefined;
}

export function deleteCover(doc: ReaderDocument): void {
  if (doc.cover) covers?.deleteCover(doc.cover);
}

/** Opens the Files picker for TXT, PDF, EPUB or DOCX. Resolves null when cancelled. */
export async function importDocument(): Promise<ReaderDocument | null> {
  if (!native) {
    throw new Error('VttsDocuments native module is not linked');
  }
  const picked = await native.pickDocument();
  return picked ? documentFromPicked(picked) : null;
}
