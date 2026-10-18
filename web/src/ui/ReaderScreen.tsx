import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { LibraryEntry, TextRange } from '@shared/domain/types';
import { formatClock, minutesFor } from '@shared/features/reader/estimate';
import { sentenceIndexAt, textBlocks } from '@shared/features/reader/textRanges';
import type { Player } from '@shared/features/reader/usePlayer';
import { BackIcon, PauseIcon, PlayIcon, SkipIcon } from './icons';

// Same steps as the mobile reader (src/ui/ReaderScreen.tsx), which cannot be imported here.
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const FONT_SIZES = [16, 18, 20, 23, 26];
const SLEEP_MINUTES = [15, 30, 45, 60];

interface Props {
  entry: LibraryEntry;
  player: Player;
  speed: number;
  fontSize: number;
  onFontSize: (size: number) => void;
  onBack: () => void;
  onOpenVoices: () => void;
  onLogout: () => void;
}

export function ReaderScreen({ entry, player, speed, fontSize, onFontSize, onBack, onOpenVoices, onLogout }: Props) {
  const page = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);

  const { sentences, highlight } = player;
  const blocks = useMemo(() => textBlocks(entry.text, sentences), [entry.text, sentences]);
  const headings = entry.headings ?? [];
  const current = highlight ? sentenceIndexAt(sentences, highlight.start) : -1;
  const currentBlock = highlight && blocks.length ? sentenceIndexAt(blocks, highlight.start) : -1;
  const playing = player.status !== 'idle';

  const scrollToCurrent = (behavior: ScrollBehavior = 'smooth') => {
    page.current?.querySelector('[data-current="true"]')?.scrollIntoView({ block: 'center', behavior });
  };

  useEffect(() => {
    if (following) scrollToCurrent(currentBlock >= 0 ? 'smooth' : 'auto');
  }, [currentBlock, following]); // eslint-disable-line react-hooks/exhaustive-deps

  // Opening a document lands on the bookmark.
  useEffect(() => {
    requestAnimationFrame(() => scrollToCurrent('auto'));
  }, [entry.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Blocks are memoized, so they get one stable callback that reaches the latest player.
  const latest = useRef({ player, onBack });
  latest.current = { player, onBack };
  const [onSentence] = useState(() => (offset: number) => {
    setFollowing(true);
    latest.current.player.playFrom(offset);
  });

  // Space plays and pauses, the arrow keys move a sentence, Escape goes back.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && e.target.closest('input, textarea, select, [role="dialog"]')) return;
      const { player: p, onBack: back } = latest.current;
      if (e.key === ' ') {
        e.preventDefault();
        setFollowing(true);
        p.toggle();
      } else if (e.key === 'ArrowRight') p.skip(1);
      else if (e.key === 'ArrowLeft') p.skip(-1);
      else if (e.key === 'Escape') back();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const total = minutesFor(entry.text.length, speed);
  const at = highlight?.start ?? entry.position;
  const fraction = entry.text.length ? at / entry.text.length : 0;

  return (
    <main className="reader">
      <nav className="reader-nav">
        <button className="link label" onClick={onBack}>
          <BackIcon size={14} /> Library
        </button>
        <span className="reader-title">{entry.title}</span>
        <span className="nav-right">
          <button
            className="link aa"
            aria-label="Text size"
            onClick={() => onFontSize(FONT_SIZES[(FONT_SIZES.indexOf(fontSize) + 1) % FONT_SIZES.length])}>
            Aa
          </button>
          <button className="link label" onClick={onLogout}>
            Log out
          </button>
        </span>
      </nav>

      {entry.chapters?.length ? (
        <div className="chapters">
          <select
            className="field"
            aria-label="Chapter"
            value={[...entry.chapters].reverse().find(c => c.position <= at)?.position ?? ''}
            onChange={e => {
              setFollowing(true);
              player.seek(Number(e.target.value));
            }}>
            {entry.chapters.map(c => (
              <option key={c.position} value={c.position}>
                {c.title}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      <div
        ref={page}
        className="page"
        style={{ fontSize, lineHeight: 1.65 }}
        onWheel={() => setFollowing(false)}
        onTouchMove={() => setFollowing(false)}>
        {blocks.map((block, index) => (
          <Block
            key={block.start}
            text={entry.text}
            block={block}
            sentences={sentences}
            current={index === currentBlock ? current : -1}
            isCurrent={index === currentBlock}
            heading={headings.some(h => h.start < block.end && h.end > block.start)}
            onSentence={onSentence}
          />
        ))}
      </div>

      {player.error ? <p className="error reader-error">{player.error}</p> : null}

      <footer className="dock">
        {playing && !following ? (
          <button
            className="follow"
            onClick={() => {
              setFollowing(true);
              scrollToCurrent();
            }}>
            ↓ Follow along
          </button>
        ) : null}
        <input
          className="scrubber"
          type="range"
          min={0}
          max={1000}
          value={Math.round(fraction * 1000)}
          aria-label="Position"
          onChange={e => {
            const index = sentenceIndexAt(sentences, Math.floor((Number(e.target.value) / 1000) * entry.text.length));
            setFollowing(true);
            player.seek(sentences[index]?.start ?? 0);
          }}
        />
        <div className="times">
          <span>{formatClock(total * fraction)}</span>
          <span>{formatClock(total * (1 - fraction))} LEFT</span>
        </div>
        <div className="controls">
          <div className="side">
            <select className="pill" aria-label="Speed" value={speed} onChange={e => player.setSpeed(Number(e.target.value))}>
              {SPEEDS.map(s => (
                <option key={s} value={s}>
                  {s}×
                </option>
              ))}
            </select>
            <SleepSelect player={player} />
          </div>
          <div className="transport">
            <button className="icon-button" aria-label="Previous sentence" onClick={() => player.skip(-1)}>
              <SkipIcon direction={-1} />
            </button>
            <button
              className="play"
              aria-label={player.status === 'speaking' ? 'Pause' : player.status === 'loading' ? 'Preparing' : 'Play'}
              onClick={() => {
                setFollowing(true);
                player.toggle();
              }}>
              {player.status === 'loading' ? <span className="spinner light" /> : player.status === 'speaking' ? <PauseIcon /> : <PlayIcon />}
            </button>
            <button className="icon-button" aria-label="Next sentence" onClick={() => player.skip(1)}>
              <SkipIcon direction={1} />
            </button>
          </div>
          <div className="side right">
            <button className="pill" onClick={onOpenVoices}>
              {player.voice ? player.voice.name : 'Voice'}
            </button>
          </div>
        </div>
      </footer>
    </main>
  );
}

/** A paragraph, its sentences clickable; only the block being read re-renders as the highlight moves. */
const Block = memo(function Block(props: {
  text: string;
  block: TextRange;
  sentences: TextRange[];
  current: number;
  isCurrent: boolean;
  heading: boolean;
  onSentence: (offset: number) => void;
}) {
  const { text, block, sentences, current } = props;
  const parts = [];
  for (let i = sentenceIndexAt(sentences, block.start); i < sentences.length && sentences[i].start < block.end; i++) {
    const s = sentences[i];
    if (s.end <= block.start) continue;
    parts.push(
      <span key={s.start} className={i === current ? 'sentence current' : 'sentence'} onClick={() => props.onSentence(s.start)}>
        {text.slice(s.start, s.end)}
      </span>,
      ' ',
    );
  }
  const Tag = props.heading ? 'h2' : 'p';
  return (
    <Tag className={props.heading ? 'block heading' : 'block'} data-current={props.isCurrent || undefined}>
      {parts}
    </Tag>
  );
}, (a, b) => a.block === b.block && a.current === b.current && a.isCurrent === b.isCurrent && a.heading === b.heading && a.text === b.text);

function SleepSelect({ player }: { player: Player }) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (player.sleepAt === null) return;
    const id = setInterval(() => tick(n => n + 1), 30_000);
    return () => clearInterval(id);
  }, [player.sleepAt]);

  const left = player.sleepAt === null ? null : Math.max(1, Math.ceil((player.sleepAt - Date.now()) / 60_000));
  return (
    <select
      className={`pill${left !== null ? ' active' : ''}`}
      aria-label="Sleep timer"
      value=""
      onChange={e => {
        const minutes = Number(e.target.value);
        player.setSleepAt(minutes > 0 ? Date.now() + minutes * 60_000 : null);
      }}>
      <option value="" disabled hidden>
        {left !== null ? `Sleep ${left}m` : 'Sleep'}
      </option>
      {SLEEP_MINUTES.map(m => (
        <option key={m} value={m}>
          {m} minutes
        </option>
      ))}
      <option value={0}>Off</option>
    </select>
  );
}
