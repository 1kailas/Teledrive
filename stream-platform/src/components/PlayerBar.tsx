import { Heart, Pause, Play, SkipBack, SkipForward, Volume1, Volume2, VolumeX } from 'lucide-react';
import type { CSSProperties } from 'react';
import { artistOf, timeOf, titleOf, type MediaItem } from '../library';
import { Artwork } from './ui';

interface PlayerBarProps {
  track: MediaItem;
  playing: boolean;
  elapsed: number;
  duration: number;
  volume: number;
  saved: boolean;
  error?: string;
  onToggle: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onSeek: (seconds: number) => void;
  onVolume: (volume: number) => void;
  onSave: () => void;
}

function fillStyle(value: number, max: number): CSSProperties {
  const percent = max > 0 ? Math.min(Math.max(value / max, 0), 1) * 100 : 0;
  return { '--fill': `${percent}%` } as CSSProperties;
}

export function PlayerBar({
  track, playing, elapsed, duration, volume, saved, error,
  onToggle, onPrevious, onNext, onSeek, onVolume, onSave,
}: PlayerBarProps) {
  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : (track.duration ?? 0);
  const safeElapsed = Number.isFinite(elapsed) && elapsed > 0 ? elapsed : 0;
  const VolumeIcon = volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2;

  return (
    <footer className="player-bar" aria-label="Audio player">
      <div className="player-line" aria-hidden="true">
        <span style={{ width: `${safeDuration > 0 ? Math.min(safeElapsed / safeDuration, 1) * 100 : 0}%` }} />
      </div>

      <div className="player-track">
        <Artwork item={track} compact />
        <div className="player-track-copy">
          <strong title={titleOf(track)}>{titleOf(track)}</strong>
          <span className={error ? 'player-error' : ''} title={error || artistOf(track)}>
            {error || artistOf(track)}
          </span>
        </div>
        <button
          type="button"
          className={`player-heart ${saved ? 'is-saved' : ''}`}
          onClick={onSave}
          aria-pressed={saved}
          aria-label={saved ? 'Remove track from My list' : 'Add track to My list'}
          title={saved ? 'Remove from My list' : 'Add to My list'}
        >
          <Heart size={16} fill={saved ? 'currentColor' : 'none'} />
        </button>
      </div>

      <div className="player-center">
        <div className="player-controls">
          <button type="button" onClick={onPrevious} aria-label="Previous track" title="Previous">
            <SkipBack size={17} fill="currentColor" />
          </button>
          <button
            type="button"
            className="player-play"
            onClick={onToggle}
            aria-label={playing ? 'Pause' : 'Play'}
            title={playing ? 'Pause' : 'Play'}
          >
            {playing ? <Pause size={17} fill="currentColor" /> : <Play size={17} fill="currentColor" />}
          </button>
          <button type="button" onClick={onNext} aria-label="Next track" title="Next">
            <SkipForward size={17} fill="currentColor" />
          </button>
        </div>

        <div className="player-seek">
          <span>{timeOf(safeElapsed)}</span>
          <input
            type="range"
            min="0"
            max={Math.max(safeDuration, 1)}
            step="1"
            value={Math.min(safeElapsed, Math.max(safeDuration, 1))}
            onChange={(event) => onSeek(Number(event.target.value))}
            style={fillStyle(safeElapsed, safeDuration)}
            aria-label="Seek in track"
          />
          <span>{timeOf(safeDuration)}</span>
        </div>
      </div>

      <div className="player-volume">
        <VolumeIcon size={17} aria-hidden="true" />
        <input
          type="range"
          min="0"
          max="1"
          step="0.01"
          value={volume}
          onChange={(event) => onVolume(Number(event.target.value))}
          style={fillStyle(volume, 1)}
          aria-label="Volume"
        />
      </div>
    </footer>
  );
}
