import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, ArrowDownRight, AudioLines, Bookmark, Check, CheckCircle2, ChevronRight,
  Clapperboard, Copy, Disc3, Download, ExternalLink, Film, Heart, HelpCircle, Home,
  ListMusic, ListOrdered, Maximize, Minimize,
  Music2, Pause, PictureInPicture2, Play, RefreshCw,
  Search, Share2, SkipBack, SkipForward, SlidersHorizontal, Subtitles,
  Tv, Volume2, VolumeX, X,
} from 'lucide-react';
import type { AudioProfile, EpisodeItem, MediaItem, SeasonItem, SeriesItem } from './library';
import {
  artistOf, artwork, formatOf, getAudioPrefs, getPositions,
  getWatchlist, saveAudioPrefs, savePosition, saveWatchlist, sizeOf, timeOf, titleOf,
} from './library';

type View = 'home' | 'films' | 'series' | 'music' | 'saved';

function Artwork({ item, className = '' }: { item: MediaItem; className?: string }) {
  const [failed, setFailed] = useState(false);
  const src = artwork(item);
  return (
    <div className={`artwork ${className} ${item.category === 'audio' ? 'artwork-audio' : ''}`}>
      {src && !failed
        ? <img src={src} alt="" loading="lazy" onError={() => setFailed(true)} />
        : item.category === 'video' ? <Clapperboard size={38} strokeWidth={1.1} /> : <Disc3 size={45} strokeWidth={1} />}
    </div>
  );
}

function FilmCard({ item, onPlay, saved, onSave, position }: {
  item: MediaItem; onPlay: () => void; saved: boolean; onSave: () => void; position: number;
}) {
  return (
    <article className="film-card">
      <button className="poster-button" onClick={onPlay} aria-label={`Watch ${titleOf(item)}`}>
        <Artwork item={item} />
        <span className="poster-play"><Play size={20} fill="currentColor" /></span>
        <span className="format-badge">{formatOf(item)}</span>
        {position > 5 && item.duration && position < item.duration - 10
          ? <span className="resume-track"><span style={{ width: `${Math.min(position / item.duration * 100, 100)}%` }} /></span>
          : null}
      </button>
      <div className="film-info">
        <div className="film-copy">
          <h3 title={titleOf(item)}>{titleOf(item)}</h3>
          <p>
            {item.duration ? timeOf(item.duration) : 'Film'}
            <span className="dot">·</span>
            {sizeOf(item.size)}
          </p>
        </div>
        <button className={`icon-button save-button ${saved ? 'saved' : ''}`} onClick={onSave}
          aria-label={saved ? `Remove ${titleOf(item)} from My list` : `Save ${titleOf(item)} to My list`}
          title={saved ? 'Remove from My list' : 'Add to My list'}>
          {saved ? <Check size={17} /> : <Bookmark size={17} />}
        </button>
      </div>
    </article>
  );
}

function SeriesCard({ series, onSelect }: {
  series: SeriesItem;
  onSelect: () => void;
}) {
  const thumbEp = series.seasons[0]?.episodes[0];
  return (
    <article className="film-card series-card">
      <button className="poster-button" onClick={onSelect} aria-label={`View series ${series.name}`}>
        {thumbEp ? <Artwork item={thumbEp} /> : (
          <div className="artwork"><Tv size={38} strokeWidth={1.2} /></div>
        )}
        <span className="poster-play"><Tv size={20} /></span>
        <span className="format-badge series-badge">SERIES</span>
        <span className="episodes-badge">{series.seasonsCount} Season{series.seasonsCount > 1 ? 's' : ''} · {series.episodesCount} Ep</span>
      </button>
      <div className="film-info">
        <div className="film-copy">
          <h3 title={series.name}>{series.name}</h3>
          <p>
            {series.seasonsCount} Season{series.seasonsCount > 1 ? 's' : ''}
            <span className="dot">·</span>
            {series.episodesCount} Episodes
          </p>
        </div>
      </div>
    </article>
  );
}

function AudioRow({ item, index, playing, selected, onPlay, saved, onSave }: {
  item: MediaItem; index: number; playing: boolean; selected: boolean;
  onPlay: () => void; saved: boolean; onSave: () => void;
}) {
  return (
    <div className={`audio-row ${selected ? 'selected' : ''}`}>
      <button className="track-number" onClick={onPlay} aria-label={`${playing ? 'Pause' : 'Play'} ${titleOf(item)}`}>
        <span>{index + 1}</span>{playing ? <AudioLines size={18} /> : <Play size={15} fill="currentColor" />}
      </button>
      <button className="track-main" onClick={onPlay}>
        <Artwork item={item} className="track-art" />
        <span className="track-names">
          <strong>{titleOf(item)}</strong>
          <small>{artistOf(item)} <span className="audio-format-pill">{formatOf(item)}</span></small>
        </span>
      </button>
      <span className="track-album">{item.album || 'TeleDrive collection'}</span>
      <button className={`icon-button track-heart ${saved ? 'saved' : ''}`} onClick={onSave}
        title={saved ? 'Remove from My list' : 'Add to My list'}
        aria-label={saved ? `Remove ${titleOf(item)} from My list` : `Save ${titleOf(item)} to My list`}>
        <Heart size={17} fill={saved ? 'currentColor' : 'none'} />
      </button>
      <span className="track-time">{timeOf(item.duration)}</span>
    </div>
  );
}

export default function App() {
  const [view, setView] = useState<View>('home');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<MediaItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [saved, setSaved] = useState<string[]>(getWatchlist);
  const [positions, setPositions] = useState(getPositions);
  const [album, setAlbum] = useState('all');

  // Video playback state & controls
  const [video, setVideo] = useState<MediaItem | null>(null);
  const [playbackError, setPlaybackError] = useState('');
  const [audioError, setAudioError] = useState('');
  const [track, setTrack] = useState<MediaItem | null>(null);
  const [playing, setPlaying] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [volume, setVolume] = useState(0.85);
  const [streamMode, setStreamMode] = useState<'direct' | 'compat'>('direct');

  // TV Series & Episode Architecture State
  const [series, setSeries] = useState<SeriesItem[]>([]);
  const [selectedSeries, setSelectedSeries] = useState<SeriesItem | null>(null);
  const [selectedSeason, setSelectedSeason] = useState<number>(1);
  const [activeEpisode, setActiveEpisode] = useState<EpisodeItem | null>(null);
  const [showEpisodeDrawer, setShowEpisodeDrawer] = useState<boolean>(false);
  const [autoplayCountdown, setAutoplayCountdown] = useState<number | null>(null);

  // Advanced Audio & Subtitle Features
  const [audioPrefs, setAudioPrefs] = useState(getAudioPrefs);
  const [showAudioMenu, setShowAudioMenu] = useState(false);
  const [showSubtitleMenu, setShowSubtitleMenu] = useState(false);
  const [audioTracks, setAudioTracks] = useState<{ id: string; label: string; enabled: boolean }[]>([]);
  const [subtitles, setSubtitles] = useState<{ id: string; label: string; src?: string; active: boolean }[]>([]);
  const [customSubtitleUrl, setCustomSubtitleUrl] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [aspectRatio, setAspectRatio] = useState<'fit' | '16-9' | '21-9' | 'fill'>('fit');
  const [showHelp, setShowHelp] = useState(false);
  const [subOffset, setSubOffset] = useState(0);

  // Episode tracking and sequential navigation
  const currentSeries = useMemo(() => {
    if (!activeEpisode) return null;
    return series.find((s) => s.id === activeEpisode.seriesId) ?? selectedSeries;
  }, [activeEpisode, series, selectedSeries]);

  const currentSeasonData = useMemo(() => {
    if (!currentSeries || !activeEpisode) return null;
    return currentSeries.seasons.find((se) => se.seasonNumber === activeEpisode.seasonNumber) ?? currentSeries.seasons[0] ?? null;
  }, [currentSeries, activeEpisode]);

  const activeSeasonEpisodes = useMemo(() => currentSeasonData?.episodes ?? [], [currentSeasonData]);

  const currentEpisodeIndex = useMemo(() => {
    if (!activeEpisode || !activeSeasonEpisodes.length) return -1;
    return activeSeasonEpisodes.findIndex((e) => e.id === activeEpisode.id);
  }, [activeEpisode, activeSeasonEpisodes]);

  const hasPreviousEpisode = currentEpisodeIndex > 0;
  const previousEpisode = hasPreviousEpisode ? activeSeasonEpisodes[currentEpisodeIndex - 1] : null;

  const hasNextEpisode = currentEpisodeIndex >= 0 && currentEpisodeIndex < activeSeasonEpisodes.length - 1;
  const nextEpisode = hasNextEpisode ? activeSeasonEpisodes[currentEpisodeIndex + 1] : null;

  function playEpisode(ep: EpisodeItem, s: SeriesItem) {
    audioRef.current?.pause();
    setPlaying(false);
    setPlaybackError('');
    setShowAudioMenu(false);
    setShowSubtitleMenu(false);
    setShowEpisodeDrawer(false);
    setAutoplayCountdown(null);
    setSelectedSeries(s);
    setSelectedSeason(ep.seasonNumber || 1);
    setActiveEpisode(ep);
    setVideo(ep);
    lastSavedAt.current = 0;
  }

  function playNextEpisode() {
    if (nextEpisode && currentSeries) {
      playEpisode(nextEpisode, currentSeries);
    }
  }

  function playPreviousEpisode() {
    if (previousEpisode && currentSeries) {
      playEpisode(previousEpisode, currentSeries);
    }
  }

  const copyStreamUrl = (id: string) => {
    const fullUrl = `${window.location.origin}/api/media/${id}`;
    if (navigator.clipboard) {
      void navigator.clipboard.writeText(fullUrl).then(() => {
        setToast('Direct stream link copied! Paste into VLC, IINA, or MPV to stream.');
        setTimeout(() => setToast(null), 4000);
      }).catch(() => {
        prompt('Copy stream URL for VLC/IINA/PotPlayer:', fullUrl);
      });
    } else {
      prompt('Copy stream URL for VLC/IINA/PotPlayer:', fullUrl);
    }
  };

  const retryPlayback = () => {
    setPlaybackError('');
    setStreamMode('compat');
    if (videoRef.current) {
      videoRef.current.load();
      void videoRef.current.play().catch(() => {});
    }
  };

  useEffect(() => {
    if (!video) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement).tagName)) return;
      const v = videoRef.current;
      if (!v) return;

      switch (e.key) {
        case ' ':
        case 'k':
        case 'K':
          e.preventDefault();
          if (v.paused) v.play().catch(() => {});
          else v.pause();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          v.currentTime = Math.max(0, v.currentTime - 5);
          break;
        case 'ArrowRight':
          e.preventDefault();
          v.currentTime = Math.min(v.duration || 8884, v.currentTime + 5);
          break;
        case 'j':
        case 'J':
          e.preventDefault();
          v.currentTime = Math.max(0, v.currentTime - 10);
          break;
        case 'l':
        case 'L':
          e.preventDefault();
          v.currentTime = Math.min(v.duration || 8884, v.currentTime + 10);
          break;
        case 'ArrowUp':
          e.preventDefault();
          v.volume = Math.min(1, v.volume + 0.05);
          break;
        case 'ArrowDown':
          e.preventDefault();
          v.volume = Math.max(0, v.volume - 0.05);
          break;
        case 'm':
        case 'M':
          e.preventDefault();
          v.muted = !v.muted;
          break;
        case 'f':
        case 'F':
          e.preventDefault();
          toggleFullscreen();
          break;
        case 'p':
        case 'P':
          e.preventDefault();
          togglePiP();
          break;
        case '?':
          e.preventDefault();
          setShowHelp((h) => !h);
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [video]);

  const videoRef = useRef<HTMLVideoElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const queueRef = useRef<MediaItem[]>([]);
  const lastSavedAt = useRef(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const subInputRef = useRef<HTMLInputElement>(null);

  // Web Audio Equalizer DSP Graph
  const audioCtxRef = useRef<AudioContext | null>(null);
  const audioNodesRef = useRef<{
    source: MediaElementAudioSourceNode;
    dialogue: BiquadFilterNode;
    bass: BiquadFilterNode;
    compressor: DynamicsCompressorNode;
    gain: GainNode;
  } | null>(null);

  useEffect(() => {
    const timeout = window.setTimeout(() => setQuery(search.trim()), 280);
    return () => window.clearTimeout(timeout);
  }, [search]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    const type = view === 'films' || view === 'series' ? 'video' : view === 'music' ? 'audio' : 'all';
    fetch(`/api/catalog?${new URLSearchParams({ type, q: query })}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(response.status === 401
          ? 'Your viewing session expired. Sign in with Cloudflare Access to continue.'
          : 'TeleDrive is unavailable. Check your connection or hosted settings.');
        return response.json() as Promise<{ items?: MediaItem[]; series?: SeriesItem[] }>;
      })
      .then((data) => {
        setItems(data.items || []);
        if (Array.isArray(data.series)) {
          setSeries(data.series);
        }
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setError(reason instanceof Error ? reason.message : 'Could not load your library.');
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [query, view, refresh]);

  // Autoplay countdown timer for sequential series binge watching
  useEffect(() => {
    if (autoplayCountdown === null) return;
    if (autoplayCountdown <= 0) {
      setAutoplayCountdown(null);
      playNextEpisode();
      return;
    }
    const timer = window.setTimeout(() => {
      setAutoplayCountdown((prev) => (prev !== null && prev > 0 ? prev - 1 : null));
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [autoplayCountdown, nextEpisode, currentSeries]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (showAudioMenu || showSubtitleMenu) {
          setShowAudioMenu(false);
          setShowSubtitleMenu(false);
          return;
        }
        setVideo(null);
        setPositions(getPositions());
      }
      if (event.key === '/' && !(event.target instanceof HTMLInputElement)) {
        event.preventDefault();
        searchRef.current?.focus();
      }
      if (video && !(event.target instanceof HTMLInputElement)) {
        if (event.key === ' ' || event.key === 'k') {
          event.preventDefault();
          if (videoRef.current?.paused) void videoRef.current.play();
          else videoRef.current?.pause();
        }
        if (event.key === 'f') {
          event.preventDefault();
          toggleFullscreen();
        }
        if (event.key === 'p') {
          event.preventDefault();
          togglePiP();
        }
        if (event.key === 'a') {
          event.preventDefault();
          setShowAudioMenu((v) => !v);
        }
        if (event.key === 'm') {
          event.preventDefault();
          if (videoRef.current) videoRef.current.muted = !videoRef.current.muted;
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [video, showAudioMenu, showSubtitleMenu]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !track) return;
    audio.load();
    audio.volume = volume;
    setElapsed(0);
    void audio.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
  }, [track?.id]);

  useEffect(() => { if (audioRef.current) audioRef.current.volume = volume; }, [volume]);

  // Apply Web Audio DSP Profile to video
  const applyAudioProfile = (profile: AudioProfile, speed = audioPrefs.speed) => {
    const v = videoRef.current;
    if (!v) return;

    v.playbackRate = speed;

    try {
      if (!audioCtxRef.current) {
        const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        if (!AudioCtx) return;
        const ctx = new AudioCtx();
        audioCtxRef.current = ctx;
        const source = ctx.createMediaElementSource(v);
        const bass = ctx.createBiquadFilter();
        bass.type = 'lowshelf';
        bass.frequency.value = 140;

        const dialogue = ctx.createBiquadFilter();
        dialogue.type = 'peaking';
        dialogue.frequency.value = 2400;
        dialogue.Q.value = 1.1;

        const compressor = ctx.createDynamicsCompressor();
        compressor.threshold.value = -24;
        compressor.knee.value = 20;
        compressor.ratio.value = 12;

        const gain = ctx.createGain();

        source.connect(bass);
        bass.connect(dialogue);
        dialogue.connect(compressor);
        compressor.connect(gain);
        gain.connect(ctx.destination);

        audioNodesRef.current = { source, dialogue, bass, compressor, gain };
      }

      const ctx = audioCtxRef.current;
      if (ctx && ctx.state === 'suspended') void ctx.resume();

      const nodes = audioNodesRef.current;
      if (!nodes) return;

      if (profile === 'flat') {
        nodes.dialogue.gain.value = 0;
        nodes.bass.gain.value = 0;
        nodes.compressor.threshold.value = 0;
        nodes.gain.gain.value = 1.0;
      } else if (profile === 'dialogue') {
        nodes.dialogue.gain.value = 8.5; // clear vocal frequency boost
        nodes.bass.gain.value = -2.0;
        nodes.compressor.threshold.value = -12;
        nodes.gain.gain.value = 1.0;
      } else if (profile === 'night') {
        nodes.dialogue.gain.value = 6.0;
        nodes.bass.gain.value = -3.5;
        nodes.compressor.threshold.value = -28; // soften loud explosions & gunshots
        nodes.compressor.ratio.value = 16;
        nodes.gain.gain.value = 1.1;
      } else if (profile === 'bass') {
        nodes.dialogue.gain.value = 1.0;
        nodes.bass.gain.value = 7.5; // cinema punch
        nodes.compressor.threshold.value = -6;
        nodes.gain.gain.value = 1.0;
      } else if (profile === 'boost150') {
        nodes.dialogue.gain.value = 2.0;
        nodes.bass.gain.value = 0;
        nodes.compressor.threshold.value = -10;
        nodes.gain.gain.value = 1.5;
      } else if (profile === 'boost200') {
        nodes.dialogue.gain.value = 3.0;
        nodes.bass.gain.value = 0;
        nodes.compressor.threshold.value = -14;
        nodes.gain.gain.value = 2.0;
      }
    } catch (e) {
      console.warn('Audio DSP initialization bypassed:', e);
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

  // Inspect HTML5 AudioTracks on video loaded
  const inspectMediaTracks = () => {
    const v = videoRef.current;
    if (!v) return;
    applyAudioProfile(audioPrefs.profile, audioPrefs.speed);

    // Audio tracks (Safari & Chromium flag supported)
    const mediaWithAudio = v as HTMLVideoElement & {
      audioTracks?: { length: number; [index: number]: { id: string; label: string; language: string; enabled: boolean } };
    };
    if (mediaWithAudio.audioTracks && mediaWithAudio.audioTracks.length > 0) {
      const list = [];
      for (let i = 0; i < mediaWithAudio.audioTracks.length; i++) {
        const t = mediaWithAudio.audioTracks[i]!;
        list.push({
          id: t.id || `track-${i}`,
          label: t.label || t.language || `Audio Track ${i + 1}`,
          enabled: Boolean(t.enabled),
        });
      }
      setAudioTracks(list);
    } else {
      setAudioTracks([
        { id: 'default', label: 'Default Stereo Audio', enabled: true },
      ]);
    }

    // Text tracks
    if (v.textTracks && v.textTracks.length > 0) {
      const subList = [];
      for (let i = 0; i < v.textTracks.length; i++) {
        const sub = v.textTracks[i]!;
        subList.push({
          id: `sub-${i}`,
          label: sub.label || sub.language || `Subtitle ${i + 1}`,
          active: sub.mode === 'showing',
        });
      }
      setSubtitles(subList);
    }
  };

  const switchAudioTrack = (index: number) => {
    const v = videoRef.current as HTMLVideoElement & {
      audioTracks?: { length: number; [i: number]: { enabled: boolean } };
    };
    if (v?.audioTracks && v.audioTracks.length > 0) {
      for (let i = 0; i < v.audioTracks.length; i++) {
        v.audioTracks[i]!.enabled = (i === index);
      }
    }
    setAudioTracks((current) =>
      current.map((t, i) => ({ ...t, enabled: i === index })),
    );
  };

  const togglePiP = async () => {
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else if (videoRef.current) {
        await videoRef.current.requestPictureInPicture();
      }
    } catch (e) {
      console.warn('PiP not available:', e);
    }
  };

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      void modalRef.current?.requestFullscreen().then(() => setIsFullscreen(true)).catch(() => {});
    } else {
      void document.exitFullscreen().then(() => setIsFullscreen(false)).catch(() => {});
    }
  };

  const handleCustomSubtitleUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      let content = String(e.target?.result ?? '');
      // If SRT, convert to WebVTT
      if (file.name.toLowerCase().endsWith('.srt')) {
        content = 'WEBVTT\n\n' + content.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
      }
      const blob = new Blob([content], { type: 'text/vtt' });
      const url = URL.createObjectURL(blob);
      setCustomSubtitleUrl(url);
      setSubtitles((prev) => [
        ...prev.map((s) => ({ ...s, active: false })),
        { id: 'custom', label: file.name, src: url, active: true },
      ]);
    };
    reader.readAsText(file);
  };

  const videos = useMemo(() => items.filter((item) => item.category === 'video'), [items]);
  const songs = useMemo(() => items.filter((item) => item.category === 'audio'), [items]);
  const albums = useMemo(() => [...new Set(songs.map((item) => item.album).filter(Boolean))].sort(), [songs]);
  const visibleVideos = view === 'saved' ? videos.filter((item) => saved.includes(item.id)) : videos;
  const visibleSongs = (view === 'saved' ? songs.filter((item) => saved.includes(item.id)) : songs)
    .filter((item) => view !== 'music' || album === 'all' || item.album === album);
  const continueWatching = videos.filter((item) => {
    const position = positions[item.id] ?? 0;
    return position > 5 && item.duration !== null && position < item.duration - 10;
  });
  const hero = continueWatching[0] ?? videos[0];

  function toggleSaved(id: string) {
    setSaved((current) => {
      const next = current.includes(id) ? current.filter((item) => item !== id) : [id, ...current];
      saveWatchlist(next);
      return next;
    });
  }

  function playVideo(item: MediaItem) {
    audioRef.current?.pause();
    setPlaying(false);
    setPlaybackError('');
    setShowAudioMenu(false);
    setShowSubtitleMenu(false);
    setShowEpisodeDrawer(false);
    setActiveEpisode(null);
    setAutoplayCountdown(null);
    const isMkv = item.name.toLowerCase().endsWith('.mkv');
    setStreamMode(isMkv ? 'compat' : 'direct');
    setVideo(item);
    lastSavedAt.current = 0;
  }

  function closeVideo() {
    setVideo(null);
    setActiveEpisode(null);
    setShowEpisodeDrawer(false);
    setAutoplayCountdown(null);
    setStreamMode('direct');
    setShowAudioMenu(false);
    setShowSubtitleMenu(false);
    setPositions(getPositions());
    if (customSubtitleUrl) URL.revokeObjectURL(customSubtitleUrl);
    setCustomSubtitleUrl(null);
  }

  function playSong(item: MediaItem) {
    if (track?.id === item.id) {
      if (audioRef.current?.paused) void audioRef.current.play().catch(() => setPlaying(false));
      else audioRef.current?.pause();
    } else {
      closeVideo();
      setAudioError('');
      queueRef.current = visibleSongs.length ? visibleSongs : [item];
      setTrack(item);
    }
  }

  function skip(direction: number) {
    const queue = queueRef.current.length ? queueRef.current : track ? [track] : [];
    if (!queue.length || !track) return;
    const current = queue.findIndex((item) => item.id === track.id);
    setTrack(queue[(current + direction + queue.length) % queue.length] ?? track);
  }

  const nav: { id: View; label: string; icon: typeof Home }[] = [
    { id: 'home', label: 'Discover', icon: Home },
    { id: 'films', label: 'Films', icon: Film },
    { id: 'series', label: 'TV Series', icon: Tv },
    { id: 'music', label: 'Music', icon: Music2 },
    { id: 'saved', label: 'My list', icon: Bookmark },
  ];

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button className="brand" onClick={() => setView('home')} aria-label="Folio home">
          <span className="brand-mark"><span /></span><span className="brand-name">folio<span>.</span></span>
        </button>
        <div className="side-label">YOUR SPACE</div>
        <nav className="main-nav" aria-label="Main navigation">
          {nav.map(({ id, label, icon: Icon }) => (
            <button key={id} className={`nav-item ${view === id ? 'current' : ''}`} onClick={() => setView(id)}
              aria-current={view === id ? 'page' : undefined}>
              <Icon size={19} strokeWidth={1.8} /><span>{label}</span>
              {id === 'saved' && saved.length > 0 && <small>{saved.length}</small>}
            </button>
          ))}
        </nav>
        <div className="sidebar-note">
          <span className="note-icon"><Disc3 size={20} /></span>
          <strong>Cloud streaming active.</strong>
          <p>Every film and song streams directly with instant seek scrubbing.</p>
        </div>
        <div className="sidebar-foot">
          <span className={`connection-dot ${error ? 'offline' : ''}`} />
          TELEDRIVE {error ? 'OFFLINE' : 'ONLINE'}
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div className="mobile-brand"><span className="brand-mark"><span /></span><b>folio<span>.</span></b></div>
          <div className="search-wrap"><Search size={18} />
            <input ref={searchRef} value={search} onChange={(event) => setSearch(event.target.value)}
              placeholder="Search films, MKV, series, artists, tracks..." aria-label="Search your library" maxLength={120} />
            <kbd>/</kbd>
          </div>
          <div className="topbar-end"><span>THE CLOUD SCREENING ROOM</span>
            <button className="icon-button refresh-button" onClick={() => setRefresh((n) => n + 1)}
              title="Refresh library" aria-label="Refresh library"><RefreshCw size={19} /></button>
          </div>
        </header>

        {error && <div className="error-panel" role="alert"><strong>We couldn't reach your library.</strong>
          <p>{error}</p><button onClick={() => setRefresh((n) => n + 1)}>Try again <ArrowDownRight size={16} /></button>
          {error.includes('session') && <a href="/cdn-cgi/access/login">Sign in again</a>}
        </div>}

        {!error && <>
          {view === 'home' && !query && <section className="hero" aria-label="Featured film">
            {hero?.hasThumbnail && <div className="hero-image" style={{ backgroundImage: `url(${artwork(hero)})` }} />}
            <div className="hero-shade" />
            <div className="hero-content">
              <div className="eyebrow"><span /> THE PRIVATE SCREENING ROOM</div>
              <h1>{hero ? titleOf(hero) : <>Stories you own.<br /><em>Anywhere.</em></>}</h1>
              <p>{hero
                ? hero.description || 'An evening well spent starts with something from your own collection.'
                : 'A home for the films and music in your TeleDrive library. Stream seamlessly without pre-downloading.'}</p>
              <div className="hero-actions">
                {hero && <button className="primary-button" onClick={() => playVideo(hero)}><Play size={17} fill="currentColor" /> Watch now</button>}
                <button className="secondary-button" onClick={() => setView('films')}>Explore films <ChevronRight size={17} /></button>
              </div>
              {hero && <div className="hero-meta">
                <span>{formatOf(hero)}</span><i></i><span>{sizeOf(hero.size)}</span><i></i><span>{timeOf(hero.duration)}</span>
              </div>}
            </div>
            <div className="hero-index">01 <span>/ HIGH FIDELITY</span></div>
          </section>}

          <div className="library-content">
            {view !== 'home' || query ? <div className="page-heading">
              <div><div className="eyebrow"><span /> YOUR PRIVATE COLLECTION</div>
                <h1>{query ? `Results for “${query}”` : view === 'films' ? 'The screening room' : view === 'series' ? 'TV series & shows' : view === 'music' ? 'The listening room' : 'Your list'}</h1>
                <p>{view === 'saved' ? 'The ones you want to return to.' : view === 'series' ? 'Episodic television and documentary series.' : 'Films, series, and lossless audio.'}</p>
              </div>
              <span className="results-count">{visibleVideos.length + visibleSongs.length + series.length} TITLES</span>
            </div> : null}

            {loading ? <div className="loading" role="status"><div className="loading-bar" />Gathering your collection...</div> : <>
              {view === 'home' && !query && continueWatching.length > 0 && <section className="shelf" aria-label="Continue watching">
                <div className="section-head"><div><span className="section-kicker">PICK UP WHERE YOU LEFT OFF</span>
                  <h2>Continue watching</h2></div></div>
                <div className="film-grid">{continueWatching.slice(0, 5).map((item) =>
                  <FilmCard key={item.id} item={item} position={positions[item.id] ?? 0}
                    onPlay={() => playVideo(item)} saved={saved.includes(item.id)} onSave={() => toggleSaved(item.id)} />)}</div>
              </section>}

              {/* Home View: TV Series shelf */}
              {view === 'home' && !query && series.length > 0 && (
                <section className="shelf" aria-label="TV Series">
                  <div className="section-head">
                    <div>
                      <span className="section-kicker">01 / TELEVISION & SERIES</span>
                      <h2>TV series & shows</h2>
                    </div>
                    <button className="text-link" onClick={() => setView('series')}>
                      View all <ChevronRight size={16} />
                    </button>
                  </div>
                  <div className="film-grid">
                    {series.slice(0, 6).map((s) => (
                      <SeriesCard
                        key={s.id}
                        series={s}
                        onSelect={() => {
                          setSelectedSeries(s);
                          setSelectedSeason(s.seasons[0]?.seasonNumber || 1);
                        }}
                      />
                    ))}
                  </div>
                </section>
              )}

              {/* Dedicated Series View */}
              {view === 'series' && (
                <section className="shelf" aria-label="TV Series">
                  <div className="film-grid">
                    {series.map((s) => (
                      <SeriesCard
                        key={s.id}
                        series={s}
                        onSelect={() => {
                          setSelectedSeries(s);
                          setSelectedSeason(s.seasons[0]?.seasonNumber || 1);
                        }}
                      />
                    ))}
                  </div>
                  {series.length === 0 && (
                    <div className="empty-state">
                      <span><Tv size={36} strokeWidth={1.2} /></span>
                      <h2>No TV series in library yet.</h2>
                      <p>Folders inside 'stream' in TeleDrive Videos are automatically recognized as series and seasons.</p>
                    </div>
                  )}
                </section>
              )}

              {/* Films Shelf */}
              {(view === 'films' || (view === 'home' && visibleVideos.length > 0) || (view === 'saved' && visibleVideos.length > 0)) && (
                <section className="shelf" aria-label="Films">
                  <div className="section-head">
                    <div>
                      <span className="section-kicker">{view === 'home' && series.length > 0 ? '02 / FEATURE FILMS' : '01 / CINEMA & MOVIES'}</span>
                      <h2>{view === 'home' ? 'Made for movie nights' : 'Feature films'}</h2>
                    </div>
                    {view === 'home' && <button className="text-link" onClick={() => setView('films')}>View all <ChevronRight size={16} /></button>}
                  </div>
                  <div className="film-grid">
                    {(view === 'home' ? visibleVideos.slice(0, 8) : visibleVideos).map((item) => (
                      <FilmCard
                        key={item.id}
                        item={item}
                        position={positions[item.id] ?? 0}
                        onPlay={() => playVideo(item)}
                        saved={saved.includes(item.id)}
                        onSave={() => toggleSaved(item.id)}
                      />
                    ))}
                  </div>
                </section>
              )}

              {(visibleSongs.length > 0 || (view === 'music' && songs.length > 0)) && <section className="shelf music-shelf" aria-label="Music">
                <div className="section-head"><div><span className="section-kicker">02 / ON REPEAT</span>
                  <h2>{view === 'home' ? 'Soundtrack your day' : 'The music collection'}</h2></div>
                  {view === 'home' && <button className="text-link" onClick={() => setView('music')}>View all <ChevronRight size={16} /></button>}
                </div>
                {view === 'music' && albums.length > 0 && <div className="album-filters" aria-label="Filter by album">
                  <button className={album === 'all' ? 'current' : ''} onClick={() => setAlbum('all')}>All music</button>
                  {albums.map((name) => <button key={name} className={album === name ? 'current' : ''}
                    onClick={() => setAlbum(name)}>{name}</button>)}
                </div>}
                <div className="tracks-head"><span>#</span><span>TRACK</span><span>ALBUM</span><span /><span>DURATION</span></div>
                <div className="track-list">{(view === 'home' ? visibleSongs.slice(0, 6) : visibleSongs).map((item, index) =>
                  <AudioRow key={item.id} item={item} index={index} selected={track?.id === item.id}
                    playing={track?.id === item.id && playing} onPlay={() => playSong(item)}
                    saved={saved.includes(item.id)} onSave={() => toggleSaved(item.id)} />)}</div>
                {view === 'music' && !visibleSongs.length && <p className="filter-empty">
                  No tracks in this album for this search. <button onClick={() => setAlbum('all')}>Show all music</button>
                </p>}
              </section>}

              {!visibleVideos.length && !visibleSongs.length && !(view === 'music' && songs.length > 0) && <div className="empty-state">
                <span><ListMusic size={36} strokeWidth={1.2} /></span>
                <h2>{query ? 'Nothing by that name yet.' : view === 'saved' ? 'Your list starts here.' : 'A little quiet in here.'}</h2>
                <p>{query ? 'Try another film, artist or track.' : view === 'saved'
                  ? 'Save anything you love for an easy way back.'
                  : 'Add MP4, MKV, or audio files in TeleDrive to populate your collection.'}</p>
              </div>}
            </>}
          </div>
        </>}
      </main>

      <audio ref={audioRef} src={track ? `/api/media/${track.id}` : undefined} preload="metadata"
        onPlay={() => { setPlaying(true); setAudioError(''); }} onPause={() => setPlaying(false)}
        onError={() => { if (track) setAudioError('Track unavailable. Check file format or connection.'); }}
        onTimeUpdate={(event) => setElapsed(event.currentTarget.currentTime)}
        onEnded={() => skip(1)} />

      <footer className="player">
        <div className="player-track">{track ? <><Artwork item={track} className="player-art" /><div>
          <strong>{titleOf(track)}</strong><span>{audioError || artistOf(track)}</span></div>
          <button className={`icon-button ${saved.includes(track.id) ? 'saved' : ''}`} onClick={() => toggleSaved(track.id)}
            aria-label={saved.includes(track.id) ? 'Remove from My list' : 'Save to My list'}>
            <Heart size={17} fill={saved.includes(track.id) ? 'currentColor' : 'none'} />
          </button></> : <><span className="player-idle"><Music2 size={21} /></span><div><strong>Your listening room</strong><span>Pick a track to get started</span></div></>}</div>
        <div className="player-center">
          <div className="play-controls">
            <button onClick={() => skip(-1)} disabled={!track} title="Previous" aria-label="Previous track"><SkipBack size={18} fill="currentColor" /></button>
            <button className="play-toggle" onClick={() => track && playSong(track)} disabled={!track} aria-label={playing ? 'Pause' : 'Play'}>
              {playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
            </button>
            <button onClick={() => skip(1)} disabled={!track} title="Next" aria-label="Next track"><SkipForward size={18} fill="currentColor" /></button>
          </div>
          <div className="timeline"><span>{timeOf(elapsed)}</span><input aria-label="Seek in track" type="range" min="0"
            max={Math.max(audioRef.current?.duration || track?.duration || 0, 1)} value={Math.min(elapsed, audioRef.current?.duration || track?.duration || 1)}
            disabled={!track} onChange={(event) => { if (audioRef.current) audioRef.current.currentTime = Number(event.target.value); }} />
            <span>{timeOf(audioRef.current?.duration || track?.duration)}</span></div>
        </div>
        <div className="player-volume">{volume === 0 ? <VolumeX size={18} /> : <Volume2 size={18} />}
          <input aria-label="Volume" type="range" min="0" max="1" step="0.01" value={volume}
            onChange={(event) => setVolume(Number(event.target.value))} /></div>
      </footer>

      {/* SERIES HUB MODAL */}
      {selectedSeries && (
        <div className="modal-backdrop series-hub-backdrop" role="presentation" onMouseDown={(e) => {
          if (e.target === e.currentTarget) setSelectedSeries(null);
        }}>
          <div className="series-hub-modal" role="dialog" aria-modal="true" aria-label={selectedSeries.name}>
            <div className="series-hub-header">
              <div className="series-hub-header-content">
                <span className="modal-tag">TELEDRIVE TV SERIES · {selectedSeries.seasonsCount} SEASON{selectedSeries.seasonsCount > 1 ? 'S' : ''}</span>
                <h2>{selectedSeries.name}</h2>
                <p>{selectedSeries.description || `${selectedSeries.seasonsCount} Season${selectedSeries.seasonsCount > 1 ? 's' : ''} · ${selectedSeries.episodesCount} Episodes streamed directly.`}</p>
              </div>
              <button className="close-video-btn" onClick={() => setSelectedSeries(null)} aria-label="Close series hub">
                <X size={20} />
              </button>
            </div>

            {/* Season Tabs */}
            <div className="season-tabs">
              {selectedSeries.seasons.map((season) => (
                <button
                  key={season.seasonNumber}
                  className={`season-tab ${selectedSeason === season.seasonNumber ? 'active' : ''}`}
                  onClick={() => setSelectedSeason(season.seasonNumber)}>
                  Season {season.seasonNumber}
                  <span className="season-ep-count">({season.episodes.length})</span>
                </button>
              ))}
            </div>

            {/* Episode List for Selected Season */}
            <div className="episode-list">
              {(() => {
                const activeSeasonData = selectedSeries.seasons.find((s) => s.seasonNumber === selectedSeason) || selectedSeries.seasons[0];
                if (!activeSeasonData || activeSeasonData.episodes.length === 0) {
                  return <div className="no-episodes">No episodes found in this season.</div>;
                }
                return activeSeasonData.episodes.map((ep, idx) => {
                  const isPlayingThis = video?.id === ep.id;
                  return (
                    <div key={ep.id} className={`episode-row ${isPlayingThis ? 'playing-now' : ''}`}>
                      <div className="episode-number">
                        <span>{String(ep.episodeNumber || idx + 1).padStart(2, '0')}</span>
                      </div>
                      <div className="episode-thumb-wrap">
                        <Artwork item={ep} className="episode-thumb" />
                        <button className="episode-play-overlay" onClick={() => playEpisode(ep, selectedSeries)}>
                          <Play size={16} fill="currentColor" />
                        </button>
                      </div>
                      <div className="episode-details" onClick={() => playEpisode(ep, selectedSeries)}>
                        <div className="episode-title-row">
                          <strong>{ep.episodeTitle || ep.name}</strong>
                          {isPlayingThis && <span className="now-playing-pill">NOW PLAYING</span>}
                        </div>
                        <div className="episode-subtext">
                          {ep.duration ? <span>{timeOf(ep.duration)}</span> : null}
                          {ep.duration && <span className="dot">·</span>}
                          <span>{sizeOf(ep.size)}</span>
                          <span className="dot">·</span>
                          <span>{formatOf(ep)}</span>
                        </div>
                      </div>
                      <div className="episode-actions">
                        <button className="primary-button play-ep-btn" onClick={() => playEpisode(ep, selectedSeries)}>
                          <Play size={14} fill="currentColor" /> Play
                        </button>
                        <button className="icon-button" onClick={() => copyStreamUrl(ep.id)} title="Copy stream URL">
                          <Share2 size={16} />
                        </button>
                      </div>
                    </div>
                  );
                });
              })()}
            </div>
          </div>
        </div>
      )}

      {/* ENHANCED VIDEO MODAL WITH MULTI-AUDIO, EQUALIZER, SUBTITLES & PIP */}
      {video && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeVideo();
      }}>
        <div ref={modalRef} className={`video-modal ${isFullscreen ? 'fullscreen' : ''}`} role="dialog" aria-modal="true" aria-label={`Watching ${titleOf(video)}`}>
          <div className="modal-header">
            <div className="modal-title-block">
              {activeEpisode ? (
                <>
                  <span className="modal-tag">
                    SERIES · {activeEpisode.seriesName.toUpperCase()} · S{String(activeEpisode.seasonNumber).padStart(2, '0')}E{String(activeEpisode.episodeNumber).padStart(2, '0')} · {sizeOf(activeEpisode.size)}
                  </span>
                  <strong title={activeEpisode.episodeTitle || activeEpisode.name}>
                    {activeEpisode.episodeTitle || activeEpisode.name}
                  </strong>
                </>
              ) : (
                <>
                  <span className="modal-tag">NOW PLAYING · {formatOf(video)} · {sizeOf(video.size)}</span>
                  <strong title={titleOf(video)}>{titleOf(video)}</strong>
                </>
              )}
            </div>
            <div className="modal-actions">
              {/* If TV series episode: Episode Navigation & Drawer */}
              {activeEpisode && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <button
                    className="player-tool-btn"
                    onClick={playPreviousEpisode}
                    disabled={!hasPreviousEpisode}
                    title="Previous Episode">
                    <SkipBack size={15} />
                    <span>Prev</span>
                  </button>
                  <button
                    className="player-tool-btn"
                    onClick={playNextEpisode}
                    disabled={!hasNextEpisode}
                    title="Next Episode">
                    <SkipForward size={15} />
                    <span>Next</span>
                  </button>
                  <button
                    className={`player-tool-btn ${showEpisodeDrawer ? 'active' : ''}`}
                    onClick={() => setShowEpisodeDrawer((v) => !v)}
                    title="Episodes Drawer">
                    <ListOrdered size={15} />
                    <span>Episodes</span>
                  </button>
                </div>
              )}

              {/* Audio Track & Equalizer Switcher Button */}
              <div className="popover-wrap">
                <button
                  className={`player-tool-btn ${showAudioMenu ? 'active' : ''}`}
                  onClick={() => { setShowAudioMenu((v) => !v); setShowSubtitleMenu(false); }}
                  title="Audio tracks & Equalizer"
                  aria-label="Audio tracks & Equalizer">
                  <SlidersHorizontal size={15} />
                  <span className="tool-badge">{audioPrefs.profile === 'flat' ? 'Audio' : audioPrefs.profile.toUpperCase()}</span>
                </button>

                {showAudioMenu && (
                  <div className="audio-menu-popover" onMouseDown={(e) => e.stopPropagation()}>
                    <div className="popover-head">
                      <strong>Audio Tracks & Equalizer</strong>
                      <button className="icon-button close-pop" onClick={() => setShowAudioMenu(false)}><X size={15} /></button>
                    </div>

                    {/* Audio Streams / Multi-track selector */}
                    <div className="popover-section">
                      <span className="popover-label">AUDIO STREAM</span>
                      <div className="audio-track-list">
                        {audioTracks.length > 0 ? (
                          audioTracks.map((tr, idx) => (
                            <button
                              key={tr.id}
                              className={`audio-option-btn ${tr.enabled ? 'selected' : ''}`}
                              onClick={() => switchAudioTrack(idx)}>
                              <span className="radio-circle">{tr.enabled && <span className="inner-dot" />}</span>
                              <span>{tr.label}</span>
                            </button>
                          ))
                        ) : (
                          <div className="audio-option-btn selected" style={{ cursor: 'default' }}>
                            <span className="radio-circle"><span className="inner-dot" /></span>
                            <span>Main Audio Track (AAC Stereo / Surround)</span>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* DSP Voice Equalizer Profiles */}
                    <div className="popover-section">
                      <span className="popover-label">EQUALIZER & VOICE CLARITY</span>
                      <div className="profile-grid">
                        <button className={`profile-pill ${audioPrefs.profile === 'flat' ? 'active' : ''}`} onClick={() => setProfile('flat')}>
                          <strong>Flat (Original)</strong>
                          <small>Studio standard</small>
                        </button>
                        <button className={`profile-pill ${audioPrefs.profile === 'dialogue' ? 'active' : ''}`} onClick={() => setProfile('dialogue')}>
                          <strong>✨ Clear Dialogue</strong>
                          <small>Boost vocal frequencies</small>
                        </button>
                        <button className={`profile-pill ${audioPrefs.profile === 'night' ? 'active' : ''}`} onClick={() => setProfile('night')}>
                          <strong>🌙 Night Mode</strong>
                          <small>Soft explosions, clear voices</small>
                        </button>
                        <button className={`profile-pill ${audioPrefs.profile === 'bass' ? 'active' : ''}`} onClick={() => setProfile('bass')}>
                          <strong>🔊 Cinema Bass</strong>
                          <small>Deep movie punch</small>
                        </button>
                        <button className={`profile-pill ${audioPrefs.profile === 'boost150' ? 'active' : ''}`} onClick={() => setProfile('boost150')}>
                          <strong>⚡ Extra Loud 150%</strong>
                          <small>Boost low laptop audio</small>
                        </button>
                        <button className={`profile-pill ${audioPrefs.profile === 'boost200' ? 'active' : ''}`} onClick={() => setProfile('boost200')}>
                          <strong>🔥 Max Boost 200%</strong>
                          <small>High output gain</small>
                        </button>
                      </div>
                    </div>

                    {/* Playback Speed */}
                    <div className="popover-section">
                      <span className="popover-label">PLAYBACK SPEED</span>
                      <div className="speed-buttons">
                        {[0.5, 0.75, 1.0, 1.25, 1.5, 2.0].map((s) => (
                          <button
                            key={s}
                            className={`speed-pill ${audioPrefs.speed === s ? 'active' : ''}`}
                            onClick={() => setSpeed(s)}>
                            {s}x
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Subtitles Button */}
              <div className="popover-wrap">
                <button
                  className={`player-tool-btn ${showSubtitleMenu ? 'active' : ''}`}
                  onClick={() => { setShowSubtitleMenu((v) => !v); setShowAudioMenu(false); }}
                  title="Subtitles & Captions"
                  aria-label="Subtitles & Captions">
                  <Subtitles size={15} />
                  <span>CC</span>
                </button>

                {showSubtitleMenu && (
                  <div className="audio-menu-popover subtitle-popover" onMouseDown={(e) => e.stopPropagation()}>
                    <div className="popover-head">
                      <strong>Subtitles & Captions</strong>
                      <button className="icon-button close-pop" onClick={() => setShowSubtitleMenu(false)}><X size={15} /></button>
                    </div>
                    <div className="popover-section">
                      <div className="audio-track-list">
                        <button
                          className={`audio-option-btn ${!subtitles.some((s) => s.active) ? 'selected' : ''}`}
                          onClick={() => {
                            if (videoRef.current) {
                              for (let i = 0; i < videoRef.current.textTracks.length; i++) {
                                videoRef.current.textTracks[i]!.mode = 'disabled';
                              }
                            }
                            setSubtitles((prev) => prev.map((s) => ({ ...s, active: false })));
                          }}>
                          <span className="radio-circle">{!subtitles.some((s) => s.active) && <span className="inner-dot" />}</span>
                          <span>Off</span>
                        </button>
                        {subtitles.map((sub, idx) => (
                          <button
                            key={sub.id}
                            className={`audio-option-btn ${sub.active ? 'selected' : ''}`}
                            onClick={() => {
                              if (videoRef.current) {
                                for (let i = 0; i < videoRef.current.textTracks.length; i++) {
                                  videoRef.current.textTracks[i]!.mode = i === idx ? 'showing' : 'disabled';
                                }
                              }
                              setSubtitles((prev) => prev.map((s, i) => ({ ...s, active: i === idx })));
                            }}>
                            <span className="radio-circle">{sub.active && <span className="inner-dot" />}</span>
                            <span>{sub.label}</span>
                          </button>
                        ))}
                      </div>
                      <div className="upload-sub-row">
                        <input
                          ref={subInputRef}
                          type="file"
                          accept=".srt,.vtt"
                          style={{ display: 'none' }}
                          onChange={handleCustomSubtitleUpload}
                        />
                        <button
                          className="secondary-button upload-sub-btn"
                          onClick={() => subInputRef.current?.click()}>
                          Add Subtitle (.srt / .vtt)
                        </button>
                      </div>

                      {/* Subtitle Sync Offset */}
                      <div className="sub-sync-row" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '12px', paddingTop: '10px', borderTop: '1px solid rgba(255,255,255,0.1)', fontSize: '11px', color: '#c7d6cb' }}>
                        <span>Sync Offset</span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <button
                            className="player-tool-btn"
                            style={{ height: '24px', padding: '0 8px', fontSize: '10px' }}
                            onClick={() => setSubOffset((o) => o - 0.5)}>
                            -0.5s
                          </button>
                          <span style={{ fontFamily: 'monospace', minWidth: '32px', textAlign: 'center' }}>{subOffset > 0 ? `+${subOffset}` : subOffset}s</span>
                          <button
                            className="player-tool-btn"
                            style={{ height: '24px', padding: '0 8px', fontSize: '10px' }}
                            onClick={() => setSubOffset((o) => o + 0.5)}>
                            +0.5s
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Aspect Ratio Switcher */}
              <button
                className="player-tool-btn"
                onClick={() => setAspectRatio((r) => r === 'fit' ? '16-9' : r === '16-9' ? '21-9' : r === '21-9' ? 'fill' : 'fit')}
                title="Aspect Ratio (Fit / 16:9 / 21:9 Cinema Scope / Fill)"
                aria-label="Aspect Ratio">
                <span>{aspectRatio.toUpperCase()}</span>
              </button>

              {/* VLC Stream Link */}
              <button
                className="player-tool-btn"
                onClick={() => copyStreamUrl(video.id)}
                title="Copy stream link to open in VLC, IINA, or PotPlayer"
                aria-label="VLC Stream Link">
                <Share2 size={15} />
                <span>VLC Link</span>
              </button>

              {/* Picture in Picture */}
              <button className="player-tool-btn" onClick={togglePiP} title="Picture in Picture" aria-label="Picture in Picture">
                <PictureInPicture2 size={15} />
              </button>

              {/* Keyboard Shortcuts */}
              <button
                className="player-tool-btn"
                onClick={() => setShowHelp((h) => !h)}
                title="Keyboard Shortcuts (?)"
                aria-label="Shortcuts">
                <HelpCircle size={15} />
              </button>

              {/* Fullscreen */}
              <button className="player-tool-btn" onClick={toggleFullscreen} title="Fullscreen" aria-label="Fullscreen">
                {isFullscreen ? <Minimize size={15} /> : <Maximize size={15} />}
              </button>

              {/* Close */}
              <button className="close-video-btn" aria-label="Close video" autoFocus onClick={closeVideo} title="Close (Esc)">
                <X size={18} />
              </button>
            </div>
          </div>

          <div className="video-player-container">
            <video
              ref={videoRef}
              key={video.id}
              className={`aspect-${aspectRatio}`}
              poster={artwork(video)}
              controls
              autoPlay
              playsInline
              preload="metadata"
              crossOrigin="anonymous"
              src={`/api/media/${video.id}`}
              onLoadedMetadata={(event) => {
                inspectMediaTracks();
                const position = getPositions()[video.id];
                if (position && position < event.currentTarget.duration - 10) {
                  event.currentTarget.currentTime = position;
                }
              }}
              onTimeUpdate={(event) => {
                const now = Date.now();
                if (now - lastSavedAt.current > 5000) {
                  savePosition(video.id, event.currentTarget.currentTime);
                  lastSavedAt.current = now;
                }
              }}
              onEnded={() => {
                savePosition(video.id, null);
                setPositions(getPositions());
                if (hasNextEpisode) {
                  setAutoplayCountdown(5);
                }
              }}
              onError={() => {
                setPlaybackError('Stream reconnecting. Click below to reconnect or open directly in VLC / PotPlayer.');
              }}>
              <track
                kind="subtitles"
                src="/subtitles/inception.vtt"
                srcLang="en"
                label="English (Original)"
              />
              {customSubtitleUrl && (
                <track kind="subtitles" src={customSubtitleUrl} label="Custom Subtitles" default />
              )}
            </video>

            {/* In-Player Episode Drawer for Instant Season Episode Switching */}
            {showEpisodeDrawer && activeEpisode && activeSeasonEpisodes.length > 0 && (
              <div className="episode-drawer" onMouseDown={(e) => e.stopPropagation()}>
                <div className="drawer-header">
                  <div>
                    <strong>{activeEpisode.seriesName}</strong>
                    <span>Season {activeEpisode.seasonNumber} Episodes</span>
                  </div>
                  <button className="icon-button close-pop" onClick={() => setShowEpisodeDrawer(false)} aria-label="Close drawer">
                    <X size={16} />
                  </button>
                </div>
                <div className="drawer-episode-list">
                  {activeSeasonEpisodes.map((ep) => {
                    const isCurrent = ep.id === activeEpisode.id;
                    return (
                      <button
                        key={ep.id}
                        className={`drawer-episode-item ${isCurrent ? 'current' : ''}`}
                        onClick={() => {
                          if (currentSeries) playEpisode(ep, currentSeries);
                          setShowEpisodeDrawer(false);
                        }}>
                        <span className="drawer-ep-num">E{String(ep.episodeNumber).padStart(2, '0')}</span>
                        <div className="drawer-ep-info">
                          <strong>{ep.episodeTitle || ep.name}</strong>
                          <small>{ep.duration ? timeOf(ep.duration) : sizeOf(ep.size)}</small>
                        </div>
                        {isCurrent ? <span className="playing-pulse"><AudioLines size={14} /></span> : <Play size={14} />}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Autoplay Countdown Overlay When Episode Ends */}
            {autoplayCountdown !== null && nextEpisode && (
              <div className="autoplay-countdown-overlay" onMouseDown={(e) => e.stopPropagation()}>
                <div className="countdown-card">
                  <span className="countdown-kicker">UP NEXT IN {autoplayCountdown}s</span>
                  <h4>{nextEpisode.episodeTitle}</h4>
                  <p>{nextEpisode.seriesName} · Season {nextEpisode.seasonNumber} Episode {nextEpisode.episodeNumber}</p>
                  <div className="countdown-actions">
                    <button className="primary-button" onClick={() => { setAutoplayCountdown(null); playNextEpisode(); }}>
                      <Play size={16} fill="currentColor" /> Play Now
                    </button>
                    <button className="secondary-button" onClick={() => setAutoplayCountdown(null)}>
                      Cancel
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>

          {playbackError && (
            <div className="video-error-card" role="alert">
              <div className="video-error-content">
                <AlertTriangle size={24} className="error-icon" />
                <div>
                  <strong>Playback Reconnection</strong>
                  <p>
                    Stream encountered an interruption. Click Reconnect to resume or open directly in VLC / PotPlayer with one click.
                  </p>
                </div>
              </div>
              <div className="video-error-actions">
                <button className="primary-button" onClick={retryPlayback}>
                  <RefreshCw size={16} /> Reconnect Stream
                </button>
                <button className="secondary-button" onClick={() => copyStreamUrl(video.id)}>
                  <ExternalLink size={16} /> Open in VLC / PotPlayer
                </button>
                <a className="secondary-button" href={`/api/media/${video.id}?download=1`} download={video.name}>
                  <Download size={16} /> Download File ({sizeOf(video.size)})
                </a>
              </div>
            </div>
          )}

          <div className="modal-bottom">
            <div>
              <span>DIRECT CLOUD STREAMING · {video.parts && video.parts.length > 1 ? `${video.parts.length} TELEGRAM PARTS` : 'SINGLE CLOUD STREAM'}</span>
              <p>{video.description || 'Streaming directly from your private TeleDrive storage on Telegram.'}</p>
            </div>
            <div className="modal-bottom-actions">
              <button
                className="bottom-tool-btn"
                onClick={() => copyStreamUrl(video.id)}
                title="Copy stream URL for VLC / IINA / PotPlayer">
                <Share2 size={15} />
                <span>VLC Link</span>
              </button>
              <a
                className="bottom-tool-btn"
                href={`/api/media/${video.id}?download=1`}
                download={video.name}
                title="Download original file">
                <Download size={15} />
                <span>Download</span>
              </a>
              <button
                className={`bottom-tool-btn ${saved.includes(video.id) ? 'saved' : ''}`}
                onClick={() => toggleSaved(video.id)}
                title={saved.includes(video.id) ? 'Remove from My List' : 'Save to My List'}>
                {saved.includes(video.id) ? <Check size={15} /> : <Bookmark size={15} />}
                <span>{saved.includes(video.id) ? 'Saved' : 'Save'}</span>
              </button>
            </div>
          </div>
        </div>
      </div>}

      {showHelp && (
        <div className="modal-backdrop" role="presentation" onClick={() => setShowHelp(false)}>
          <div className="audio-menu-popover" style={{ width: 'min(440px, 92vw)', padding: '20px', borderRadius: '16px' }} onClick={(e) => e.stopPropagation()}>
            <div className="popover-head" style={{ marginBottom: '16px' }}>
              <strong style={{ fontSize: '15px' }}>Keyboard Shortcuts</strong>
              <button className="icon-button close-pop" onClick={() => setShowHelp(false)}><X size={16} /></button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', fontSize: '12px', color: '#c7d6cb' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 8px', background: 'rgba(255,255,255,0.05)', borderRadius: '6px' }}><span>Play / Pause</span><kbd style={{ fontFamily: 'monospace', background: 'rgba(255,255,255,0.1)', padding: '2px 6px', borderRadius: '4px', color: '#f5f6ed' }}>Space / K</kbd></div>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 8px', background: 'rgba(255,255,255,0.05)', borderRadius: '6px' }}><span>Seek -5s / +5s</span><kbd style={{ fontFamily: 'monospace', background: 'rgba(255,255,255,0.1)', padding: '2px 6px', borderRadius: '4px', color: '#f5f6ed' }}>← / →</kbd></div>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 8px', background: 'rgba(255,255,255,0.05)', borderRadius: '6px' }}><span>Skip -10s / +10s</span><kbd style={{ fontFamily: 'monospace', background: 'rgba(255,255,255,0.1)', padding: '2px 6px', borderRadius: '4px', color: '#f5f6ed' }}>J / L</kbd></div>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 8px', background: 'rgba(255,255,255,0.05)', borderRadius: '6px' }}><span>Volume</span><kbd style={{ fontFamily: 'monospace', background: 'rgba(255,255,255,0.1)', padding: '2px 6px', borderRadius: '4px', color: '#f5f6ed' }}>↑ / ↓</kbd></div>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 8px', background: 'rgba(255,255,255,0.05)', borderRadius: '6px' }}><span>Mute</span><kbd style={{ fontFamily: 'monospace', background: 'rgba(255,255,255,0.1)', padding: '2px 6px', borderRadius: '4px', color: '#f5f6ed' }}>M</kbd></div>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 8px', background: 'rgba(255,255,255,0.05)', borderRadius: '6px' }}><span>Fullscreen</span><kbd style={{ fontFamily: 'monospace', background: 'rgba(255,255,255,0.1)', padding: '2px 6px', borderRadius: '4px', color: '#f5f6ed' }}>F</kbd></div>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 8px', background: 'rgba(255,255,255,0.05)', borderRadius: '6px' }}><span>Picture in Picture</span><kbd style={{ fontFamily: 'monospace', background: 'rgba(255,255,255,0.1)', padding: '2px 6px', borderRadius: '4px', color: '#f5f6ed' }}>P</kbd></div>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 8px', background: 'rgba(255,255,255,0.05)', borderRadius: '6px' }}><span>Shortcuts Guide</span><kbd style={{ fontFamily: 'monospace', background: 'rgba(255,255,255,0.1)', padding: '2px 6px', borderRadius: '4px', color: '#f5f6ed' }}>?</kbd></div>
            </div>
          </div>
        </div>
      )}

      <div className="mobile-nav" aria-label="Mobile navigation">{nav.map(({ id, icon: Icon, label }) =>
        <button key={id} className={view === id ? 'current' : ''} onClick={() => setView(id)}><Icon size={20} /><span>{label}</span></button>)}</div>

      {toast && (
        <div className="toast-banner" role="status">
          <CheckCircle2 size={18} color="var(--accent)" />
          <span>{toast}</span>
        </div>
      )}
    </div>
  );
}
