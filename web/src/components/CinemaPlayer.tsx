import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  Play, Pause, RotateCcw, RotateCw, Volume2, VolumeX, Maximize, Minimize,
  PictureInPicture2, SlidersHorizontal, Subtitles, HelpCircle, X, Check,
  ExternalLink, Sparkles
} from 'lucide-react';
import type { FileDTO } from '../store';
import { useDialog } from '../store';
import { shiftVttTimings, isTypingTarget } from '../utils';

interface CinemaPlayerProps {
  file: FileDTO;
  contentUrl: string;
  poster?: string;
  allowDownload?: boolean;
  onClose?: () => void;
}

type AudioProfile = 'flat' | 'dialogue' | 'bass' | 'night' | 'boost150' | 'boost200';
type AspectRatio = 'fit' | '16-9' | '21-9' | 'fill';

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const s = Math.floor(seconds);
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  if (hrs > 0) {
    return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export function CinemaPlayer({ file, contentUrl, poster, allowDownload = true }: CinemaPlayerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const bassFilterRef = useRef<BiquadFilterNode | null>(null);
  const voiceFilterRef = useRef<BiquadFilterNode | null>(null);
  const compressorRef = useRef<DynamicsCompressorNode | null>(null);
  const subInputRef = useRef<HTMLInputElement>(null);

  const [isPlaying, setIsPlaying] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(file.duration ?? 0);
  const [bufferedEnd, setBufferedEnd] = useState(0);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showRemaining, setShowRemaining] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [hoverTime, setHoverTime] = useState<number | null>(null);
  const [hoverPos, setHoverPos] = useState<number>(0);

  // Advanced Menus
  const [showAudioMenu, setShowAudioMenu] = useState(false);
  const [showSubMenu, setShowSubMenu] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [audioProfile, setAudioProfile] = useState<AudioProfile>('flat');
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>('fit');
  const [subVtt, setSubVtt] = useState<string | null>(null);
  const [customSubUrl, setCustomSubUrl] = useState<string | null>(null);
  const [subOffset, setSubOffset] = useState(0);
  const [subtitlesEnabled, setSubtitlesEnabled] = useState(true);

  // Codec streaming state. Public shares use their own stream route, never
  // the authenticated /api/files endpoint.
  const isMkv = (file.name || '').toLowerCase().endsWith('.mkv') || file.mimeType === 'video/x-matroska';
  const fallbackStreamUrl = contentUrl.endsWith('/content')
    ? `${contentUrl.slice(0, -'/content'.length)}/stream`
    : contentUrl;
  const [streamUrl, setStreamUrl] = useState(() => (isMkv ? fallbackStreamUrl : contentUrl));
  const [hasCodecError, setHasCodecError] = useState(false);

  // Resume position storage key
  const resumeKey = `teledrive_pos_${file.id}`;
  const [showResumeBanner, setShowResumeBanner] = useState(() => {
    const saved = localStorage.getItem(resumeKey);
    return saved ? parseFloat(saved) > 10 : false;
  });

  // Reset player-local state when the preview navigates to another item.
  useEffect(() => {
    setStreamUrl(isMkv ? fallbackStreamUrl : contentUrl);
    setHasCodecError(false);
    setCurrentTime(0);
    setBufferedEnd(0);
    setSubVtt(null);
    setSubOffset(0);
    const saved = localStorage.getItem(resumeKey);
    setShowResumeBanner(saved ? parseFloat(saved) > 10 : false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.id, contentUrl]);

  const controlsTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const wakeControls = useCallback(() => {
    setControlsVisible(true);
    if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current);
    controlsTimeoutRef.current = setTimeout(() => {
      if (isPlaying) setControlsVisible(false);
    }, 2800);
  }, [isPlaying]);

  // Audio DSP Graph setup
  const initAudioGraph = useCallback(() => {
    if (audioCtxRef.current || !videoRef.current) return;
    try {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new AudioCtx();
      const source = ctx.createMediaElementSource(videoRef.current);

      const gain = ctx.createGain();
      const bass = ctx.createBiquadFilter();
      bass.type = 'lowshelf';
      bass.frequency.value = 220;

      const voice = ctx.createBiquadFilter();
      voice.type = 'peaking';
      voice.frequency.value = 2500;
      voice.Q.value = 1.0;

      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -24;
      comp.ratio.value = 6;

      source.connect(bass);
      bass.connect(voice);
      voice.connect(comp);
      comp.connect(gain);
      gain.connect(ctx.destination);

      audioCtxRef.current = ctx;
      gainNodeRef.current = gain;
      bassFilterRef.current = bass;
      voiceFilterRef.current = voice;
      compressorRef.current = comp;
    } catch {
      // AudioContext creation fails if crossOrigin or already connected
    }
  }, []);

  // Release the Web Audio graph when the player unmounts. Without this the
  // AudioContext and its media-element source stay alive for the whole tab.
  useEffect(() => () => {
    const ctx = audioCtxRef.current;
    audioCtxRef.current = null;
    gainNodeRef.current = null;
    bassFilterRef.current = null;
    voiceFilterRef.current = null;
    compressorRef.current = null;
    if (ctx && ctx.state !== 'closed') void ctx.close().catch(() => {});
    if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current);
  }, []);

  const applyAudioProfile = useCallback((profile: AudioProfile) => {
    initAudioGraph();
    setAudioProfile(profile);
    const gain = gainNodeRef.current;
    const bass = bassFilterRef.current;
    const voice = voiceFilterRef.current;
    const comp = compressorRef.current;
    if (!gain || !bass || !voice || !comp) return;

    // Reset defaults, including the compressor, so profiles never leak into
    // each other when the user switches back to Flat/Dialogue.
    bass.gain.value = 0;
    voice.gain.value = 0;
    gain.gain.value = 1;
    comp.threshold.value = -24;
    comp.ratio.value = 6;

    switch (profile) {
      case 'dialogue':
        voice.gain.value = 6.5;
        bass.gain.value = -3.0;
        break;
      case 'bass':
        bass.gain.value = 7.0;
        voice.gain.value = 1.0;
        break;
      case 'night':
        comp.threshold.value = -32;
        comp.ratio.value = 12;
        voice.gain.value = 4.0;
        bass.gain.value = -4.0;
        break;
      case 'boost150':
        gain.gain.value = 1.5;
        break;
      case 'boost200':
        gain.gain.value = 2.0;
        break;
      case 'flat':
      default:
        break;
    }
  }, [initAudioGraph]);

  const togglePlay = useCallback(() => {
    if (!videoRef.current) return;
    if (videoRef.current.paused) {
      videoRef.current.play().catch(() => {});
      setIsPlaying(true);
    } else {
      videoRef.current.pause();
      setIsPlaying(false);
    }
    wakeControls();
  }, [wakeControls]);

  const seekRelative = useCallback((deltaSeconds: number) => {
    if (!videoRef.current) return;
    const next = Math.max(0, Math.min(videoRef.current.duration || duration, videoRef.current.currentTime + deltaSeconds));
    videoRef.current.currentTime = next;
    setCurrentTime(next);
    wakeControls();
  }, [duration, wakeControls]);

  const toggleFullscreen = useCallback(() => {
    if (!containerRef.current) return;
    if (!document.fullscreenElement) {
      void containerRef.current.requestFullscreen().catch(() => {});
    } else {
      void document.exitFullscreen().catch(() => {});
    }
  }, []);

  const togglePiP = useCallback(async () => {
    if (!videoRef.current) return;
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else if (document.pictureInPictureEnabled) {
        await videoRef.current.requestPictureInPicture();
      }
    } catch {}
  }, []);

  // Keep fullscreen state in sync when the user exits with Esc / F11.
  useEffect(() => {
    const onChange = () => setIsFullscreen(document.fullscreenElement === containerRef.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  // Rebuild the subtitle track whenever the sync offset changes so the cues
  // themselves move (the <track> element has no offset API).
  useEffect(() => {
    if (!subVtt) {
      setCustomSubUrl(null);
      return;
    }
    const url = URL.createObjectURL(new Blob([shiftVttTimings(subVtt, subOffset)], { type: 'text/vtt' }));
    setCustomSubUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [subVtt, subOffset]);

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Dialogs and text editors own the keyboard.
      if (useDialog.getState().dialog) return;
      if (isTypingTarget(e.target)) return;

      switch (e.key) {
        case ' ':
        case 'k':
        case 'K':
          e.preventDefault();
          togglePlay();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          seekRelative(-5);
          break;
        case 'ArrowRight':
          e.preventDefault();
          seekRelative(5);
          break;
        case 'j':
        case 'J':
          e.preventDefault();
          seekRelative(-10);
          break;
        case 'l':
        case 'L':
          e.preventDefault();
          seekRelative(10);
          break;
        case 'ArrowUp':
          e.preventDefault();
          setVolume((v) => {
            const next = Math.min(1, v + 0.05);
            if (videoRef.current) videoRef.current.volume = next;
            return next;
          });
          wakeControls();
          break;
        case 'ArrowDown':
          e.preventDefault();
          setVolume((v) => {
            const next = Math.max(0, v - 0.05);
            if (videoRef.current) videoRef.current.volume = next;
            return next;
          });
          wakeControls();
          break;
        case 'm':
        case 'M':
          e.preventDefault();
          setIsMuted((m) => {
            const next = !m;
            if (videoRef.current) videoRef.current.muted = next;
            return next;
          });
          wakeControls();
          break;
        case 'f':
        case 'F':
          e.preventDefault();
          toggleFullscreen();
          break;
        case 'p':
        case 'P':
          e.preventDefault();
          void togglePiP();
          break;
        case '?':
          e.preventDefault();
          setShowHelp((h) => !h);
          break;
        default:
          if (e.key >= '0' && e.key <= '9') {
            const pct = parseInt(e.key, 10) / 10;
            if (videoRef.current && (videoRef.current.duration || duration)) {
              videoRef.current.currentTime = (videoRef.current.duration || duration) * pct;
            }
          }
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [togglePlay, seekRelative, toggleFullscreen, togglePiP, duration, wakeControls]);

  // Handle custom subtitle upload (.srt / .vtt)
  const handleSubtitleFile = (fileObj: File) => {
    const reader = new FileReader();
    reader.onload = (ev) => {
      let content = ev.target?.result as string;
      if (fileObj.name.toLowerCase().endsWith('.srt')) {
        // Simple client-side SRT to VTT converter
        content = 'WEBVTT\n\n' + content.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
      }
      setSubVtt(content);
      setSubOffset(0);
      setSubtitlesEnabled(true);
      setShowSubMenu(false);
    };
    reader.readAsText(fileObj);
  };

  const resumePlayback = () => {
    const saved = localStorage.getItem(resumeKey);
    if (saved && videoRef.current) {
      const pos = parseFloat(saved);
      videoRef.current.currentTime = pos;
      setCurrentTime(pos);
    }
    setShowResumeBanner(false);
  };

  return (
    <div
      ref={containerRef}
      className={`relative w-full h-full flex items-center justify-center bg-black overflow-hidden select-none group ${
        isFullscreen ? 'fixed inset-0 z-50' : ''
      }`}
      onMouseMove={wakeControls}
      onClick={wakeControls}
    >
      {/* Video Element */}
      <video
        ref={videoRef}
        src={streamUrl}
        poster={poster}
        autoPlay
        playsInline
        crossOrigin="anonymous"
        className={`w-full h-full transition-all duration-200 ${
          aspectRatio === 'fit' ? 'object-contain' :
          aspectRatio === '16-9' ? 'aspect-video object-cover' :
          aspectRatio === '21-9' ? 'aspect-[21/9] object-cover' :
          'object-fill'
        }`}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onTimeUpdate={(e) => {
          const t = e.currentTarget.currentTime;
          setCurrentTime(t);
          if (t > 5) localStorage.setItem(resumeKey, String(t));
          if (e.currentTarget.buffered.length > 0) {
            setBufferedEnd(e.currentTarget.buffered.end(e.currentTarget.buffered.length - 1));
          }
        }}
        onLoadedMetadata={(e) => {
          const d = e.currentTarget.duration;
          if (d && !Number.isNaN(d)) setDuration(d);
        }}
        onError={() => {
          // If direct native playback failed on an MKV or high-profile file, auto-fallback to transmux stream.
          if (streamUrl !== fallbackStreamUrl) {
            setStreamUrl(fallbackStreamUrl);
          } else {
            setHasCodecError(true);
          }
        }}
        onClick={togglePlay}
      >
        {customSubUrl && subtitlesEnabled && (
          <track
            kind="subtitles"
            src={customSubUrl}
            label="User Subtitle"
            default
          />
        )}
      </video>

      {/* Resume Banner */}
      {showResumeBanner && (
        <div className="absolute top-6 left-6 z-30 bg-black/85 backdrop-blur-md border border-white/20 rounded-xl px-4 py-3 flex items-center gap-3 text-white text-xs shadow-2xl animate-fade-in">
          <Sparkles size={16} className="text-yellow-300" />
          <span>Resume from {formatTime(parseFloat(localStorage.getItem(resumeKey) || '0'))}?</span>
          <button
            onClick={resumePlayback}
            className="px-2.5 py-1 bg-yellow-400 text-black font-semibold rounded-lg hover:bg-yellow-300 transition"
          >
            Resume
          </button>
          <button
            onClick={() => setShowResumeBanner(false)}
            className="text-white/60 hover:text-white"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {/* Codec Error Fallback Card */}
      {hasCodecError && (
        <div className="absolute inset-0 z-40 bg-black/90 flex items-center justify-center p-6">
          <div className="max-w-md bg-[#16211d] border border-red-500/30 rounded-2xl p-6 text-center space-y-4">
            <h3 className="text-lg font-semibold text-white">Browser Codec Decoding Limited</h3>
            <p className="text-xs text-white/70">
              This media is encoded in a proprietary codec not supported by browser hardware. You can stream it directly with full fidelity in external players:
            </p>
            <div className="flex justify-center gap-3">
              {allowDownload && (
                <a
                  href={`${contentUrl}${contentUrl.includes('?') ? '&' : '?'}download=1`}
                  download={file.name}
                  className="px-4 py-2 bg-white/10 hover:bg-white/20 text-white rounded-xl text-xs font-medium flex items-center gap-2"
                >
                  Download Original
                </a>
              )}
              <button
                onClick={() => {
                  const url = `${window.location.origin}${contentUrl}`;
                  void navigator.clipboard.writeText(url);
                  alert('Stream link copied! Open VLC -> Media -> Open Network Stream.');
                }}
                className="px-4 py-2 bg-emerald-500 hover:bg-emerald-400 text-black font-semibold rounded-xl text-xs flex items-center gap-2"
              >
                <ExternalLink size={14} /> Copy VLC Stream Link
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Floating Control Bar Overlay */}
      <div
        className={`absolute bottom-0 inset-x-0 p-5 bg-gradient-to-t from-black/90 via-black/50 to-transparent transition-opacity duration-300 ${
          controlsVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
      >
        {/* Scrubber Timeline */}
        <div
          className="relative w-full h-3 cursor-pointer flex items-center mb-3 group/bar"
          onMouseMove={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
            setHoverTime(pct * (duration || 1));
            setHoverPos(e.clientX - rect.left);
          }}
          onMouseLeave={() => setHoverTime(null)}
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
            const newTime = pct * (duration || 1);
            if (videoRef.current) videoRef.current.currentTime = newTime;
            setCurrentTime(newTime);
          }}
        >
          {/* Track background */}
          <div className="absolute inset-x-0 h-1.5 group-hover/bar:h-2.5 bg-white/20 rounded-full transition-all overflow-hidden">
            {/* Buffered bar */}
            <div
              className="absolute left-0 top-0 bottom-0 bg-white/30 rounded-full"
              style={{ width: `${Math.min(100, (bufferedEnd / (duration || 1)) * 100)}%` }}
            />
            {/* Progress bar */}
            <div
              className="absolute left-0 top-0 bottom-0 bg-gradient-to-r from-emerald-400 to-yellow-300 rounded-full"
              style={{ width: `${Math.min(100, (currentTime / (duration || 1)) * 100)}%` }}
            />
          </div>

          {/* Hover Time Bubble */}
          {hoverTime !== null && (
            <div
              className="absolute -top-8 -translate-x-1/2 px-2 py-0.5 bg-black/90 text-white text-[11px] font-mono rounded border border-white/20 pointer-events-none shadow-lg"
              style={{ left: hoverPos }}
            >
              {formatTime(hoverTime)}
            </div>
          )}
        </div>

        {/* Action Controls Row */}
        <div className="flex items-center justify-between text-white gap-4">
          <div className="flex items-center gap-3">
            <button
              onClick={togglePlay}
              className="w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center transition hover:scale-105"
              aria-label={isPlaying ? 'Pause' : 'Play'}
            >
              {isPlaying ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" className="ml-0.5" />}
            </button>

            <button
              onClick={() => seekRelative(-10)}
              className="p-2 text-white/80 hover:text-white hover:bg-white/10 rounded-lg transition"
              title="Skip -10s (J)"
            >
              <RotateCcw size={16} />
            </button>

            <button
              onClick={() => seekRelative(10)}
              className="p-2 text-white/80 hover:text-white hover:bg-white/10 rounded-lg transition"
              title="Skip +10s (L)"
            >
              <RotateCw size={16} />
            </button>

            {/* Volume Control */}
            <div className="flex items-center gap-2 group/vol">
              <button
                onClick={() => {
                  const next = !isMuted;
                  setIsMuted(next);
                  if (videoRef.current) videoRef.current.muted = next;
                }}
                className="p-2 text-white/80 hover:text-white rounded-lg"
                title="Mute (M)"
              >
                {isMuted || volume === 0 ? <VolumeX size={18} /> : <Volume2 size={18} />}
              </button>
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={isMuted ? 0 : volume}
                onChange={(e) => {
                  const v = parseFloat(e.target.value);
                  setVolume(v);
                  setIsMuted(false);
                  if (videoRef.current) {
                    videoRef.current.volume = v;
                    videoRef.current.muted = false;
                  }
                }}
                className="w-16 accent-emerald-400 h-1 rounded cursor-pointer"
              />
            </div>

            {/* Time Stamp */}
            <div
              onClick={() => setShowRemaining((r) => !r)}
              className="text-xs font-mono text-white/80 hover:text-white cursor-pointer select-none"
              title="Click to toggle remaining time"
            >
              <span>{formatTime(currentTime)}</span>
              <span className="text-white/40 mx-1">/</span>
              <span>{showRemaining ? `-${formatTime(Math.max(0, duration - currentTime))}` : formatTime(duration)}</span>
            </div>
          </div>

          {/* Right Action Icons */}
          <div className="flex items-center gap-2">
            {/* Audio Profile & DSP Button */}
            <div className="relative">
              <button
                onClick={() => { setShowAudioMenu((m) => !m); setShowSubMenu(false); }}
                className={`px-2.5 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition ${
                  showAudioMenu || audioProfile !== 'flat'
                    ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                    : 'bg-white/10 text-white/80 hover:bg-white/20'
                }`}
                title="Audio Equalizer & Voice Clarity"
              >
                <SlidersHorizontal size={14} />
                <span>{audioProfile.toUpperCase()}</span>
              </button>

              {showAudioMenu && (
                <div className="absolute bottom-12 right-0 w-64 bg-black/90 backdrop-blur-xl border border-white/20 rounded-2xl p-4 shadow-2xl text-xs space-y-3 z-50">
                  <div className="flex items-center justify-between font-semibold text-white/90 pb-2 border-b border-white/10">
                    <span>Voice & Equalizer Profiles</span>
                    <button onClick={() => setShowAudioMenu(false)}><X size={14} /></button>
                  </div>
                  <div className="space-y-1.5">
                    {[
                      { id: 'flat', label: 'Flat (Studio Original)', desc: 'Standard audio output' },
                      { id: 'dialogue', label: '✨ Clear Dialogue', desc: 'Boost vocal clarity' },
                      { id: 'bass', label: '🔊 Cinema Bass', desc: 'Deep bass punch' },
                      { id: 'night', label: '🌙 Night Mode', desc: 'Compress dynamic range' },
                      { id: 'boost150', label: '⚡ Loudness 150%', desc: 'Boost quiet laptops' },
                      { id: 'boost200', label: '🔥 Loudness 200%', desc: 'Max output gain' },
                    ].map((p) => (
                      <button
                        key={p.id}
                        onClick={() => applyAudioProfile(p.id as AudioProfile)}
                        className={`w-full text-left p-2 rounded-xl flex items-center justify-between transition ${
                          audioProfile === p.id ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30' : 'hover:bg-white/10 text-white/80'
                        }`}
                      >
                        <div>
                          <div className="font-medium text-white">{p.label}</div>
                          <div className="text-[10px] text-white/50">{p.desc}</div>
                        </div>
                        {audioProfile === p.id && <Check size={14} className="text-emerald-400" />}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Subtitles & Captions Menu */}
            <div className="relative">
              <button
                onClick={() => { setShowSubMenu((s) => !s); setShowAudioMenu(false); }}
                className={`p-2 rounded-lg transition ${
                  customSubUrl || showSubMenu ? 'bg-yellow-400/20 text-yellow-300 border border-yellow-400/30' : 'text-white/80 hover:bg-white/10'
                }`}
                title="Subtitles & Captions"
              >
                <Subtitles size={17} />
              </button>

              {showSubMenu && (
                <div className="absolute bottom-12 right-0 w-60 bg-black/90 backdrop-blur-xl border border-white/20 rounded-2xl p-4 shadow-2xl text-xs space-y-3 z-50">
                  <div className="flex items-center justify-between font-semibold text-white/90 pb-2 border-b border-white/10">
                    <span>Subtitles (CC)</span>
                    <button onClick={() => setShowSubMenu(false)}><X size={14} /></button>
                  </div>

                  <div className="space-y-2">
                    <button
                      onClick={() => setSubtitlesEnabled((e) => !e)}
                      className={`w-full p-2 rounded-xl flex items-center justify-between ${
                        subtitlesEnabled ? 'bg-emerald-500/20 text-emerald-300' : 'bg-white/5 text-white/50'
                      }`}
                    >
                      <span>Captions Enabled</span>
                      {subtitlesEnabled && <Check size={14} />}
                    </button>

                    <div className="pt-2 border-t border-white/10">
                      <input
                        ref={subInputRef}
                        type="file"
                        accept=".srt,.vtt"
                        className="hidden"
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) handleSubtitleFile(f);
                        }}
                      />
                      <button
                        onClick={() => subInputRef.current?.click()}
                        className="w-full py-2 px-3 bg-white/10 hover:bg-white/20 text-white rounded-xl text-center font-medium transition"
                      >
                        Upload Custom Subtitle (.srt / .vtt)
                      </button>
                    </div>

                    {/* Subtitle Sync Offset */}
                    <div className="flex items-center justify-between pt-2 border-t border-white/10 text-white/70">
                      <span>Sync Offset</span>
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => setSubOffset((o) => o - 0.5)}
                          className="px-2 py-0.5 bg-white/10 rounded hover:bg-white/20"
                        >
                          -0.5s
                        </button>
                        <span className="font-mono text-[10px] text-white">{subOffset > 0 ? `+${subOffset}` : subOffset}s</span>
                        <button
                          onClick={() => setSubOffset((o) => o + 0.5)}
                          className="px-2 py-0.5 bg-white/10 rounded hover:bg-white/20"
                        >
                          +0.5s
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Playback Speed */}
            <select
              value={speed}
              onChange={(e) => {
                const s = parseFloat(e.target.value);
                setSpeed(s);
                if (videoRef.current) videoRef.current.playbackRate = s;
              }}
              className="bg-white/10 hover:bg-white/20 text-white text-xs px-2 py-1.5 rounded-lg border-none outline-none cursor-pointer"
              title="Playback Speed"
            >
              {[0.5, 0.75, 1, 1.25, 1.5, 2].map((s) => (
                <option key={s} value={s} className="bg-[#14211d] text-white">{s}x</option>
              ))}
            </select>

            {/* Aspect Ratio Toggle */}
            <button
              onClick={() => {
                setAspectRatio((r) => (
                  r === 'fit' ? '16-9' : r === '16-9' ? '21-9' : r === '21-9' ? 'fill' : 'fit'
                ));
              }}
              className="p-2 text-white/80 hover:text-white hover:bg-white/10 rounded-lg text-xs font-mono"
              title="Cycle Aspect Ratio (Fit, 16:9, 21:9 Cinema Scope, Fill)"
            >
              {aspectRatio.toUpperCase()}
            </button>

            {/* Picture in Picture */}
            <button
              onClick={togglePiP}
              className="p-2 text-white/80 hover:text-white hover:bg-white/10 rounded-lg transition"
              title="Picture-in-Picture (P)"
            >
              <PictureInPicture2 size={17} />
            </button>

            {/* Keyboard Shortcuts Help */}
            <button
              onClick={() => setShowHelp((h) => !h)}
              className="p-2 text-white/80 hover:text-white hover:bg-white/10 rounded-lg transition"
              title="Keyboard Shortcuts (?)"
            >
              <HelpCircle size={17} />
            </button>

            {/* Fullscreen */}
            <button
              onClick={toggleFullscreen}
              className="p-2 text-white/80 hover:text-white hover:bg-white/10 rounded-lg transition"
              title="Fullscreen (F)"
            >
              {isFullscreen ? <Minimize size={18} /> : <Maximize size={18} />}
            </button>
          </div>
        </div>
      </div>

      {/* Keyboard Shortcuts Modal */}
      {showHelp && (
        <div className="absolute inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-6 animate-fade-in" onClick={() => setShowHelp(false)}>
          <div className="max-w-md w-full bg-[#15221e] border border-white/20 rounded-2xl p-6 text-white space-y-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between pb-3 border-b border-white/10">
              <h3 className="font-semibold text-base">Cinema Player Shortcuts</h3>
              <button onClick={() => setShowHelp(false)} className="text-white/60 hover:text-white"><X size={18} /></button>
            </div>
            <div className="grid grid-cols-2 gap-2.5 text-xs text-white/80">
              <div className="flex justify-between p-1.5 bg-white/5 rounded"><span>Play / Pause</span><kbd className="font-mono bg-white/10 px-1.5 rounded">Space / K</kbd></div>
              <div className="flex justify-between p-1.5 bg-white/5 rounded"><span>Seek -5s / +5s</span><kbd className="font-mono bg-white/10 px-1.5 rounded">← / →</kbd></div>
              <div className="flex justify-between p-1.5 bg-white/5 rounded"><span>Skip -10s / +10s</span><kbd className="font-mono bg-white/10 px-1.5 rounded">J / L</kbd></div>
              <div className="flex justify-between p-1.5 bg-white/5 rounded"><span>Volume Up / Down</span><kbd className="font-mono bg-white/10 px-1.5 rounded">↑ / ↓</kbd></div>
              <div className="flex justify-between p-1.5 bg-white/5 rounded"><span>Mute / Unmute</span><kbd className="font-mono bg-white/10 px-1.5 rounded">M</kbd></div>
              <div className="flex justify-between p-1.5 bg-white/5 rounded"><span>Fullscreen</span><kbd className="font-mono bg-white/10 px-1.5 rounded">F</kbd></div>
              <div className="flex justify-between p-1.5 bg-white/5 rounded"><span>Picture-in-Picture</span><kbd className="font-mono bg-white/10 px-1.5 rounded">P</kbd></div>
              <div className="flex justify-between p-1.5 bg-white/5 rounded"><span>Seek to 0%-90%</span><kbd className="font-mono bg-white/10 px-1.5 rounded">0 - 9</kbd></div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
