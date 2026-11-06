import { Play, X } from 'lucide-react';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import {
  formatOf, sizeOf, timeOf, titleOf,
  type EpisodeItem, type SeriesItem,
} from '../library';
import { Artwork, useExit } from './ui';

interface SeriesHubProps {
  series: SeriesItem;
  playingId?: string;
  onClose: () => void;
  onPlay: (episode: EpisodeItem, series: SeriesItem) => void;
}

export function SeriesHub({ series, playingId, onClose, onPlay }: SeriesHubProps) {
  const [seasonNumber, setSeasonNumber] = useState(series.seasons[0]?.seasonNumber ?? 1);
  const panelRef = useRef<HTMLDivElement>(null);
  const { closing, close, cancel } = useExit(onClose, 190);

  useEffect(() => {
    setSeasonNumber(series.seasons[0]?.seasonNumber ?? 1);
  }, [series.id]);

  useEffect(() => {
    panelRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [close]);

  function startEpisode(episode: EpisodeItem) {
    cancel();
    onPlay(episode, series);
  }

  const season = series.seasons.find((entry) => entry.seasonNumber === seasonNumber)
    ?? series.seasons[0];
  const episodes = season?.episodes ?? [];
  const firstEpisode = series.seasons[0]?.episodes[0];
  const meta = [
    `${series.seasonsCount} season${series.seasonsCount === 1 ? '' : 's'}`,
    `${series.episodesCount} episode${series.episodesCount === 1 ? '' : 's'}`,
  ].join(' · ');

  return (
    <div
      className={`overlay series-overlay ${closing ? 'is-closing' : ''}`}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        ref={panelRef}
        className={`series-hub ${closing ? 'is-closing' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={`${series.name} series details`}
        tabIndex={-1}
      >
        <button type="button" className="modal-close series-close" onClick={close} aria-label="Close series">
          <X size={18} />
        </button>

        <div className="series-hero">
          <Artwork item={firstEpisode} title={series.name} label="Series" subtitle={meta} className="series-hero-art" eager />
          <div className="series-hero-shade" aria-hidden="true" />
          <div className="series-hero-copy">
            <span className="eyebrow">Series</span>
            <h2>{series.name}</h2>
            <p className="series-meta">
              {meta}
              {series.year ? <span> · {series.year}</span> : null}
            </p>
            {series.description ? <p className="series-description">{series.description}</p> : null}
            {firstEpisode ? (
              <div className="series-hero-actions">
                <button
                  type="button"
                  className="button button-primary"
                  onClick={() => startEpisode(firstEpisode)}
                >
                  <Play size={16} fill="currentColor" />
                  Play S{firstEpisode.seasonNumber} E{firstEpisode.episodeNumber}
                </button>
              </div>
            ) : null}
          </div>
        </div>

        <div className="series-body">
          <div className="series-toolbar">
            <h3>Episodes</h3>
            {series.seasons.length > 1 ? (
              <div className="season-tabs" role="tablist" aria-label="Seasons">
                {series.seasons.map((entry) => (
                  <button
                    key={entry.seasonNumber}
                    type="button"
                    role="tab"
                    aria-selected={entry.seasonNumber === season?.seasonNumber}
                    className={`season-tab ${entry.seasonNumber === season?.seasonNumber ? 'is-active' : ''}`}
                    onClick={() => setSeasonNumber(entry.seasonNumber)}
                  >
                    Season {entry.seasonNumber}
                    <span>{entry.episodes.length}</span>
                  </button>
                ))}
              </div>
            ) : (
              <span className="season-label">Season {season?.seasonNumber ?? 1} · {episodes.length} episodes</span>
            )}
          </div>

          <div className="episode-list" key={season?.seasonNumber ?? 'season'}>
            {episodes.length === 0 ? (
              <p className="episode-empty">No episodes found in this season.</p>
            ) : episodes.map((episode, index) => {
              const isPlaying = episode.id === playingId;
              const name = episode.episodeTitle || titleOf(episode);
              return (
                <div
                  key={episode.id}
                  className={`episode-row ${isPlaying ? 'is-playing' : ''}`}
                  style={{ '--i': Math.min(index, 11) } as CSSProperties}
                >
                  <span className="episode-number">{String(episode.episodeNumber).padStart(2, '0')}</span>
                  <button
                    type="button"
                    className="episode-thumb"
                    onClick={() => startEpisode(episode)}
                    aria-label={`Play ${name}`}
                  >
                    <Artwork item={episode} title={name} dense />
                    <span className="episode-thumb-play" aria-hidden="true">
                      <Play size={15} fill="currentColor" />
                    </span>
                  </button>
                  <button
                    type="button"
                    className="episode-main"
                    onClick={() => startEpisode(episode)}
                  >
                    <span className="episode-title">
                      {name}
                      {isPlaying ? <em className="now-chip">Now playing</em> : null}
                    </span>
                    <span className="episode-meta">
                      {[
                        episode.duration ? timeOf(episode.duration) : null,
                        formatOf(episode),
                        sizeOf(episode.size),
                      ].filter(Boolean).join(' · ')}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="episode-play"
                    onClick={() => startEpisode(episode)}
                    aria-label={`Play ${name}`}
                  >
                    <Play size={14} fill="currentColor" />
                    <span>Play</span>
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
