import {
  AlertTriangle, Bookmark, Check, Download, ExternalLink, Keyboard, ListVideo,
  Maximize, Minimize, MoreHorizontal, PictureInPicture2, Play,
  RectangleHorizontal, RefreshCw, Share2, SkipBack, SkipForward,
  SlidersHorizontal, Subtitles, X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { posterDataUrl } from '../poster';
import { useCapturedFrame } from '../thumbs';
import {
  artwork, formatOf, getAudioPrefs, getPositions, saveAudioPrefs, savePosition,
  sizeOf, timeOf, titleOf,
  type AudioPreferences, type AudioProfile, type EpisodeItem, type MediaItem,
} from '../library';
import { useExit, usePresence } from './ui';

interface VideoTheatreProps {
  video: MediaItem;
  activeEpisode?: EpisodeItem | null;
  seasonEpisodes?: EpisodeItem[];
  nextEpisode?: EpisodeItem | null;
  hasPreviousEpisode?: boolean;
  hasNextEpisode?: boolean;
  saved: boolean;
  onClose: () => void;
  onToggleSaved: () => void;
  onPreviousEpisode?: () => void;
  onNextEpisode?: () => void;
  onPlayEpisode?: (episode: EpisodeItem) => void;
  onCopyLink: (id: string) => void;
}

type AspectRatio = 'fit' | '16-9' | '21-9' | 'fill';

const ASPECT_LABELS: Record<AspectRatio, string> = {
  fit: 'Original',
  '16-9': '16:9',
  '21-9': '21:9',
  fill: 'Stretch',
};

const SHORTCUTS: Array<[string, string]> = [
  ['Play / pause', 'Space or K'],
  ['Seek 5 seconds', '← / →'],
  ['Skip 10 seconds', 'J / L'],
  ['Volume', '↑ / ↓'],
  ['Mute', 'M'],
  ['Fullscreen', 'F'],
  ['Picture in picture', 'P'],
  ['Audio settings', 'A'],
  ['Shortcuts', '?'],
];

export function VideoTheatre({
  video, activeEpisode = null, seasonEpisodes = [], nextEpisode = null,
  hasPreviousEpisode = false, hasNextEpisode = false, saved,
  onClose, onToggleSaved, onPreviousEpisode = () => {}, onNextEpisode = () => {},
  onPlayEpisode = () => {}, onCopyLink,
}: VideoTheatreProps) {
  const [audioPrefs, setAudioPrefs] = useState<AudioPreferences>(getAudioPrefs);
  const [audioTracks, setAudioTracks] = useState<{ id: string; label: string; enabled: boolean }[]>([]);
  const [subtitles, setSubtitles] = useState<{ id: string; label: string; active: boolean }[]>([]);
  const [customSubtitleUrl, setCustomSubtitleUrl] = useState<string | null>(null);
  const [showAudioMenu, setShowAudioMenu] = useState(false);
  const [showSubtitleMenu, setShowSubtitleMenu] = useState(false);
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  const [showEpisodeDrawer, setShowEpisodeDrawer] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>('fit');
  const [playbackError, setPlaybackError] = useState('');
  const [streamUrl, setStreamUrl] = useState(`/api/media/${video.id}`);
  const [hasAutoRetried, setHasAutoRetried] = useState(false);
  const [autoplayCountdown, setAutoplayCountdown] = useState<number | null>(null);

  const { closing, close: closeWithAnimation } = useExit(onClose, 200);
  const subtitleMenu = usePresence(showSubtitleMenu, 150);
  const audioMenu = usePresence(showAudioMenu, 150);
  const moreMenu = usePresence(showMoreMenu, 150);
  const episodeDrawer = usePresence(showEpisodeDrawer && Boolean(activeEpisode), 180);
  const helpOverlay = usePresence(showHelp, 170);

  const theatreRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const subtitleInputRef = useRef<HTMLInputElement>(null);
  const lastSavedAt = useRef(0);
  const lastPosition = useRef<{ id: string; time: number; duration: number } | null>(null);

  const audioContextRef = useRef<AudioContext | null>(null);
  const audioNodesRef = useRef<{
    source: MediaElementAudioSourceNode;
    dialogue: BiquadFilterNode;
    bass: BiquadFilterNode;
    compressor: DynamicsCompressorNode;
    gain: GainNode;
  } | null>(null);

  const title = activeEpisode
    ? (activeEpisode.episodeTitle || titleOf(activeEpisode))
    : titleOf(video);
  const anyMenuOpen = showAudioMenu || showSubtitleMenu || showMoreMenu;

  const capturedPoster = useCapturedFrame(video, !video.hasThumbnail);
  const generatedPoster = useMemo(() => posterDataUrl({
    seed: video.id,
    title,
    category: 'video',
    shape: 'backdrop',
  }), [video.id, title]);
  const poster = artwork(video) ?? capturedPoster ?? generatedPoster;

  /* ---------------------------------------------------------------- */
  /*  Audio processing                                                 */
  /* ---------------------------------------------------------------- */

  const applyAudioProfile = (profile: AudioProfile, speed = audioPrefs.speed) => {
    const element = videoRef.current;
    if (!element) return;
    element.playbackRate = speed;

    try {
      if (!audioContextRef.current) {
        const AudioContextClass = window.AudioContext
          || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        if (!AudioContextClass) return;
        const context = new AudioContextClass();
        audioContextRef.current = context;
        const source = context.createMediaElementSource(element);
        const bass = context.createBiquadFilter();
        bass.type = 'lowshelf';
        bass.frequency.value = 140;

        const dialogue = context.createBiquadFilter();
        dialogue.type = 'peaking';
        dialogue.frequency.value = 2400;
        dialogue.Q.value = 1.1;

        const compressor = context.createDynamicsCompressor();
        compressor.threshold.value = -24;
        compressor.knee.value = 20;
        compressor.ratio.value = 12;

        const gain = context.createGain();
        source.connect(bass);
        bass.connect(dialogue);
        dialogue.connect(compressor);
        compressor.connect(gain);
        gain.connect(context.destination);
        audioNodesRef.current = { source, dialogue, bass, compressor, gain };
      }

      const context = audioContextRef.current;
      if (context?.state === 'suspended') void context.resume();
      const nodes = audioNodesRef.current;
      if (!nodes) return;

      switch (profile) {
        case 'dialogue':
          nodes.dialogue.gain.value = 8.5;
          nodes.bass.gain.value = -2;
          nodes.compressor.threshold.value = -12;
          nodes.gain.gain.value = 1;
          break;
        case 'night':
          nodes.dialogue.gain.value = 6;
          nodes.bass.gain.value = -3.5;
          nodes.compressor.threshold.value = -28;
          nodes.compressor.ratio.value = 16;
          nodes.gain.gain.value = 1.1;
          break;
        case 'bass':
          nodes.dialogue.gain.value = 1;
          nodes.bass.gain.value = 7.5;
          nodes.compressor.threshold.value = -6;
          nodes.gain.gain.value = 1;
          break;
        case 'boost150':
          nodes.dialogue.gain.value = 2;
          nodes.bass.gain.value = 0;
          nodes.compressor.threshold.value = -10;
          nodes.gain.gain.value = 1.5;
          break;
        case 'boost200':
          nodes.dialogue.gain.value = 3;
          nodes.bass.gain.value = 0;
          nodes.compressor.threshold.value = -14;
          nodes.gain.gain.value = 2;
          break;
        default:
          nodes.dialogue.gain.value = 0;
          nodes.bass.gain.value = 0;
          nodes.compressor.threshold.value = 0;
          nodes.gain.gain.value = 1;
      }
    } catch (error) {
      console.warn('Audio processing is not available for this stream.', error);
    }
  };

  const setProfile = (profile: AudioProfile) => {
    const updated = { ...audioPrefs, profile };
    setAudioPrefs(updated);
    saveAudioPrefs(updated);
    applyAudioProfile(profile, updated.speed);
  };

  const setSpeed = (speed: number) => {
    const updated = { ...audioPrefs, speed };
    setAudioPrefs(updated);
    saveAudioPrefs(updated);
    if (videoRef.current) videoRef.current.playbackRate = speed;
  };

  /* ---------------------------------------------------------------- */
  /*  Track inspection                                                 */
  /* ---------------------------------------------------------------- */

  const inspectMediaTracks = () => {
    const element = videoRef.current;
    if (!element) return;
    applyAudioProfile(audioPrefs.profile, audioPrefs.speed);

    const media = element as HTMLVideoElement & {
      audioTracks?: {
        length: number;
        [index: number]: { id: string; label: string; language: string; enabled: boolean };
      };
    };

    if (media.audioTracks && media.audioTracks.length > 0) {
      const list = [];
      for (let index = 0; index < media.audioTracks.length; index += 1) {
        const trackInfo = media.audioTracks[index]!;
        list.push({
          id: trackInfo.id || `track-${index}`,
          label: trackInfo.label || trackInfo.language || `Audio track ${index + 1}`,
          enabled: Boolean(trackInfo.enabled),
        });
      }
      setAudioTracks(list);
    } else {
      setAudioTracks([{ id: 'default', label: 'Default stereo audio', enabled: true }]);
    }

    if (element.textTracks && element.textTracks.length > 0) {
      const list = [];
      for (let index = 0; index < element.textTracks.length; index += 1) {
        const subtitle = element.textTracks[index]!;
        list.push({
          id: `sub-${index}`,
          label: subtitle.label || subtitle.language || `Subtitles ${index + 1}`,
          active: subtitle.mode === 'showing',
        });
      }
      setSubtitles(list);
    }
  };

  const switchAudioTrack = (index: number) => {
    const element = videoRef.current as HTMLVideoElement & {
      audioTracks?: { length: number; [index: number]: { enabled: boolean } };
    };
    if (element?.audioTracks && element.audioTracks.length > 0) {
      for (let trackIndex = 0; trackIndex < element.audioTracks.length; trackIndex += 1) {
        element.audioTracks[trackIndex]!.enabled = trackIndex === index;
      }
    }
    setAudioTracks((current) => current.map((track, trackIndex) => ({
      ...track,
      enabled: trackIndex === index,
    })));
  };

  /* ---------------------------------------------------------------- */
  /*  Playback                                                         */
  /* ---------------------------------------------------------------- */

  const togglePlay = () => {
    const element = videoRef.current;
    if (!element) return;
    if (element.paused) void element.play().catch(() => setPlaybackError('Playback was blocked. Press play to continue.'));
    else element.pause();
  };

  const closeTheatre = () => {
    const element = videoRef.current;
    if (element && Number.isFinite(element.duration) && element.duration > 0) {
      savePosition(
        video.id,
        element.currentTime < element.duration - 10 ? element.currentTime : null,
      );
    }
    element?.pause();
    closeWithAnimation();
  };

  const openExternalPlayer = (protocol: 'vlc' | 'potplayer') => {
    const fullUrl = `${window.location.origin}/api/media/${video.id}`;
    window.location.href = `${protocol}://${fullUrl}`;
    onCopyLink(video.id);
  };

  const handleVideoError = () => {
    if (!hasAutoRetried) {
      setHasAutoRetried(true);
      setStreamUrl(`/api/media/${video.id}?format=mp4`);
      const element = videoRef.current;
      if (element) {
        element.load();
        void element.play().catch(() => undefined);
      }
      return;
    }
    setPlaybackError('Playback was interrupted. Reconnect, or stream directly in VLC / PotPlayer.');
  };

  const retryPlayback = () => {
    const element = videoRef.current;
    setPlaybackError('');
    setStreamUrl(`/api/media/${video.id}?t=${Date.now()}`);
    if (!element) return;
    element.load();
    void element.play().catch(() => setPlaybackError('Stream reconnect failed. Stream directly in VLC or download the file.'));
  };

  const togglePiP = async () => {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else if (videoRef.current) await videoRef.current.requestPictureInPicture();
    } catch (error) {
      console.warn('Picture in picture is not available.', error);
    }
  };

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      void theatreRef.current?.requestFullscreen()
        .then(() => setIsFullscreen(true))
        .catch(() => undefined);
    } else {
      void document.exitFullscreen()
        .then(() => setIsFullscreen(false))
        .catch(() => undefined);
    }
  };

  const cycleAspect = () => {
    setAspectRatio((current) => (
      current === 'fit' ? '16-9'
        : current === '16-9' ? '21-9'
          : current === '21-9' ? 'fill' : 'fit'
    ));
  };

  const handleSubtitleUpload = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (loadEvent) => {
      let content = String(loadEvent.target?.result ?? '');
      if (file.name.toLowerCase().endsWith('.srt')) {
        content = `WEBVTT\n\n${content.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')}`;
      }
      const blob = new Blob([content], { type: 'text/vtt' });
      const url = URL.createObjectURL(blob);
      if (customSubtitleUrl) URL.revokeObjectURL(customSubtitleUrl);
      setCustomSubtitleUrl(url);
      if (videoRef.current) {
        for (let index = 0; index < videoRef.current.textTracks.length; index += 1) {
          videoRef.current.textTracks[index]!.mode = 'disabled';
        }
      }
      setSubtitles((current) => [
        ...current.map((subtitle) => ({ ...subtitle, active: false })),
        { id: 'custom', label: file.name, active: true },
      ]);
    };
    reader.readAsText(file);
    event.target.value = '';
  };

  /* ---------------------------------------------------------------- */
  /*  Effects                                                          */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    const onFullscreenChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, []);

  useEffect(() => () => {
    if (customSubtitleUrl) URL.revokeObjectURL(customSubtitleUrl);
  }, [customSubtitleUrl]);

  useEffect(() => () => {
    if (audioContextRef.current) void audioContextRef.current.close().catch(() => undefined);
  }, []);

  useEffect(() => () => {
    const position = lastPosition.current;
    if (position && position.id === video.id && Number.isFinite(position.duration) && position.duration > 0) {
      savePosition(
        position.id,
        position.time < position.duration - 10 ? position.time : null,
      );
    }
  }, [video.id]);

  useEffect(() => {
    theatreRef.current?.focus();
  }, []);

  useEffect(() => {
    setPlaybackError('');
    setStreamUrl(`/api/media/${video.id}`);
    setHasAutoRetried(false);
    setAutoplayCountdown(null);
    setShowEpisodeDrawer(false);
    setShowAudioMenu(false);
    setShowSubtitleMenu(false);
    setShowMoreMenu(false);
    const element = videoRef.current;
    if (!element) return;
    lastSavedAt.current = 0;
    const timer = window.setTimeout(() => {
      element.load();
      void element.play().catch(() => undefined);
    }, 30);
    return () => window.clearTimeout(timer);
  }, [video.id]);

  useEffect(() => {
    if (autoplayCountdown === null) return;
    if (autoplayCountdown <= 0) {
      setAutoplayCountdown(null);
      onNextEpisode();
      return;
    }
    const timer = window.setTimeout(() => {
      setAutoplayCountdown((current) => (current !== null && current > 0 ? current - 1 : null));
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [autoplayCountdown, onNextEpisode]);

  useEffect(() => {
    if (!anyMenuOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest('.menu-anchor')) return;
      setShowAudioMenu(false);
      setShowSubtitleMenu(false);
      setShowMoreMenu(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [anyMenuOpen]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (showHelp) { setShowHelp(false); return; }
        if (anyMenuOpen) {
          setShowAudioMenu(false);
          setShowSubtitleMenu(false);
          setShowMoreMenu(false);
          return;
        }
        if (showEpisodeDrawer) { setShowEpisodeDrawer(false); return; }
        if (document.fullscreenElement) {
          void document.exitFullscreen().catch(() => undefined);
          return;
        }
        closeTheatre();
        return;
      }

      const target = event.target as HTMLElement;
      if (['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A'].includes(target.tagName)) return;
      const element = videoRef.current;
      if (!element) return;

      switch (event.key) {
        case ' ':
        case 'k':
        case 'K':
          event.preventDefault();
          togglePlay();
          break;
        case 'ArrowLeft':
          event.preventDefault();
          element.currentTime = Math.max(0, element.currentTime - 5);
          break;
        case 'ArrowRight':
          event.preventDefault();
          element.currentTime = Math.min(element.duration || 0, element.currentTime + 5);
          break;
        case 'j':
        case 'J':
          event.preventDefault();
          element.currentTime = Math.max(0, element.currentTime - 10);
          break;
        case 'l':
        case 'L':
          event.preventDefault();
          element.currentTime = Math.min(element.duration || 0, element.currentTime + 10);
          break;
        case 'ArrowUp':
          event.preventDefault();
          element.volume = Math.min(1, element.volume + 0.05);
          break;
        case 'ArrowDown':
          event.preventDefault();
          element.volume = Math.max(0, element.volume - 0.05);
          break;
        case 'm':
        case 'M':
          event.preventDefault();
          element.muted = !element.muted;
          break;
        case 'f':
        case 'F':
          event.preventDefault();
          toggleFullscreen();
          break;
        case 'p':
        case 'P':
          event.preventDefault();
          void togglePiP();
          break;
        case 'a':
        case 'A':
          event.preventDefault();
          setShowAudioMenu((current) => !current);
          setShowSubtitleMenu(false);
          setShowMoreMenu(false);
          break;
        case '?':
          event.preventDefault();
          setShowHelp((current) => !current);
          break;
        default:
          break;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [anyMenuOpen, showEpisodeDrawer, showHelp, closeWithAnimation, audioPrefs, video.id]);

  /* ---------------------------------------------------------------- */
  /*  Render                                                           */
  /* ---------------------------------------------------------------- */

  return (
    <div
      ref={theatreRef}
      className={`theatre ${isFullscreen ? 'is-fullscreen' : ''} ${closing ? 'is-closing' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label={`Watching ${title}`}
      tabIndex={-1}
    >
      <header className="theatre-header">
        <div className="theatre-title">
          <span className="theatre-eyebrow">
            {activeEpisode
              ? `${activeEpisode.seriesName} · S${String(activeEpisode.seasonNumber).padStart(2, '0')} E${String(activeEpisode.episodeNumber).padStart(2, '0')}`
              : 'Now playing'}
          </span>
          <strong title={title}>{title}</strong>
        </div>

        <div className="theatre-tools">
          <div className="menu-anchor">
            <button
              type="button"
              className={`tool-button ${showSubtitleMenu ? 'is-active' : ''}`}
              onClick={() => {
                setShowSubtitleMenu((current) => !current);
                setShowAudioMenu(false);
                setShowMoreMenu(false);
              }}
              aria-label="Subtitles and captions"
              title="Subtitles"
            >
              <Subtitles size={18} />
              <span className="tool-label">CC</span>
            </button>
            {subtitleMenu.mounted ? (
              <div
                className={`menu-popover subtitle-menu ${subtitleMenu.closing ? 'is-closing' : ''}`}
                onMouseDown={(event) => event.stopPropagation()}
              >
                <div className="menu-head">
                  <strong>Subtitles</strong>
                  <button type="button" onClick={() => setShowSubtitleMenu(false)} aria-label="Close subtitles">
                    <X size={15} />
                  </button>
                </div>
                <div className="menu-list">
                  <button
                    type="button"
                    className={`menu-option ${!subtitles.some((subtitle) => subtitle.active) ? 'is-selected' : ''}`}
                    onClick={() => {
                      if (videoRef.current) {
                        for (let index = 0; index < videoRef.current.textTracks.length; index += 1) {
                          videoRef.current.textTracks[index]!.mode = 'disabled';
                        }
                      }
                      setSubtitles((current) => current.map((subtitle) => ({ ...subtitle, active: false })));
                    }}
                  >
                    <span className="radio-dot" />
                    Off
                  </button>
                  {subtitles.map((subtitle, index) => (
                    <button
                      key={subtitle.id}
                      type="button"
                      className={`menu-option ${subtitle.active ? 'is-selected' : ''}`}
                      onClick={() => {
                        if (videoRef.current) {
                          for (let trackIndex = 0; trackIndex < videoRef.current.textTracks.length; trackIndex += 1) {
                            videoRef.current.textTracks[trackIndex]!.mode = trackIndex === index ? 'showing' : 'disabled';
                          }
                        }
                        setSubtitles((current) => current.map((entry, entryIndex) => ({
                          ...entry,
                          active: entryIndex === index,
                        })));
                      }}
                    >
                      <span className="radio-dot" />
                      {subtitle.label}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  className="menu-action"
                  onClick={() => subtitleInputRef.current?.click()}
                >
                  Upload subtitle (.srt / .vtt)
                </button>
                <input
                  ref={subtitleInputRef}
                  type="file"
                  accept=".srt,.vtt"
                  hidden
                  onChange={handleSubtitleUpload}
                />
              </div>
            ) : null}
          </div>

          <div className="menu-anchor">
            <button
              type="button"
              className={`tool-button ${showAudioMenu ? 'is-active' : ''}`}
              onClick={() => {
                setShowAudioMenu((current) => !current);
                setShowSubtitleMenu(false);
                setShowMoreMenu(false);
              }}
              aria-label="Audio and playback settings"
              title="Audio and playback"
            >
              <SlidersHorizontal size={18} />
              {audioPrefs.profile !== 'flat' ? <span className="tool-dot" /> : null}
            </button>
            {audioMenu.mounted ? (
              <div
                className={`menu-popover audio-menu ${audioMenu.closing ? 'is-closing' : ''}`}
                onMouseDown={(event) => event.stopPropagation()}
              >
                <div className="menu-head">
                  <strong>Audio & playback</strong>
                  <button type="button" onClick={() => setShowAudioMenu(false)} aria-label="Close audio settings">
                    <X size={15} />
                  </button>
                </div>

                <div className="menu-section">
                  <span className="menu-label">Audio track</span>
                  <div className="menu-list">
                    {audioTracks.length > 0 ? audioTracks.map((track, index) => (
                      <button
                        key={track.id}
                        type="button"
                        className={`menu-option ${track.enabled ? 'is-selected' : ''}`}
                        onClick={() => switchAudioTrack(index)}
                      >
                        <span className="radio-dot" />
                        {track.label}
                      </button>
                    )) : (
                      <div className="menu-option is-selected">
                        <span className="radio-dot" />
                        Default stereo audio
                      </div>
                    )}
                  </div>
                </div>

                <div className="menu-section">
                  <span className="menu-label">Sound profile</span>
                  <div className="profile-grid">
                    {([
                      ['flat', 'Original', 'No processing'],
                      ['dialogue', 'Dialogue', 'Lift voices'],
                      ['night', 'Night', 'Soften loud scenes'],
                      ['bass', 'Cinema', 'Deeper low end'],
                      ['boost150', 'Loud 150%', 'For quiet speakers'],
                      ['boost200', 'Loud 200%', 'Maximum gain'],
                    ] as Array<[AudioProfile, string, string]>).map(([profile, name, description]) => (
                      <button
                        key={profile}
                        type="button"
                        className={`profile-option ${audioPrefs.profile === profile ? 'is-selected' : ''}`}
                        onClick={() => setProfile(profile)}
                      >
                        <strong>{name}</strong>
                        <small>{description}</small>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="menu-section">
                  <span className="menu-label">Playback speed</span>
                  <div className="speed-row">
                    {[0.5, 0.75, 1, 1.25, 1.5, 2].map((speed) => (
                      <button
                        key={speed}
                        type="button"
                        className={`speed-option ${audioPrefs.speed === speed ? 'is-selected' : ''}`}
                        onClick={() => setSpeed(speed)}
                      >
                        {speed}×
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            ) : null}
          </div>

          <button
            type="button"
            className="tool-button"
            onClick={() => openExternalPlayer('vlc')}
            aria-label="Stream in VLC or PotPlayer"
            title="Stream in VLC / PotPlayer"
          >
            <ExternalLink size={17} />
            <span className="tool-label">VLC</span>
          </button>

          <button
            type="button"
            className="tool-button"
            onClick={toggleFullscreen}
            aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
            title={isFullscreen ? 'Exit fullscreen (Esc)' : 'Fullscreen (F)'}
          >
            {isFullscreen ? <Minimize size={18} /> : <Maximize size={18} />}
          </button>

          <div className="menu-anchor">
            <button
              type="button"
              className={`tool-button ${showMoreMenu ? 'is-active' : ''}`}
              onClick={() => {
                setShowMoreMenu((current) => !current);
                setShowAudioMenu(false);
                setShowSubtitleMenu(false);
              }}
              aria-label="More player options"
              title="More"
            >
              <MoreHorizontal size={19} />
            </button>
            {moreMenu.mounted ? (
              <div
                className={`menu-popover more-menu ${moreMenu.closing ? 'is-closing' : ''}`}
                onMouseDown={(event) => event.stopPropagation()}
              >
                <div className="menu-list">
                  <button type="button" className="menu-row" onClick={cycleAspect}>
                    <RectangleHorizontal size={16} />
                    <span>Aspect ratio</span>
                    <em>{ASPECT_LABELS[aspectRatio]}</em>
                  </button>
                  <button type="button" className="menu-row" onClick={() => void togglePiP()}>
                    <PictureInPicture2 size={16} />
                    <span>Picture in picture</span>
                    <em>P</em>
                  </button>
                  <button type="button" className="menu-row" onClick={() => onCopyLink(video.id)}>
                    <Share2 size={16} />
                    <span>Copy stream link</span>
                    <em>VLC</em>
                  </button>
                  <a
                    className="menu-row"
                    href={`/api/media/${video.id}?download=1`}
                    download={video.name}
                  >
                    <Download size={16} />
                    <span>Download file</span>
                    <em>{sizeOf(video.size)}</em>
                  </a>
                  <button type="button" className="menu-row" onClick={() => setShowHelp(true)}>
                    <Keyboard size={16} />
                    <span>Keyboard shortcuts</span>
                    <em>?</em>
                  </button>
                </div>
              </div>
            ) : null}
          </div>

          <button type="button" className="tool-button theatre-close" onClick={closeTheatre} aria-label="Close player" title="Close (Esc)">
            <X size={19} />
          </button>
        </div>
      </header>

      <div className="theatre-scroll">
        <div className="theatre-stage">
          <div className="video-frame">
            <video
              ref={videoRef}
              className={`aspect-${aspectRatio}`}
              poster={poster}
              controls
              autoPlay
              playsInline
              preload="metadata"
              crossOrigin="anonymous"
              src={streamUrl}
              onLoadedMetadata={(event) => {
                inspectMediaTracks();
                setPlaybackError('');
                const position = getPositions()[video.id];
                if (position && position < event.currentTarget.duration - 10) {
                  event.currentTarget.currentTime = position;
                }
              }}
              onTimeUpdate={(event) => {
                const element = event.currentTarget;
                lastPosition.current = {
                  id: video.id,
                  time: element.currentTime,
                  duration: element.duration,
                };
                const now = Date.now();
                if (now - lastSavedAt.current > 5000) {
                  savePosition(video.id, element.currentTime);
                  lastSavedAt.current = now;
                }
              }}
              onEnded={() => {
                savePosition(video.id, null);
                if (nextEpisode) setAutoplayCountdown(5);
              }}
              onError={handleVideoError}
            >
              {customSubtitleUrl ? (
                <track kind="subtitles" src={customSubtitleUrl} label="Custom subtitles" default />
              ) : null}
            </video>

            {autoplayCountdown !== null && nextEpisode ? (
              <div className="autoplay-overlay">
                <div className="autoplay-card">
                  <span className="eyebrow">Up next in {autoplayCountdown}s</span>
                  <h3>{nextEpisode.episodeTitle || titleOf(nextEpisode)}</h3>
                  <p>
                    {nextEpisode.seriesName} · Season {nextEpisode.seasonNumber}
                    {' '}Episode {nextEpisode.episodeNumber}
                  </p>
                  <div className="autoplay-actions">
                    <button
                      type="button"
                      className="button button-primary"
                      onClick={() => { setAutoplayCountdown(null); onNextEpisode(); }}
                    >
                      <Play size={15} fill="currentColor" />
                      Play now
                    </button>
                    <button
                      type="button"
                      className="button button-secondary"
                      onClick={() => setAutoplayCountdown(null)}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              </div>
            ) : null}
          </div>

          {playbackError ? (
            <div className="playback-error" role="alert">
              <AlertTriangle size={20} />
              <div className="playback-error-copy">
                <strong>Playback interrupted</strong>
                <p>{playbackError}</p>
              </div>
              <div className="playback-error-actions">
                <button type="button" className="button button-primary" onClick={retryPlayback}>
                  <RefreshCw size={15} />
                  Reconnect
                </button>
                <button type="button" className="button button-secondary" onClick={() => openExternalPlayer('vlc')}>
                  <ExternalLink size={15} />
                  Open in VLC
                </button>
                <button type="button" className="button button-secondary" onClick={() => openExternalPlayer('potplayer')}>
                  <ExternalLink size={15} />
                  PotPlayer
                </button>
                <a className="button button-secondary" href={`/api/media/${video.id}?download=1`} download={video.name}>
                  <Download size={15} />
                  Download
                </a>
              </div>
            </div>
          ) : null}

          <div className="theatre-info">
            <div className="theatre-info-copy">
              <span className="theatre-meta">
                {activeEpisode
                  ? `Season ${activeEpisode.seasonNumber} · Episode ${activeEpisode.episodeNumber} · ${sizeOf(video.size)}`
                  : `${formatOf(video)} · ${sizeOf(video.size)}${video.duration ? ` · ${timeOf(video.duration)}` : ''}${video.parts && video.parts.length > 1 ? ` · ${video.parts.length} parts` : ''}`}
              </span>
              <p>{video.description || 'Streaming directly from your private TeleDrive library.'}</p>
            </div>

            <div className="theatre-actions">
              {activeEpisode ? (
                <>
                  <button
                    type="button"
                    className="button button-ghost"
                    onClick={onPreviousEpisode}
                    disabled={!hasPreviousEpisode}
                    title="Previous episode"
                  >
                    <SkipBack size={15} />
                    <span>Previous</span>
                  </button>
                  <button
                    type="button"
                    className="button button-ghost"
                    onClick={onNextEpisode}
                    disabled={!hasNextEpisode}
                    title="Next episode"
                  >
                    <span>Next</span>
                    <SkipForward size={15} />
                  </button>
                  <button
                    type="button"
                    className="button button-ghost"
                    onClick={() => setShowEpisodeDrawer((current) => !current)}
                    title="Episodes"
                  >
                    <ListVideo size={16} />
                    <span>Episodes</span>
                  </button>
                </>
              ) : null}
              <button
                type="button"
                className={`button button-ghost ${saved ? 'is-saved' : ''}`}
                onClick={onToggleSaved}
                aria-pressed={saved}
              >
                {saved ? <Check size={16} /> : <Bookmark size={15} />}
                <span>{saved ? 'Saved' : 'Save'}</span>
              </button>
              <a
                className="button button-ghost"
                href={`/api/media/${video.id}?download=1`}
                download={video.name}
                title="Download file"
              >
                <Download size={16} />
                <span>Download</span>
              </a>
            </div>
          </div>
        </div>
      </div>

      {episodeDrawer.mounted && activeEpisode ? (
        <aside
          className={`episode-drawer ${episodeDrawer.closing ? 'is-closing' : ''}`}
          aria-label="Episodes"
        >
          <div className="drawer-head">
            <div>
              <span className="eyebrow">Episodes</span>
              <strong>{activeEpisode.seriesName}</strong>
              <small>Season {activeEpisode.seasonNumber}</small>
            </div>
            <button type="button" className="tool-button" onClick={() => setShowEpisodeDrawer(false)} aria-label="Close episodes">
              <X size={17} />
            </button>
          </div>
          <div className="drawer-list">
            {seasonEpisodes.map((episode) => {
              const isCurrent = episode.id === activeEpisode.id;
              return (
                <button
                  key={episode.id}
                  type="button"
                  className={`drawer-episode ${isCurrent ? 'is-current' : ''}`}
                  onClick={() => {
                    onPlayEpisode(episode);
                    setShowEpisodeDrawer(false);
                  }}
                >
                  <span className="drawer-episode-number">E{String(episode.episodeNumber).padStart(2, '0')}</span>
                  <span className="drawer-episode-copy">
                    <strong>{episode.episodeTitle || titleOf(episode)}</strong>
                    <small>{episode.duration ? timeOf(episode.duration) : sizeOf(episode.size)}</small>
                  </span>
                  {isCurrent ? <span className="now-chip">Now</span> : <Play size={13} fill="currentColor" />}
                </button>
              );
            })}
          </div>
        </aside>
      ) : null}

      {helpOverlay.mounted ? (
        <div
          className={`overlay help-overlay ${helpOverlay.closing ? 'is-closing' : ''}`}
          onClick={() => setShowHelp(false)}
        >
          <div
            className={`help-card ${helpOverlay.closing ? 'is-closing' : ''}`}
            role="dialog"
            aria-modal="true"
            aria-label="Keyboard shortcuts"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="help-head">
              <div>
                <span className="eyebrow">Player</span>
                <h2>Keyboard shortcuts</h2>
              </div>
              <button type="button" className="tool-button" onClick={() => setShowHelp(false)} aria-label="Close shortcuts">
                <X size={18} />
              </button>
            </div>
            <div className="shortcut-grid">
              {SHORTCUTS.map(([label, keys]) => (
                <div className="shortcut-row" key={label}>
                  <span>{label}</span>
                  <kbd>{keys}</kbd>
                </div>
              ))}
            </div>
            <p className="help-note">When subtitles are available, you can upload your own .srt or .vtt file from the CC menu.</p>
          </div>
        </div>
      ) : null}
    </div>
  );
}
