import { useEffect, useRef, useState, type DragEvent } from 'react';
import type { LibraryEntry, ReaderDocument } from '@shared/domain/types';
import { documentFromPaste } from '@shared/features/import/DocumentImporter';
import { isFinished, recentEntries } from '@shared/features/library/library';
import { formatMinutesLeft, minutesFor } from '@shared/features/reader/estimate';
import type { Player } from '@shared/features/reader/usePlayer';
import { ACCEPTED_FILES, importFile } from '../platform/importFile';
import { loadCover } from '../platform/storage';
import { PauseIcon, PlayIcon, PlusIcon, TrashIcon } from './icons';

const FORMAT_LABEL = { paste: 'Text', txt: 'Text', epub: 'EPUB', pdf: 'PDF', docx: 'Word' } as const;

interface Props {
  entries: LibraryEntry[];
  player: Player;
  speed: number;
  onAdd: (doc: ReaderDocument) => Promise<void>;
  onOpen: (entry: LibraryEntry) => void;
  /** Back to the reader for the document already open. */
  onReopen: () => void;
  onDelete: (entry: LibraryEntry) => void;
  onLogout: () => void;
}

export function LibraryScreen({ entries, player, speed, onAdd, onOpen, onReopen, onDelete, onLogout }: Props) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [pasting, setPasting] = useState(false);
  const [importing, setImporting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [query, setQuery] = useState('');

  const openFiles = async (files: FileList | File[]) => {
    setError(null);
    for (const file of files) {
      setImporting(file.name);
      try {
        await onAdd(await importFile(file));
      } catch (e) {
        setError(`Could not import ${file.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    setImporting(null);
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    if (event.dataTransfer.files.length) openFiles(event.dataTransfer.files);
  };

  const needle = query.trim().toLocaleLowerCase('vi');
  const shown = recentEntries(entries).filter(e => !needle || e.title.toLocaleLowerCase('vi').includes(needle));
  const current = player.entry;

  return (
    <main
      className={`library${dragging ? ' dragging' : ''}`}
      onDragOver={e => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={e => e.currentTarget === e.target && setDragging(false)}
      onDrop={onDrop}>
      <header className="library-head">
        <h1 className="brand">Library</h1>
        <div className="actions">
          <input
            className="field search"
            type="search"
            placeholder="Search"
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
          <button className="button" onClick={() => setPasting(true)}>
            Paste text
          </button>
          <button className="button primary" onClick={() => fileInput.current?.click()} disabled={importing !== null}>
            <PlusIcon size={16} /> Open a file
          </button>
          <button className="link" onClick={onLogout}>
            Log out
          </button>
        </div>
        <input
          ref={fileInput}
          type="file"
          accept={ACCEPTED_FILES}
          multiple
          hidden
          onChange={e => {
            if (e.target.files) openFiles(e.target.files);
            e.target.value = '';
          }}
        />
      </header>

      {importing ? <p className="notice">Importing {importing}…</p> : null}
      {error ? <p className="error">{error}</p> : null}

      {shown.length === 0 ? (
        <div className="empty">
          <h2>{needle ? 'No matching documents' : 'Your library is empty'}</h2>
          <p className="muted">Open an EPUB, PDF, Word or text file, paste text, or drop a file here to start listening.</p>
        </div>
      ) : (
        <ul className="shelf">
          {shown.map(entry => (
            <EntryCard
              key={entry.id}
              entry={entry}
              speed={speed}
              playing={current?.id === entry.id && player.status === 'speaking'}
              onOpen={() => onOpen(entry)}
              onToggle={() => player.toggle(entry)}
              onDelete={() => {
                if (confirm(`Delete “${entry.title}” from the library?`)) onDelete(entry);
              }}
            />
          ))}
        </ul>
      )}

      {current && player.status !== 'idle' ? (
        <div className="mini-player">
          <button className="mini-title" onClick={onReopen}>
            <strong>{current.title}</strong>
            <span className="muted small">{player.status === 'loading' ? 'Loading…' : player.voice?.name ?? ''}</span>
          </button>
          <button className="icon-button round dark" aria-label={player.status === 'speaking' ? 'Pause' : 'Play'} onClick={() => player.toggle()}>
            {player.status === 'speaking' ? <PauseIcon size={16} /> : <PlayIcon size={16} />}
          </button>
        </div>
      ) : null}

      {pasting ? (
        <PasteDialog
          onCancel={() => setPasting(false)}
          onAdd={text => {
            setPasting(false);
            onAdd(documentFromPaste(text));
          }}
        />
      ) : null}
      {dragging ? <div className="drop-hint">Drop to add to the library</div> : null}
    </main>
  );
}

function EntryCard(props: {
  entry: LibraryEntry;
  speed: number;
  playing: boolean;
  onOpen: () => void;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const { entry } = props;
  const fraction = entry.text.length ? entry.position / entry.text.length : 0;
  const meta = isFinished(entry)
    ? 'Finished'
    : entry.position === 0
      ? `${FORMAT_LABEL[entry.format]} · New`
      : `${Math.round(fraction * 100)}% · ${formatMinutesLeft(minutesFor(entry.text.length - entry.position, props.speed))}`;

  return (
    <li className="card">
      <button className="card-open" onClick={props.onOpen}>
        <Cover entry={entry} />
        <span className="card-title">{entry.title}</span>
        <span className="muted small">{meta}</span>
        <span className="progress">
          <span style={{ width: `${Math.min(100, fraction * 100)}%` }} />
        </span>
      </button>
      <div className="card-actions">
        <button className="icon-button round" aria-label={props.playing ? 'Pause' : 'Play'} onClick={props.onToggle}>
          {props.playing ? <PauseIcon size={14} /> : <PlayIcon size={14} />}
        </button>
        <button className="icon-button" aria-label={`Delete ${entry.title}`} onClick={props.onDelete}>
          <TrashIcon />
        </button>
      </div>
    </li>
  );
}

function Cover({ entry }: { entry: LibraryEntry }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!entry.cover) return;
    let made: string | null = null;
    loadCover(entry.cover).then(blob => {
      if (!blob) return;
      made = URL.createObjectURL(blob);
      setUrl(made);
    });
    return () => {
      if (made) URL.revokeObjectURL(made);
    };
  }, [entry.cover]);

  if (url) return <img className="cover" src={url} alt="" />;
  return (
    <span className="cover placeholder" aria-hidden="true">
      {entry.title.trim().charAt(0).toUpperCase() || '·'}
    </span>
  );
}

function PasteDialog({ onCancel, onAdd }: { onCancel: () => void; onAdd: (text: string) => void }) {
  const [text, setText] = useState('');
  return (
    <div className="overlay" onClick={onCancel}>
      <section className="sheet" role="dialog" aria-label="Paste text" onClick={e => e.stopPropagation()}>
        <header className="sheet-head">
          <button className="link" onClick={onCancel}>
            Cancel
          </button>
          <h2>Paste Text</h2>
          <button className="link strong" disabled={!text.trim()} onClick={() => onAdd(text)}>
            Add
          </button>
        </header>
        <textarea
          className="paste"
          placeholder="Paste or type the text to read aloud"
          value={text}
          onChange={e => setText(e.target.value)}
          autoFocus
        />
      </section>
    </div>
  );
}
