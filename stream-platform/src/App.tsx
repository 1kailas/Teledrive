import {
  Bookmark, Check, ChevronDown, ChevronRight, CircleAlert, Film, FolderOpen,
  Home, Music2, Play, Plus, RefreshCw, Search, Tv, X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { PlayerBar } from './components/PlayerBar';
import { SeriesHub } from './components/SeriesHub';
import { VideoTheatre } from './components/VideoTheatre';
import {
  AlbumCard, Artwork, EmptyState, LoadingView, MediaCard, SeriesCard, Shelf,
  TrackRow, tintStyle, useBodyLock,
} from './components/ui';
import {
  artistOf, artwork, formatOf, getPositions, getWatchlist,
  saveWatchlist, sizeOf, timeOf, titleOf,
  type EpisodeItem, type MediaItem, type SeriesItem,
} from './library';

type View = 'home' | 'films' | 'series' | 'music' | 'saved';
type FilmSort = 'recent' | 'title' | 'duration';

const NAV: Array<{ id: View; label: string; icon: typeof Home }> = [
  { id: 'home', label: 'Home', icon: Home },
  { id: 'films', label: 'Films', icon: Film },
  { id: 'series', label: 'Series', icon: Tv },
  { id: 'music', label: 'Music', icon: Music2 },
  { id: 'saved', label: 'My list', icon: Bookmark },
];

const PAGE_COPY: Record<Exclude<View, 'home'>, { title: string; body: string }> = {
  films: { title: 'Films', body: 'Everything in your private cinema.' },
  series: { title: 'Series', body: 'Episodic shows and documentaries.' },
  music: { title: 'Music', body: 'Albums, soundtracks and singles.' },
  saved: { title: 'My list', body: 'The films and tracks you want to come back to.' },
};

interface AlbumGroup {
  name: string;
  artist: string;
  count: number;
  cover: MediaItem;
  tracks: MediaItem[];
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function HeroBackdrop({ item, title }: { item: MediaItem; title: string }) {
  const [failed, setFailed] = useState(false);
  const src = artwork(item);

  useEffect(() => { setFailed(false); }, [src]);

  if (src && !failed) {
    return (
      <img
        className="hero-image"
        src={src}
        alt=""
        onError={() => setFailed(true)}
      />
    );
  }

  return (
    <div className="hero-fallback" style={tintStyle(item.id || title)} aria-hidden="true">
      <span className="hero-watermark">{title}</span>
    </div>
  );
}

function PageHeading({
  title, meta, children,
}: {
  title: string;
  meta?: string;
  children?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <h1>{title}</h1>
        {meta ? <p>{meta}</p> : null}
      </div>
      {children ? <div className="page-actions">{children}</div> : null}
    </div>
  );
}

export default function App() {
  const [view, setView] = useState<View>('home');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<MediaItem[]>([]);
  const [series, setSeries] = useState<SeriesItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [scrolled, setScrolled] = useState(false);

  const [saved, setSaved] = useState<string[]>(getWatchlist);
  const [positions, setPositions] = useState(getPositions);
  const [album, setAlbum] = useState('all');
  const [filmSort, setFilmSort] = useState<FilmSort>('recent');

  const [video, setVideo] = useState<MediaItem | null>(null);
  const [selectedSeries, setSelectedSeries] = useState<SeriesItem | null>(null);
  const [activeEpisode, setActiveEpisode] = useState<EpisodeItem | null>(null);

  const [track, setTrack] = useState<MediaItem | null>(null);
  const [playing, setPlaying] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [audioDuration, setAudioDuration] = useState(0);
  const [volume, setVolume] = useState(0.85);
  const [audioError, setAudioError] = useState('');
  const [toast, setToast] = useState<string | null>(null);

  const audioRef = useRef<HTMLAudioElement>(null);
  const queueRef = useRef<MediaItem[]>([]);
  const searchRef = useRef<HTMLInputElement>(null);
  const toastTimer = useRef<number | null>(null);

  useBodyLock(Boolean(video || selectedSeries));

  /* ---------------------------------------------------------------- */
  /*  Data                                                             */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    const timeout = window.setTimeout(() => setQuery(search.trim()), 280);
    return () => window.clearTimeout(timeout);
  }, [search]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    const type = query
      ? 'all'
      : view === 'films' || view === 'series'
        ? 'video'
        : view === 'music' ? 'audio' : 'all';

    fetch(`/api/catalog?${new URLSearchParams({ type, q: query })}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(response.status === 401
            ? 'Your viewing session expired. Sign in with Cloudflare Access to continue.'
            : 'The library could not be reached. Check your connection or hosted settings.');
        }
        return response.json() as Promise<{ items?: MediaItem[]; series?: SeriesItem[] }>;
      })
      .then((data) => {
        setItems(Array.isArray(data.items) ? data.items : []);
        if (Array.isArray(data.series)) setSeries(data.series);
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setError(reason instanceof Error ? reason.message : 'Could not load your library.');
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });

    return () => controller.abort();
  }, [query, view, refresh]);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable;
      if (event.key === '/' && !typing && !video && !selectedSeries) {
        event.preventDefault();
        searchRef.current?.focus();
      }
      if (event.key === 'Escape' && document.activeElement === searchRef.current) {
        setSearch('');
        setQuery('');
        searchRef.current?.blur();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [video, selectedSeries]);

  useEffect(() => () => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
  }, []);

  /* ---------------------------------------------------------------- */
  /*  Library helpers                                                  */
  /* ---------------------------------------------------------------- */

  const videos = useMemo(() => items.filter((item) => item.category === 'video'), [items]);
  const songs = useMemo(() => items.filter((item) => item.category === 'audio'), [items]);
  const isSearching = query.length > 0;

  const albums = useMemo<AlbumGroup[]>(() => {
    const groups = new Map<string, MediaItem[]>();
    for (const song of songs) {
      const name = song.album || 'Singles';
      const list = groups.get(name);
      if (list) list.push(song);
      else groups.set(name, [song]);
    }
    return Array.from(groups.entries())
      .map(([name, tracks]) => ({
        name,
        artist: artistOf(tracks[0]!),
        count: tracks.length,
        cover: tracks.find((entry) => entry.hasThumbnail) ?? tracks[0]!,
        tracks,
      }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  }, [songs]);

  const continueWatching = useMemo(() => videos.filter((item) => {
    const position = positions[item.id] ?? 0;
    return position > 5 && item.duration !== null && position < item.duration - 10;
  }), [videos, positions]);

  const visibleVideos = useMemo(() => {
    if (isSearching) return videos;
    if (view === 'saved') return videos.filter((item) => saved.includes(item.id));
    return videos;
  }, [isSearching, videos, view, saved]);

  const visibleSongs = useMemo(() => {
    let list = songs;
    if (!isSearching && view === 'saved') list = list.filter((item) => saved.includes(item.id));
    if (view === 'music' && album !== 'all') {
      list = list.filter((item) => (item.album || 'Singles') === album);
    }
    return list;
  }, [songs, view, saved, album, isSearching]);

  const sortedVideos = useMemo(() => {
    const list = [...visibleVideos];
    if (filmSort === 'title') {
      list.sort((a, b) => titleOf(a).localeCompare(titleOf(b), undefined, { sensitivity: 'base' }));
    } else if (filmSort === 'duration') {
      list.sort((a, b) => (b.duration ?? 0) - (a.duration ?? 0));
    } else {
      list.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    }
    return list;
  }, [visibleVideos, filmSort]);

  const hero = continueWatching[0] ?? videos[0] ?? null;
  const featuredSeries = !hero && series.length > 0 ? series[0]! : null;
  const featuredEpisode = featuredSeries?.seasons[0]?.episodes[0] ?? null;
  const heroItem = hero ?? featuredEpisode;
  const heroTitle = hero ? titleOf(hero) : featuredSeries?.name ?? '';
  const heroPosition = hero ? positions[hero.id] ?? 0 : 0;
  const heroProgress = hero?.duration && heroPosition > 5
    ? Math.min(heroPosition / hero.duration, 1)
    : 0;
  const heroContinue = heroProgress > 0;

  const currentSeries = useMemo(() => {
    if (!activeEpisode) return selectedSeries;
    return series.find((entry) => entry.id === activeEpisode.seriesId)
      ?? (selectedSeries?.id === activeEpisode.seriesId ? selectedSeries : null);
  }, [activeEpisode, series, selectedSeries]);

  const seasonEpisodes = useMemo(() => {
    if (!currentSeries || !activeEpisode) return [];
    const season = currentSeries.seasons.find((entry) => entry.seasonNumber === activeEpisode.seasonNumber)
      ?? currentSeries.seasons[0];
    return season?.episodes ?? [];
  }, [currentSeries, activeEpisode]);

  const episodeIndex = activeEpisode
    ? seasonEpisodes.findIndex((entry) => entry.id === activeEpisode.id)
    : -1;
  const previousEpisode = episodeIndex > 0 ? seasonEpisodes[episodeIndex - 1] ?? null : null;
  const nextEpisode = episodeIndex >= 0 && episodeIndex < seasonEpisodes.length - 1
    ? seasonEpisodes[episodeIndex + 1] ?? null
    : null;

  const totalResults = visibleVideos.length + visibleSongs.length
    + (isSearching ? series.length : 0);

  /* ---------------------------------------------------------------- */
  /*  Actions                                                          */
  /* ---------------------------------------------------------------- */

  function notify(message: string) {
    setToast(message);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 4200);
  }

  function go(nextView: View) {
    setView(nextView);
    setSearch('');
    setQuery('');
    window.scrollTo({ top: 0 });
  }

  function toggleSaved(id: string) {
    setSaved((current) => {
      const next = current.includes(id)
        ? current.filter((entry) => entry !== id)
        : [id, ...current];
      saveWatchlist(next);
      return next;
    });
  }

  function playVideo(item: MediaItem) {
    audioRef.current?.pause();
    setPlaying(false);
    setSelectedSeries(null);
    setActiveEpisode(null);
    setVideo(item);
  }

  function playEpisode(episode: EpisodeItem, owningSeries: SeriesItem) {
    audioRef.current?.pause();
    setPlaying(false);
    setSelectedSeries(owningSeries);
    setActiveEpisode(episode);
    setVideo(episode);
  }

  function closeVideo() {
    setVideo(null);
    setActiveEpisode(null);
    setPositions(getPositions());
  }

  function closeSeries() {
    setSelectedSeries(null);
    setActiveEpisode(null);
  }

  function playNextEpisode() {
    if (nextEpisode && currentSeries) playEpisode(nextEpisode, currentSeries);
  }

  function playPreviousEpisode() {
    if (previousEpisode && currentSeries) playEpisode(previousEpisode, currentSeries);
  }

  function playSeries(seriesItem: SeriesItem) {
    const first = seriesItem.seasons[0]?.episodes[0];
    if (first) playEpisode(first, seriesItem);
  }

  function playFeatured() {
    if (hero) {
      playVideo(hero);
      return;
    }
    if (featuredSeries) playSeries(featuredSeries);
  }

  function playSong(item: MediaItem) {
    if (track?.id === item.id) {
      const audio = audioRef.current;
      if (!audio) return;
      if (audio.paused) void audio.play().catch(() => setPlaying(false));
      else audio.pause();
      return;
    }

    if (video) closeVideo();
    if (selectedSeries) closeSeries();
    setAudioError('');
    const queue = visibleSongs.length > 0 ? visibleSongs : songs.length > 0 ? songs : [item];
    queueRef.current = queue;
    setTrack(item);
  }

  function handleTrackEnd() {
    if (queueRef.current.length > 1) {
      skipTrack(1);
    } else {
      const audio = audioRef.current;
      if (audio) {
        audio.currentTime = 0;
        void audio.play().catch(() => setPlaying(false));
      }
    }
  }

  function skipTrack(direction: number) {
    const queue = queueRef.current.length > 0 ? queueRef.current : track ? [track] : [];
    if (!queue.length || !track) return;
    const index = queue.findIndex((entry) => entry.id === track.id);
    const next = queue[(index + direction + queue.length) % queue.length] ?? track;
    setTrack(next);
  }

  function toggleAudio() {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) void audio.play().catch(() => setPlaying(false));
    else audio.pause();
  }

  function playAll() {
    const queue = visibleSongs.length > 0 ? visibleSongs : songs;
    if (!queue.length) return;
    queueRef.current = queue;
    const first = queue[0]!;
    if (track?.id === first.id) {
      const audio = audioRef.current;
      if (audio) {
        audio.currentTime = 0;
        void audio.play().catch(() => setPlaying(false));
      }
    } else {
      setTrack(first);
    }
  }

  function openAlbum(name: string) {
    setAlbum(name);
    go('music');
  }

  function copyStreamUrl(id: string) {
    const fullUrl = `${window.location.origin}/api/media/${id}`;
    if (navigator.clipboard) {
      void navigator.clipboard.writeText(fullUrl)
        .then(() => notify('Stream link copied. Open it in VLC, IINA or MPV.'))
        .catch(() => { window.prompt('Copy stream URL for VLC / IINA / PotPlayer:', fullUrl); });
    } else {
      window.prompt('Copy stream URL for VLC / IINA / PotPlayer:', fullUrl);
    }
  }

  function clearSearch() {
    setSearch('');
    setQuery('');
    searchRef.current?.focus();
  }

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !track) return;
    setElapsed(0);
    setAudioDuration(track.duration ?? 0);
    setAudioError('');
    audio.load();
    audio.volume = volume;
    void audio.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
  }, [track?.id]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
  }, [volume]);

  /* ---------------------------------------------------------------- */
  /*  Page state                                                       */
  /* ---------------------------------------------------------------- */

  const isHome = view === 'home' && !isSearching;
  const showHero = isHome && Boolean(heroItem);
  const hasLibrary = videos.length > 0 || series.length > 0 || songs.length > 0;
  const headerSolid = scrolled || view !== 'home' || isSearching || loading || Boolean(error) || !showHero;

  const continueRow = continueWatching.filter((item) => item.id !== hero?.id);
  const musicMeta = [
    plural(songs.length, 'track'),
    plural(albums.length, 'album'),
  ].join(' · ');

  /* ---------------------------------------------------------------- */
  /*  Render                                                           */
  /* ---------------------------------------------------------------- */

  return (
    <div className={`app ${track ? 'has-player' : ''}`}>
      <a className="skip-link" href="#main">Skip to content</a>

      <header className={`site-header ${headerSolid ? 'is-solid' : ''}`}>
        <div className="header-inner">
          <button type="button" className="brand" onClick={() => go('home')} aria-label="Folio home">
            folio<span>.</span>
          </button>

          <nav className="primary-nav" aria-label="Primary navigation">
            {NAV.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                className={view === id ? 'is-active' : ''}
                onClick={() => go(id)}
                aria-current={view === id ? 'page' : undefined}
              >
                {label}
                {id === 'saved' && saved.length > 0 ? <span className="nav-count">{saved.length}</span> : null}
              </button>
            ))}
          </nav>

          <div className="header-actions">
            <div className="search-field">
              <Search size={16} aria-hidden="true" />
              <input
                ref={searchRef}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search"
                aria-label="Search films, series, artists and tracks"
                maxLength={120}
              />
              {search ? (
                <button type="button" className="search-clear" onClick={clearSearch} aria-label="Clear search">
                  <X size={14} />
                </button>
              ) : <kbd>/</kbd>}
            </div>
            <button
              type="button"
              className={`icon-button refresh-button ${loading ? 'is-spinning' : ''}`}
              onClick={() => setRefresh((current) => current + 1)}
              title="Refresh library"
              aria-label="Refresh library"
            >
              <RefreshCw size={17} />
            </button>
          </div>
        </div>
      </header>

      <main
        id="main"
        className={`main ${isHome ? 'main-home' : ''} ${showHero ? 'has-hero' : ''}`}
      >
        {error ? (
          <div className="content">
            <div className="state-page">
              <span className="state-icon"><CircleAlert size={26} /></span>
              <h1>Library unavailable</h1>
              <p>{error}</p>
              <div className="state-actions">
                <button type="button" className="button button-primary" onClick={() => setRefresh((current) => current + 1)}>
                  <RefreshCw size={15} />
                  Try again
                </button>
                {error.includes('session') ? (
                  <a className="button button-secondary" href="/cdn-cgi/access/login">Sign in again</a>
                ) : null}
              </div>
            </div>
          </div>
        ) : loading ? (
          <div className="content">
            <LoadingView home={isHome} />
          </div>
        ) : isSearching ? (
          <div className="content">
            <PageHeading
              title={`Results for “${query}”`}
              meta={`${plural(totalResults, 'result')} across films, series and music`}
            >
              <button type="button" className="button button-secondary" onClick={clearSearch}>
                <X size={15} />
                Clear search
              </button>
            </PageHeading>

            {totalResults === 0 ? (
              <EmptyState
                icon={<Search size={22} />}
                title="No matches yet"
                body={`Nothing in your library matches “${query}”. Try a different title, artist, album or format.`}
                action={(
                  <button type="button" className="button button-secondary" onClick={clearSearch}>
                    Clear search
                  </button>
                )}
              />
            ) : (
              <>
                {(series.length > 0 || visibleVideos.length > 0) ? (
                  <section className="result-section" aria-label="Films and series results">
                    <div className="section-heading">
                      <h2>Films & series</h2>
                      <span>{plural(series.length + visibleVideos.length, 'title')}</span>
                    </div>
                    <div className="media-grid">
                      {series.map((entry) => (
                        <SeriesCard
                          key={entry.id}
                          series={entry}
                          onOpen={() => {
                            setSelectedSeries(entry);
                            setActiveEpisode(null);
                          }}
                        />
                      ))}
                      {sortedVideos.map((item) => (
                        <MediaCard
                          key={item.id}
                          item={item}
                          position={positions[item.id] ?? 0}
                          saved={saved.includes(item.id)}
                          onPlay={() => playVideo(item)}
                          onSave={() => toggleSaved(item.id)}
                        />
                      ))}
                    </div>
                  </section>
                ) : null}

                {visibleSongs.length > 0 ? (
                  <section className="result-section" aria-label="Music results">
                    <div className="section-heading">
                      <h2>Music</h2>
                      <span>{plural(visibleSongs.length, 'track')}</span>
                    </div>
                    <div className="track-list">
                      <div className="track-head" aria-hidden="true">
                        <span>#</span>
                        <span>Title</span>
                        <span>Album</span>
                        <span>Format</span>
                        <span />
                        <span>Time</span>
                      </div>
                      {visibleSongs.map((item, index) => (
                        <TrackRow
                          key={item.id}
                          item={item}
                          index={index}
                          selected={track?.id === item.id}
                          playing={track?.id === item.id && playing}
                          saved={saved.includes(item.id)}
                          onPlay={() => playSong(item)}
                          onSave={() => toggleSaved(item.id)}
                        />
                      ))}
                    </div>
                  </section>
                ) : null}
              </>
            )}
          </div>
        ) : isHome ? (
          <>
            {showHero && heroItem ? (
              <section className="hero" aria-label="Featured selection">
                <HeroBackdrop item={heroItem} title={heroTitle} />
                <div className="hero-scrim" aria-hidden="true" />
                <div className="hero-content">
                  <span className="eyebrow">
                    <span className="eyebrow-dot" />
                    {featuredSeries && !hero ? 'Featured series' : heroContinue ? 'Continue watching' : 'Featured film'}
                  </span>
                  <h1>{heroTitle}</h1>
                  <div className="hero-meta">
                    {hero ? (
                      <>
                        <span>{formatOf(hero)}</span>
                        {hero.duration ? <span>{timeOf(hero.duration)}</span> : null}
                        <span>{sizeOf(hero.size)}</span>
                        {hero.parts && hero.parts.length > 1 ? <span>{hero.parts.length} parts</span> : null}
                      </>
                    ) : featuredSeries ? (
                      <>
                        <span>{plural(featuredSeries.seasonsCount, 'season')}</span>
                        <span>{plural(featuredSeries.episodesCount, 'episode')}</span>
                      </>
                    ) : null}
                  </div>
                  <p className="hero-description">
                    {hero?.description
                      || featuredSeries?.description
                      || 'From your private collection, streamed directly from TeleDrive.'}
                  </p>
                  <div className="hero-actions">
                    <button type="button" className="button button-primary" onClick={playFeatured}>
                      <Play size={17} fill="currentColor" />
                      {heroContinue
                        ? 'Resume'
                        : featuredSeries && !hero ? `Play S${featuredEpisode?.seasonNumber ?? 1} E${featuredEpisode?.episodeNumber ?? 1}` : 'Play film'}
                    </button>
                    {hero ? (
                      <button
                        type="button"
                        className={`button button-secondary ${saved.includes(hero.id) ? 'is-saved' : ''}`}
                        onClick={() => toggleSaved(hero.id)}
                      >
                        {saved.includes(hero.id) ? <Check size={16} /> : <Plus size={16} />}
                        {saved.includes(hero.id) ? 'In My list' : 'Add to My list'}
                      </button>
                    ) : featuredSeries ? (
                      <button
                        type="button"
                        className="button button-secondary"
                        onClick={() => { setSelectedSeries(featuredSeries); setActiveEpisode(null); }}
                      >
                        <Tv size={16} />
                        View series
                      </button>
                    ) : null}
                  </div>
                  {heroContinue && hero?.duration ? (
                    <div className="hero-progress">
                      <div className="hero-progress-track">
                        <span style={{ width: `${heroProgress * 100}%` }} />
                      </div>
                      <span>{Math.round(heroProgress * 100)}% watched · {timeOf(hero.duration - heroPosition)} left</span>
                    </div>
                  ) : null}
                </div>
              </section>
            ) : !hasLibrary ? (
              <div className="content">
                <EmptyState
                  icon={<FolderOpen size={22} />}
                  title="Your library is empty"
                  body="Add films, series folders and music to the stream folder in TeleDrive. They will appear here automatically."
                  action={(
                    <button type="button" className="button button-secondary" onClick={() => setRefresh((current) => current + 1)}>
                      <RefreshCw size={15} />
                      Refresh library
                    </button>
                  )}
                />
              </div>
            ) : (
              <div className="content">
                <div className="welcome">
                  <span className="eyebrow"><span className="eyebrow-dot" />Your library</span>
                  <h1>Your library</h1>
                  <p>Films, series and music, streamed directly from TeleDrive.</p>
                </div>
              </div>
            )}

            <div className="content home-content">
              {continueRow.length > 0 ? (
                <Shelf title="Continue watching" meta="Pick up where you left off">
                  {continueRow.map((item) => (
                    <MediaCard
                      key={item.id}
                      item={item}
                      position={positions[item.id] ?? 0}
                      saved={saved.includes(item.id)}
                      onPlay={() => playVideo(item)}
                      onSave={() => toggleSaved(item.id)}
                    />
                  ))}
                </Shelf>
              ) : null}

              {videos.length > 0 ? (
                <Shelf
                  title="Films"
                  meta={plural(videos.length, 'film')}
                  action={(
                    <button type="button" className="link-action" onClick={() => go('films')}>
                      See all <ChevronRight size={15} />
                    </button>
                  )}
                >
                  {videos.slice(0, 10).map((item) => (
                    <MediaCard
                      key={item.id}
                      item={item}
                      position={positions[item.id] ?? 0}
                      saved={saved.includes(item.id)}
                      onPlay={() => playVideo(item)}
                      onSave={() => toggleSaved(item.id)}
                    />
                  ))}
                </Shelf>
              ) : null}

              {series.length > 0 ? (
                <Shelf
                  title="Series"
                  meta={plural(series.length, 'series')}
                  action={(
                    <button type="button" className="link-action" onClick={() => go('series')}>
                      See all <ChevronRight size={15} />
                    </button>
                  )}
                >
                  {series.slice(0, 10).map((entry) => (
                    <SeriesCard
                      key={entry.id}
                      series={entry}
                      onOpen={() => { setSelectedSeries(entry); setActiveEpisode(null); }}
                    />
                  ))}
                </Shelf>
              ) : null}

              {albums.length > 0 ? (
                <Shelf
                  title="Music"
                  meta={musicMeta}
                  size="album"
                  action={(
                    <button type="button" className="link-action" onClick={() => go('music')}>
                      See all <ChevronRight size={15} />
                    </button>
                  )}
                >
                  {albums.slice(0, 10).map((group) => (
                    <AlbumCard
                      key={group.name}
                      name={group.name}
                      artist={group.artist}
                      count={group.count}
                      item={group.cover}
                      onOpen={() => openAlbum(group.name)}
                    />
                  ))}
                </Shelf>
              ) : null}
            </div>
          </>
        ) : (
          <div className="content">
            {view === 'films' ? (
              <>
                <PageHeading
                  title={PAGE_COPY.films.title}
                  meta={`${plural(visibleVideos.length, 'film')} · ${PAGE_COPY.films.body}`}
                >
                  <label className="sort-control">
                    <span>Sort</span>
                    <select value={filmSort} onChange={(event) => setFilmSort(event.target.value as FilmSort)} aria-label="Sort films">
                      <option value="recent">Recently added</option>
                      <option value="title">Title A–Z</option>
                      <option value="duration">Longest first</option>
                    </select>
                    <ChevronDown size={14} aria-hidden="true" />
                  </label>
                </PageHeading>

                {sortedVideos.length === 0 ? (
                  <EmptyState
                    icon={<Film size={22} />}
                    title="No films yet"
                    body="Add video files to the stream folder in TeleDrive. MP4, MKV, WebM and MOV are supported."
                    action={(
                      <button type="button" className="button button-secondary" onClick={() => setRefresh((current) => current + 1)}>
                        <RefreshCw size={15} />
                        Refresh library
                      </button>
                    )}
                  />
                ) : (
                  <div className="media-grid">
                    {sortedVideos.map((item) => (
                      <MediaCard
                        key={item.id}
                        item={item}
                        position={positions[item.id] ?? 0}
                        saved={saved.includes(item.id)}
                        onPlay={() => playVideo(item)}
                        onSave={() => toggleSaved(item.id)}
                      />
                    ))}
                  </div>
                )}
              </>
            ) : null}

            {view === 'series' ? (
              <>
                <PageHeading
                  title={PAGE_COPY.series.title}
                  meta={`${plural(series.length, 'series')} · ${PAGE_COPY.series.body}`}
                />
                {series.length === 0 ? (
                  <EmptyState
                    icon={<Tv size={22} />}
                    title="No series yet"
                    body="Create a folder for each show inside the stream folder in TeleDrive. Season folders and episode numbers are detected automatically."
                    action={(
                      <button type="button" className="button button-secondary" onClick={() => setRefresh((current) => current + 1)}>
                        <RefreshCw size={15} />
                        Refresh library
                      </button>
                    )}
                  />
                ) : (
                  <div className="media-grid">
                    {series.map((entry) => (
                      <SeriesCard
                        key={entry.id}
                        series={entry}
                        onOpen={() => { setSelectedSeries(entry); setActiveEpisode(null); }}
                      />
                    ))}
                  </div>
                )}
              </>
            ) : null}

            {view === 'music' ? (
              <>
                <PageHeading title={PAGE_COPY.music.title} meta={musicMeta}>
                  {songs.length > 0 ? (
                    <button type="button" className="button button-primary" onClick={playAll} disabled={visibleSongs.length === 0}>
                      <Play size={16} fill="currentColor" />
                      Play all
                    </button>
                  ) : null}
                </PageHeading>

                {songs.length === 0 ? (
                  <EmptyState
                    icon={<Music2 size={22} />}
                    title="No music yet"
                    body="Add audio files to TeleDrive to build your listening room. MP3, FLAC, WAV, M4A and OGG are supported."
                    action={(
                      <button type="button" className="button button-secondary" onClick={() => setRefresh((current) => current + 1)}>
                        <RefreshCw size={15} />
                        Refresh library
                      </button>
                    )}
                  />
                ) : (
                  <>
                    <div className="chip-row" aria-label="Filter by album">
                      <button
                        type="button"
                        className={album === 'all' ? 'is-active' : ''}
                        onClick={() => setAlbum('all')}
                      >
                        All music
                        <span>{songs.length}</span>
                      </button>
                      {albums.map((group) => (
                        <button
                          key={group.name}
                          type="button"
                          className={album === group.name ? 'is-active' : ''}
                          onClick={() => setAlbum(group.name)}
                        >
                          {group.name}
                          <span>{group.count}</span>
                        </button>
                      ))}
                    </div>

                    {visibleSongs.length === 0 ? (
                      <EmptyState
                        icon={<Music2 size={22} />}
                        title="Nothing in this album"
                        body="There are no tracks in this album for the current view."
                        action={(
                          <button type="button" className="button button-secondary" onClick={() => setAlbum('all')}>
                            Show all music
                          </button>
                        )}
                      />
                    ) : (
                      <div className="track-list">
                        <div className="track-head" aria-hidden="true">
                          <span>#</span>
                          <span>Title</span>
                          <span>Album</span>
                          <span>Format</span>
                          <span />
                          <span>Time</span>
                        </div>
                        {visibleSongs.map((item, index) => (
                          <TrackRow
                            key={item.id}
                            item={item}
                            index={index}
                            selected={track?.id === item.id}
                            playing={track?.id === item.id && playing}
                            saved={saved.includes(item.id)}
                            onPlay={() => playSong(item)}
                            onSave={() => toggleSaved(item.id)}
                          />
                        ))}
                      </div>
                    )}
                  </>
                )}
              </>
            ) : null}

            {view === 'saved' ? (
              <>
                <PageHeading
                  title={PAGE_COPY.saved.title}
                  meta={`${plural(visibleVideos.length + visibleSongs.length, 'title')} · ${PAGE_COPY.saved.body}`}
                />
                {visibleVideos.length === 0 && visibleSongs.length === 0 ? (
                  <EmptyState
                    icon={<Bookmark size={22} />}
                    title="Nothing saved yet"
                    body="Save films and tracks with the + button and they will be waiting for you here."
                    action={(
                      <button type="button" className="button button-secondary" onClick={() => go('films')}>
                        Browse films
                      </button>
                    )}
                  />
                ) : (
                  <>
                    {visibleVideos.length > 0 ? (
                      <section className="result-section" aria-label="Saved films">
                        <div className="section-heading">
                          <h2>Films</h2>
                          <span>{plural(visibleVideos.length, 'film')}</span>
                        </div>
                        <div className="media-grid">
                          {sortedVideos.map((item) => (
                            <MediaCard
                              key={item.id}
                              item={item}
                              position={positions[item.id] ?? 0}
                              saved
                              onPlay={() => playVideo(item)}
                              onSave={() => toggleSaved(item.id)}
                            />
                          ))}
                        </div>
                      </section>
                    ) : null}

                    {visibleSongs.length > 0 ? (
                      <section className="result-section" aria-label="Saved music">
                        <div className="section-heading">
                          <h2>Music</h2>
                          <span>{plural(visibleSongs.length, 'track')}</span>
                        </div>
                        <div className="track-list">
                          <div className="track-head" aria-hidden="true">
                            <span>#</span>
                            <span>Title</span>
                            <span>Album</span>
                            <span>Format</span>
                            <span />
                            <span>Time</span>
                          </div>
                          {visibleSongs.map((item, index) => (
                            <TrackRow
                              key={item.id}
                              item={item}
                              index={index}
                              selected={track?.id === item.id}
                              playing={track?.id === item.id && playing}
                              saved
                              onPlay={() => playSong(item)}
                              onSave={() => toggleSaved(item.id)}
                            />
                          ))}
                        </div>
                      </section>
                    ) : null}
                  </>
                )}
              </>
            ) : null}
          </div>
        )}
      </main>

      <audio
        ref={audioRef}
        src={track ? `/api/media/${track.id}` : undefined}
        preload="metadata"
        onPlay={() => { setPlaying(true); setAudioError(''); }}
        onPause={() => setPlaying(false)}
        onLoadedMetadata={(event) => {
          const duration = event.currentTarget.duration;
          setAudioDuration(Number.isFinite(duration) ? duration : track?.duration ?? 0);
        }}
        onError={() => {
          if (track) setAudioError('This track is unavailable.');
          setPlaying(false);
        }}
        onTimeUpdate={(event) => setElapsed(event.currentTarget.currentTime)}
        onEnded={handleTrackEnd}
      />

      {track ? (
        <PlayerBar
          track={track}
          playing={playing}
          elapsed={elapsed}
          duration={audioDuration || track.duration || 0}
          volume={volume}
          saved={saved.includes(track.id)}
          error={audioError}
          onToggle={toggleAudio}
          onPrevious={() => skipTrack(-1)}
          onNext={() => skipTrack(1)}
          onSeek={(seconds) => {
            if (audioRef.current) audioRef.current.currentTime = seconds;
          }}
          onVolume={setVolume}
          onSave={() => toggleSaved(track.id)}
        />
      ) : null}

      <nav className="mobile-nav" aria-label="Mobile navigation">
        {NAV.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            className={view === id ? 'is-active' : ''}
            onClick={() => go(id)}
            aria-current={view === id ? 'page' : undefined}
          >
            <Icon size={20} strokeWidth={1.8} />
            <span>{label}</span>
          </button>
        ))}
      </nav>

      {selectedSeries && !video ? (
        <SeriesHub
          series={selectedSeries}
          playingId={activeEpisode?.id}
          onClose={closeSeries}
          onPlay={playEpisode}
        />
      ) : null}

      {video ? (
        <VideoTheatre
          video={video}
          activeEpisode={activeEpisode}
          seasonEpisodes={seasonEpisodes}
          nextEpisode={nextEpisode}
          hasPreviousEpisode={Boolean(previousEpisode)}
          hasNextEpisode={Boolean(nextEpisode)}
          saved={saved.includes(video.id)}
          onClose={closeVideo}
          onToggleSaved={() => toggleSaved(video.id)}
          onPreviousEpisode={playPreviousEpisode}
          onNextEpisode={playNextEpisode}
          onPlayEpisode={(episode) => {
            if (currentSeries) playEpisode(episode, currentSeries);
          }}
          onCopyLink={copyStreamUrl}
        />
      ) : null}

      {toast ? (
        <div className="toast" role="status">
          <Check size={16} />
          <span>{toast}</span>
        </div>
      ) : null}
    </div>
  );
}
