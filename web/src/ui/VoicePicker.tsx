import { useEffect, useMemo } from 'react';
import type { Voice } from '@shared/domain/types';
import { groupVoices } from '@shared/features/voices/groupVoices';
import { CloseIcon, PauseIcon, PlayIcon } from './icons';

const GENDER: Record<string, string> = { female: 'Female', male: 'Male' };

interface Props {
  /** null while the list loads. */
  voices: Voice[] | null;
  selectedId?: string;
  previewingId: string | null;
  previewLoading: boolean;
  onPreview: (voice: Voice) => void;
  onSelect: (voice: Voice) => void;
  onClose: () => void;
}

/** Server voices by region, each with a preview button. The web has no offline voices. */
export function VoicePicker({ voices, selectedId, previewingId, previewLoading, onPreview, onSelect, onClose }: Props) {
  const groups = useMemo(() => groupVoices(voices ?? []), [voices]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="overlay" onClick={onClose}>
      <section className="sheet" role="dialog" aria-label="Voice" onClick={e => e.stopPropagation()}>
        <header className="sheet-head">
          <div>
            <h2>Voice</h2>
            <p className="muted small">Vietnamese voices from the server</p>
          </div>
          <button className="icon-button" aria-label="Close" onClick={onClose}>
            <CloseIcon />
          </button>
        </header>
        <div className="sheet-body">
          {voices === null ? <p className="muted">Loading voices…</p> : null}
          {voices?.length === 0 ? <p className="muted">No voices. Check your connection and reload.</p> : null}
          {groups.map(group => (
            <div key={group.region}>
              <h3 className="label">{group.region}</h3>
              {group.voices.map(voice => {
                const previewing = previewingId === voice.id;
                return (
                  <div key={voice.id} className={`voice-row${voice.id === selectedId ? ' selected' : ''}`}>
                    <button
                      className="icon-button round"
                      aria-label={previewing ? `Stop preview of ${voice.name}` : `Preview ${voice.name}`}
                      onClick={() => onPreview(voice)}>
                      {previewing && previewLoading ? <span className="spinner" /> : previewing ? <PauseIcon size={14} /> : <PlayIcon size={14} />}
                    </button>
                    <button className="voice-name" onClick={() => onSelect(voice)}>
                      <span>{voice.name.replace(/^[A-Za-z]+ - /, '')}</span>
                      <span className="muted small">{GENDER[voice.gender] ?? voice.gender}</span>
                    </button>
                    {voice.id === selectedId ? <span className="check">✓</span> : null}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
