import {
  Check, ChevronLeft, ChevronRight, Heart, Play, Plus, Tv,
} from 'lucide-react';
import {
  useEffect, useRef, useState,
  type CSSProperties, type ReactNode,
} from 'react';
import {
  artistOf, artwork, formatOf, timeOf, titleOf,
  type MediaItem, type SeriesItem,
} from '../library';

/* ------------------------------------------------------------------ */
/*  Generated artwork                                                  */
/* ------------------------------------------------------------------ */

const TINTS = [
  { a: '#252a33', b: '#0e1014', c: '#49546a' },
  { a: '#232b26', b: '#0d110f', c: '#44594d' },
  { a: '#2c2224', b: '#110d0f', c: '#5a3a3e' },
  { a: '#2a2720', b: '#11100c', c: '#5a523e' },
  { a: '#222431', b: '#0e0f16', c: '#424a6d' },
];

export function tintStyle(seed: string): CSSProperties {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  }
  const tint = TINTS[hash % TINTS.length]!;
  return {
    '--tint-a': tint.a,
    '--tint-b': tint.b,
    '--tint-c': tint.c,
  } as CSSProperties;
}

interface ArtworkProps {
  item?: MediaItem | null;
  title?: string;
  label?: string;
  compact?: boolean;
  className?: string;
  eager?: boolean;
}

export function Artwork({
  item, title, label, compact = false, className = '', eager = false,
}: ArtworkProps) {
  const [failed, setFailed] = useState(false);
  const src = item ? artwork(item) : undefined;
  const displayTitle = title || (item ? titleOf(item) : 'Untitled');
  const badge = label || (item ? formatOf(item) : '');
  const seed = item?.id || displayTitle;

  useEffect(() => { setFailed(false); }, [src, seed]);

  if (compact) {
    return (
      <div className={`artwork artwork-compact ${className}`} style={tintStyle(seed)}>
        {src && !failed
          ? <img src={src} alt="" loading="lazy" onError={() => setFailed(true)} />
          : <span className="artwork-initial" aria-hidden="true">{displayTitle.slice(0, 1).toUpperCase()}</span>}
      </div>
    );
  }

  return (
    <div className={`artwork ${className}`} style={tintStyle(seed)}>
      {src && !failed
        ? <img src={src} alt="" loading={eager ? 'eager' : 'lazy'} onError={() => setFailed(true)} />
        : (
          <div className="artwork-fallback" aria-hidden="true">
            <span className="artwork-frame" />
            {badge ? <span className="artwork-format">{badge}</span> : null}
            <span className="artwork-title">{displayTitle}</span>
          </div>
        )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Shelf                                                              */
/* ------------------------------------------------------------------ */

export function Shelf({
  title, meta, action, children, className = '', size = 'default',
}: {
  title: string;
  meta?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  size?: 'default' | 'album';
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });

  const measure = () => {
    const node = trackRef.current;
    if (!node) return;
    setEdges({
      left: node.scrollLeft > 6,
      right: node.scrollLeft + node.clientWidth < node.scrollWidth - 6,
    });
  };

  useEffect(() => {
    measure();
    const node = trackRef.current;
    if (!node) return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    Array.from(node.children).forEach((child) => observer.observe(child));
    return () => observer.disconnect();
  }, [children]);

  const scroll = (direction: number) => {
    const node = trackRef.current;
    if (!node) return;
    node.scrollBy({ left: direction * node.clientWidth * 0.82, behavior: 'smooth' });
  };

  return (
    <section className={`shelf ${className}`}>
      <div className="shelf-head">
        <div className="shelf-copy">
          <h2>{title}</h2>
          {meta ? <p>{meta}</p> : null}
        </div>
        {action}
      </div>
      <div className="shelf-body">
        <button
          type="button"
          className="shelf-arrow shelf-arrow-left"
          data-visible={edges.left}
          onClick={() => scroll(-1)}
          aria-label={`Scroll ${title} left`}
        >
          <ChevronLeft size={19} />
        </button>
        <div
          ref={trackRef}
          className={`shelf-track shelf-track-${size}`}
          onScroll={measure}
        >
          {children}
        </div>
        <button
          type="button"
          className="shelf-arrow shelf-arrow-right"
          data-visible={edges.right}
          onClick={() => scroll(1)}
          aria-label={`Scroll ${title} right`}
        >
          <ChevronRight size={19} />
        </button>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  Cards                                                              */
/* ------------------------------------------------------------------ */

function runtimeOf(seconds: number | null | undefined): string {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return '';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes > 0 ? `${minutes}m` : ''}`.trim();
  return `${Math.max(1, minutes)}m`;
}

function joinMeta(parts: Array<string | null | undefined | false>): string {
  return parts.filter(Boolean).join(' · ');
}

export function MediaCard({
  item, position = 0, saved, onPlay, onSave, seriesLabel,
}: {
  item: MediaItem;
  position?: number;
  saved: boolean;
  onPlay: () => void;
  onSave: () => void;
  seriesLabel?: string;
}) {
  const title = titleOf(item);
  const progress = item.duration && position > 5
    ? Math.min((position / item.duration) * 100, 100)
    : 0;

  return (
    <article className="media-card">
      <button className="media-poster" onClick={onPlay} aria-label={`Play ${title}`}>
        <Artwork item={item} title={title} />
        <span className="media-scrim" aria-hidden="true" />
        <span className="media-format-badge">{formatOf(item)}</span>
        {seriesLabel ? <span className="media-series-badge">{seriesLabel}</span> : null}
        <span className="media-play" aria-hidden="true"><Play size={19} fill="currentColor" /></span>
        {progress > 0 ? (
          <span className="media-progress" aria-hidden="true">
            <span style={{ width: `${progress}%` }} />
          </span>
        ) : null}
      </button>
      <div className="media-copy">
        <div className="media-text">
          <h3 title={title}>{title}</h3>
          <p>{runtimeOf(item.duration) || formatOf(item)}</p>
        </div>
        <button
          type="button"
          className={`media-save ${saved ? 'is-saved' : ''}`}
          onClick={onSave}
          aria-pressed={saved}
          title={saved ? 'Remove from My list' : 'Add to My list'}
          aria-label={saved ? `Remove ${title} from My list` : `Add ${title} to My list`}
        >
          {saved ? <Check size={16} /> : <Plus size={16} />}
        </button>
      </div>
    </article>
  );
}

export function SeriesCard({ series, onOpen }: { series: SeriesItem; onOpen: () => void }) {
  const first = series.seasons[0]?.episodes[0] ?? null;
  const meta = joinMeta([
    `${series.seasonsCount} season${series.seasonsCount === 1 ? '' : 's'}`,
    `${series.episodesCount} episode${series.episodesCount === 1 ? '' : 's'}`,
  ]);

  return (
    <article className="media-card">
      <button className="media-poster" onClick={onOpen} aria-label={`Open series ${series.name}`}>
        <Artwork item={first} title={series.name} label="Series" />
        <span className="media-scrim" aria-hidden="true" />
        <span className="media-format-badge">Series</span>
        <span className="media-episode-badge">{series.episodesCount} ep</span>
        <span className="media-play" aria-hidden="true"><Tv size={18} /></span>
      </button>
      <div className="media-copy">
        <div className="media-text">
          <h3 title={series.name}>{series.name}</h3>
          <p>{meta}</p>
        </div>
      </div>
    </article>
  );
}

export function AlbumCard({
  name, artist, count, item, onOpen,
}: {
  name: string;
  artist: string;
  count: number;
  item: MediaItem;
  onOpen: () => void;
}) {
  return (
    <article className="album-card">
      <button className="album-cover" onClick={onOpen} aria-label={`Open album ${name}`}>
        <Artwork item={item} title={name} label="Album" />
        <span className="media-play album-play" aria-hidden="true">
          <Play size={18} fill="currentColor" />
        </span>
      </button>
      <div className="album-copy">
        <h3 title={name}>{name}</h3>
        <p>{joinMeta([artist, `${count} track${count === 1 ? '' : 's'}`])}</p>
      </div>
    </article>
  );
}

/* ------------------------------------------------------------------ */
/*  Track list                                                         */
/* ------------------------------------------------------------------ */

function Equalizer() {
  return (
    <span className="equalizer" aria-hidden="true">
      <i /><i /><i />
    </span>
  );
}

export function TrackRow({
  item, index, selected, playing, saved, onPlay, onSave,
}: {
  item: MediaItem;
  index: number;
  selected: boolean;
  playing: boolean;
  saved: boolean;
  onPlay: () => void;
  onSave: () => void;
}) {
  return (
    <div className={`track-row ${selected ? 'is-active' : ''}`}>
      <button
        type="button"
        className="track-index"
        onClick={onPlay}
        aria-label={`${playing ? 'Pause' : 'Play'} ${titleOf(item)}`}
      >
        {playing ? <Equalizer /> : (
          <>
            <span className="track-number">{String(index + 1).padStart(2, '0')}</span>
            <Play className="track-hover-play" size={14} fill="currentColor" />
          </>
        )}
      </button>
      <button type="button" className="track-identity" onClick={onPlay}>
        <Artwork item={item} compact />
        <span className="track-names">
          <strong>{titleOf(item)}</strong>
          <small>{artistOf(item)}</small>
        </span>
      </button>
      <span className="track-album">{item.album || 'Singles'}</span>
      <span className="track-format">{formatOf(item)}</span>
      <button
        type="button"
        className={`track-save ${saved ? 'is-saved' : ''}`}
        onClick={onSave}
        aria-pressed={saved}
        aria-label={saved ? `Remove ${titleOf(item)} from My list` : `Add ${titleOf(item)} to My list`}
        title={saved ? 'Remove from My list' : 'Add to My list'}
      >
        <Heart size={16} fill={saved ? 'currentColor' : 'none'} />
      </button>
      <span className="track-duration">{timeOf(item.duration)}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Empty + loading states                                             */
/* ------------------------------------------------------------------ */

export function EmptyState({
  icon, title, body, action,
}: {
  icon: ReactNode;
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-icon">{icon}</span>
      <h2>{title}</h2>
      <p>{body}</p>
      {action ? <div className="empty-action">{action}</div> : null}
    </div>
  );
}

export function LoadingView({ home }: { home: boolean }) {
  if (home) {
    return (
      <div className="loading-view" aria-label="Loading library" role="status">
        <div className="skeleton skeleton-hero" />
        <div className="skeleton-shelf">
          <div className="skeleton skeleton-heading" />
          <div className="skeleton-row">
            {Array.from({ length: 5 }, (_, index) => (
              <div className="skeleton skeleton-card" key={index} />
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="loading-view" aria-label="Loading library" role="status">
      <div className="skeleton skeleton-heading wide" />
      <div className="skeleton-grid">
        {Array.from({ length: 10 }, (_, index) => (
          <div className="skeleton skeleton-card" key={index} />
        ))}
      </div>
    </div>
  );
}

export function useBodyLock(locked: boolean) {
  useEffect(() => {
    if (!locked) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; };
  }, [locked]);
}
