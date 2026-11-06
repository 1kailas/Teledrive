import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  HardDrive, Clock, Star, Trash2, Settings, LogOut,
  Search, LayoutGrid, List, Moon, Sun, Monitor, Plus, Info,
  ArrowUpDown, ArrowDownUp, SlidersHorizontal, Sliders, Cloud,
  Image, Video, FileText, Music,
} from 'lucide-react';
import { api, type Config, type Stats } from '../api';
import { useUi, useDialog, type SortBy } from '../store';
import { useDownloads, syncNativeDownloads, startNativePolling } from '../download';
import { useUploads } from '../upload';
import { fmtBytes } from '../utils';
import { Dropdown } from './Menu';
import { pickFiles, pickFolder } from './Explorer';
import { UploadPanel } from './UploadPanel';
import { PreviewOverlay } from './Preview';
import { DialogHost } from './Dialogs';
import { Toasts } from './ui';
import { startSse } from '../sse';

export function AppLayout() {
  useEffect(() => {
    startSse();
    void useUi.getState().loadServerSettings();
    void syncNativeDownloads();
    startNativePolling();
  }, []);
  return (
    <div className="h-full flex flex-col bg-app">
      <TopBar />
      <div className="flex-1 flex overflow-hidden">
        <Sidebar />
        <main className="flex-1 overflow-hidden bg-surface flex flex-col">
          <Outlet />
        </main>
      </div>
      <UploadPanel />
      <PreviewOverlay />
      <DialogHost />
      <Toasts />
    </div>
  );
}

const MAIN_NAV = [
  { to: '/drive', label: 'My Drive', icon: HardDrive },
  { to: '/transfers', label: 'Transfers', icon: ArrowDownUp },
  { to: '/recent', label: 'Recent', icon: Clock },
  { to: '/starred', label: 'Starred', icon: Star },
];

const MEDIA_NAV = [
  { to: '/photos', label: 'Photos', icon: Image },
  { to: '/videos', label: 'Videos', icon: Video },
  { to: '/documents', label: 'Documents', icon: FileText },
  { to: '/audio', label: 'Audio', icon: Music },
];

const SYSTEM_NAV = [
  { to: '/trash', label: 'Trash', icon: Trash2 },
  { to: '/settings', label: 'Settings', icon: Settings },
];

function Sidebar() {
  const { data: stats } = useQuery({ queryKey: ['stats'], queryFn: () => api.get<Stats>('/api/stats'), refetchInterval: 60_000 });
  const { data: config } = useQuery({ queryKey: ['config'], queryFn: () => api.get<Config>('/api/config'), refetchInterval: 60_000 });
  const usedBytes = stats?.totalSize ?? 0;

  const activeDownloadsCount = useDownloads((s) => s.downloads.filter((d) => d.status === 'downloading' || d.status === 'finalizing').length);
  const activeUploadsCount = useUploads((s) => s.tasks.filter((t) => ['uploading', 'creating', 'processing'].includes(t.status)).length);
  const activeTransfersCount = activeDownloadsCount + activeUploadsCount;

  useEffect(() => {
    if (config && !useUi.getState().desktopMode) useUi.getState().setDesktopMode(true);
  }, [config]);

  return (
    <aside className="w-64 shrink-0 bg-app flex flex-col px-3 py-3 select-none">
      {/* ── Google Drive "+ New" Button ── */}
      <div className="mb-4 px-1">
        <Dropdown align="left" trigger={
          <button className="gdrive-new-btn w-fit">
            <Plus size={22} className="text-accent" />
            <span>New</span>
          </button>
        }>
          <NewMenuItems />
        </Dropdown>
      </div>

      {/* ── Navigation Links ── */}
      <nav className="flex-1 space-y-3 overflow-y-auto pr-1">
        <div className="space-y-0.5">
          {MAIN_NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              className={({ isActive }) => clsx('gdrive-nav-item', isActive && 'active')}
            >
              <n.icon size={18} className="shrink-0" />
              <span>{n.label}</span>
              {n.to === '/transfers' && activeTransfersCount > 0 && (
                <span className="ml-auto px-1.5 py-0.2 rounded-full text-[10px] font-bold bg-accent text-white animate-pulse tabular-nums">
                  {activeTransfersCount}
                </span>
              )}
            </NavLink>
          ))}
        </div>

        <div>
          <div className="px-3 py-1 text-[11px] font-semibold text-3 uppercase tracking-wider">
            Media
          </div>
          <div className="space-y-0.5 mt-0.5">
            {MEDIA_NAV.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                className={({ isActive }) => clsx('gdrive-nav-item', isActive && 'active')}
              >
                <n.icon size={18} className="shrink-0" />
                <span>{n.label}</span>
              </NavLink>
            ))}
          </div>
        </div>

        <div>
          <div className="px-3 py-1 text-[11px] font-semibold text-3 uppercase tracking-wider">
            System
          </div>
          <div className="space-y-0.5 mt-0.5">
            {SYSTEM_NAV.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                className={({ isActive }) => clsx('gdrive-nav-item', isActive && 'active')}
              >
                <n.icon size={18} className="shrink-0" />
                <span>{n.label}</span>
              </NavLink>
            ))}
          </div>
        </div>
      </nav>

      {/* ── Storage Indicator (Clean, Symmetric & No Manage Storage Button) ── */}
      <div className="mt-auto pt-3 border-t border-app px-2 select-none">
        <div className="flex items-center justify-between text-xs mb-1.5">
          <div className="flex items-center gap-1.5 text-text font-medium">
            <Cloud size={14} className="text-accent shrink-0" />
            <span>Cloud Storage</span>
          </div>
          <span className="text-[10px] font-semibold text-emerald-500 uppercase tracking-wider bg-emerald-500/10 px-1.5 py-0.5 rounded">
            Unlimited
          </span>
        </div>
        <div className="h-1.5 w-full bg-surface-2 rounded-full overflow-hidden mb-1.5 border border-app">
          <div
            className="h-full rounded-full transition-all duration-500 bg-gradient-to-r from-sky-500 to-indigo-500"
            style={{ width: `${Math.max(4, Math.min(100, Math.round((usedBytes / (50 * 1024 * 1024 * 1024)) * 100)))}%` }}
          />
        </div>
        <div className="flex items-center justify-between text-[11px] text-3 tabular-nums font-medium">
          <span>{fmtBytes(usedBytes)} in drive</span>
          <span>{stats?.fileCount ?? 0} {stats?.fileCount === 1 ? 'file' : 'files'}</span>
        </div>
      </div>
    </aside>
  );
}

function NewMenuItems() {
  const d = useDialog.getState().open;
  const loc = useLocation();
  const folderId = loc.pathname.startsWith('/drive/') ? loc.pathname.split('/')[2]! : null;
  return (
    <div className="w-52">
      <div className="menu-item" onClick={() => d({ kind: 'newFolder', parentId: folderId })}>
        <Plus size={15} /> New folder
      </div>
      <div className="my-1 border-t border-app" />
      <div className="menu-item" onClick={() => pickFiles(folderId)}>
        File upload
      </div>
      <div className="menu-item" onClick={() => pickFolder(folderId)}>
        Folder upload
      </div>
      <div className="my-1 border-t border-app" />
      <div className="menu-item" onClick={() => d({ kind: 'newText', folderId })}>
        New text document
      </div>
    </div>
  );
}

const SORTS: { key: SortBy; label: string }[] = [
  { key: 'name', label: 'Name' },
  { key: 'updatedAt', label: 'Last modified' },
  { key: 'size', label: 'File size' },
  { key: 'type', label: 'Type' },
];

function TopBar() {
  const [q, setQ] = useState('');
  const [sug, setSug] = useState<string[]>([]);
  const nav = useNavigate();
  const loc = useLocation();
  const { viewMode, setViewMode, cardSize, setCardSize, theme, setTheme, detailsOpen, setDetailsOpen, sortBy, sortDir, setSort } = useUi();
  const inDrive = loc.pathname.startsWith('/drive') ||
    loc.pathname === '/recent' ||
    loc.pathname === '/starred' ||
    loc.pathname.startsWith('/search') ||
    loc.pathname === '/photos' ||
    loc.pathname === '/videos' ||
    loc.pathname === '/documents' ||
    loc.pathname === '/audio';
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: () => api.get<{ username: string }>('/api/auth/me'), staleTime: 300_000 });

  useEffect(() => {
    if (!q.trim()) return setSug([]);
    const t = setTimeout(() => {
      void api.get<{ suggestions: string[] }>(`/api/search/suggest?q=${encodeURIComponent(q)}`).then((r) => setSug(r.suggestions)).catch(() => {});
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'k' || e.key.toLowerCase() === 'f')) {
        e.preventDefault();
        document.querySelector<HTMLInputElement>('[data-search]')?.focus();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, []);

  const doSearch = (term?: string) => {
    const s = (term ?? q).trim();
    if (s) { nav(`/search?q=${encodeURIComponent(s)}`); setSug([]); }
  };

  return (
    <header className="h-16 px-4 flex items-center justify-between gap-4 bg-app shrink-0 select-none">
      {/* ── Left: Logo + App Name (Symmetric w-64 with Sidebar) ── */}
      <div className="flex items-center gap-3 w-64 shrink-0 cursor-pointer pl-1" onClick={() => nav('/drive')}>
        <img
          src="/icon.png"
          className="w-9 h-9 rounded-xl object-contain shadow-xs shrink-0"
          alt="TeleDrive"
        />
        <div className="flex items-baseline gap-1.5">
          <span className="font-semibold text-[17px] tracking-tight text-text">TeleDrive</span>
        </div>
      </div>

      {/* ── Center: Google Drive Search Pill Anchored Directly Next to Sidebar (Zero Jitter) ── */}
      <div className="w-[640px] max-w-2xl ml-4 mr-auto relative">
        <div className="relative flex items-center">
          <Search size={18} className="absolute left-4 text-3 pointer-events-none" />
          <input
            className="input !pl-11 !pr-24 !py-2.5 !rounded-full !bg-surface-2 focus:!bg-surface transition-all text-[13.5px]"
            placeholder="Search in Drive…"
            value={q}
            data-search
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') doSearch();
              if (e.key === 'Escape') {
                setQ('');
                setSug([]);
                (e.target as HTMLElement).blur();
              }
            }}
          />
          <div className="absolute right-2.5 flex items-center gap-1">
            {!q && (
              <kbd className="hidden sm:inline-flex items-center gap-0.5 px-2 py-0.5 rounded text-[10.5px] font-medium bg-surface text-3 border border-app shadow-2xs pointer-events-none select-none">
                Ctrl K
              </kbd>
            )}
            <Dropdown align="right" trigger={
              <button className="icon-btn !w-7 !h-7 text-3 hover:text-text" title="Search options">
                <SlidersHorizontal size={14} />
              </button>
            }>
              <FilterPop />
            </Dropdown>
          </div>
        </div>

        {sug.length > 0 && (
          <div className="absolute top-full mt-1.5 w-full surface shadow-lg border border-app rounded-2xl py-2 z-40">
            {sug.map((s) => (
              <div key={s} className="menu-item" onClick={() => { setQ(s); doSearch(s); }}>
                <Search size={14} className="text-3" />
                <span>{s}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Right Controls: Symmetric Right Cluster ── */}
      <div className="shrink-0 flex items-center justify-end gap-1">
        {inDrive && (
          <>
            <button
              className={clsx('icon-btn', viewMode === 'list' && 'accent-bg accent')}
              onClick={() => setViewMode(viewMode === 'grid' ? 'list' : 'grid')}
              title={viewMode === 'grid' ? 'Switch to list view' : 'Switch to grid view'}
            >
              {viewMode === 'grid' ? <List size={20} /> : <LayoutGrid size={20} />}
            </button>

            {/* View & Size Dropdown with Mini / G-Drive Size */}
            <Dropdown trigger={
              <button className="icon-btn" title="View options & icon size">
                <Sliders size={17} />
              </button>
            }>
              <div className="w-56">
                <div className="px-3 py-1.5 text-[11px] text-3 font-semibold uppercase tracking-wider">Icon & Folder Size</div>
                <div
                  className={clsx('menu-item', cardSize === 'tiny' && viewMode === 'grid' && 'accent font-semibold')}
                  onClick={() => { setViewMode('grid'); setCardSize('tiny'); }}
                >
                  <span>Mini / Extra Small (G Drive)</span>
                  {cardSize === 'tiny' && viewMode === 'grid' && <span className="ml-auto text-xs">✓</span>}
                </div>
                <div
                  className={clsx('menu-item', cardSize === 'compact' && viewMode === 'grid' && 'accent font-semibold')}
                  onClick={() => { setViewMode('grid'); setCardSize('compact'); }}
                >
                  <span>Small (170px)</span>
                  {cardSize === 'compact' && viewMode === 'grid' && <span className="ml-auto text-xs">✓</span>}
                </div>
                <div
                  className={clsx('menu-item', cardSize === 'standard' && viewMode === 'grid' && 'accent font-semibold')}
                  onClick={() => { setViewMode('grid'); setCardSize('standard'); }}
                >
                  <span>Medium / Standard (220px)</span>
                  {cardSize === 'standard' && viewMode === 'grid' && <span className="ml-auto text-xs">✓</span>}
                </div>
                <div
                  className={clsx('menu-item', cardSize === 'large' && viewMode === 'grid' && 'accent font-semibold')}
                  onClick={() => { setViewMode('grid'); setCardSize('large'); }}
                >
                  <span>Large Icons (280px)</span>
                  {cardSize === 'large' && viewMode === 'grid' && <span className="ml-auto text-xs">✓</span>}
                </div>
                <div
                  className={clsx('menu-item', cardSize === 'xlarge' && viewMode === 'grid' && 'accent font-semibold')}
                  onClick={() => { setViewMode('grid'); setCardSize('xlarge'); }}
                >
                  <span>Extra Large Icons (360px)</span>
                  {cardSize === 'xlarge' && viewMode === 'grid' && <span className="ml-auto text-xs">✓</span>}
                </div>
                <div className="my-1 border-t border-app" />
                <div
                  className={clsx('menu-item', viewMode === 'list' && 'accent font-semibold')}
                  onClick={() => setViewMode('list')}
                >
                  <span>List Details View</span>
                  {viewMode === 'list' && <span className="ml-auto text-xs">✓</span>}
                </div>
              </div>
            </Dropdown>

            <Dropdown trigger={<button className="icon-btn" title={`Sort (${sortBy})`}><ArrowUpDown size={17} /></button>}>
              <div className="w-44">
                <div className="px-3 py-1.5 text-[11px] text-3 font-semibold uppercase tracking-wider">Sort by</div>
                {SORTS.map((s) => (
                  <div
                    key={s.key}
                    className={clsx('menu-item', sortBy === s.key && 'accent font-semibold')}
                    onClick={() => setSort(s.key, sortBy === s.key && sortDir === 'asc' ? 'desc' : 'asc')}
                  >
                    {s.label}
                    {sortBy === s.key && <span className="ml-auto text-xs">{sortDir === 'asc' ? '↑' : '↓'}</span>}
                  </div>
                ))}
              </div>
            </Dropdown>
          </>
        )}

        <button
          className={clsx('icon-btn', detailsOpen && 'accent-bg accent')}
          onClick={() => setDetailsOpen(!detailsOpen)}
          title="File details"
        >
          <Info size={17} />
        </button>

        <Dropdown trigger={
          <button className="icon-btn" title="Appearance">
            {theme === 'dark' ? <Moon size={17} /> : theme === 'light' ? <Sun size={17} /> : <Monitor size={17} />}
          </button>
        }>
          <div className="w-36">
            {(['light', 'dark', 'system'] as const).map((t) => (
              <div key={t} className={clsx('menu-item', theme === t && 'accent font-semibold')} onClick={() => setTheme(t)}>
                {t === 'light' ? <Sun size={15} /> : t === 'dark' ? <Moon size={15} /> : <Monitor size={15} />}
                <span>{t[0]!.toUpperCase() + t.slice(1)}</span>
              </div>
            ))}
          </div>
        </Dropdown>

        {/* User Avatar */}
        <Dropdown trigger={
          <button className="w-8 h-8 rounded-full bg-gradient-to-tr from-sky-500 to-blue-600 text-white font-medium flex items-center justify-center text-xs ml-1 shadow-xs ring-1 ring-white/15 hover:ring-white/30 transition-all cursor-pointer" title="Account">
            {(me?.username ?? 'Admin')[0]!.toUpperCase()}
          </button>
        }>
          <div className="w-52">
            <div className="px-3 py-2 border-b border-app mb-1">
              <div className="font-semibold text-xs text-text">{me?.username ?? 'admin'}</div>
              <div className="text-3 text-[11px]">Administrator</div>
            </div>
            <div className="space-y-0.5">
              <div className="menu-item" onClick={() => nav('/settings')}>
                <Settings size={15} /> Settings
              </div>
              <div className="menu-item danger" onClick={async () => { await api.post('/api/auth/logout').catch(() => {}); location.href = '/login'; }}>
                <LogOut size={15} /> Log out
              </div>
            </div>
          </div>
        </Dropdown>
      </div>
    </header>
  );
}

function FilterPop() {
  const nav = useNavigate();
  const [category, setCategory] = useState('');
  const [minSize, setMinSize] = useState('');
  const [maxSize, setMaxSize] = useState('');
  const [days, setDays] = useState('');
  const apply = () => {
    const p = new URLSearchParams({ q: (document.querySelector<HTMLInputElement>('[data-search]')?.value ?? '') || ' ' });
    if (category) p.set('category', category);
    if (minSize) p.set('minSize', String(Number(minSize) * 1024 * 1024));
    if (maxSize) p.set('maxSize', String(Number(maxSize) * 1024 * 1024));
    if (days) p.set('from', String(Date.now() - Number(days) * 86400_000));
    nav(`/search?${p}`);
  };
  return (
    <div className="p-3 space-y-3 w-64 select-none" onClick={(e) => e.stopPropagation()}>
      <div className="font-semibold text-[11px] uppercase text-3 tracking-wider">Search Filters</div>
      <div>
        <label className="text-3 text-xs font-medium">Type</label>
        <select className="input mt-1 !rounded-lg !py-1.5 !text-xs" value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">Any type</option>
          <option value="document">Documents</option>
          <option value="image">Images</option>
          <option value="video">Videos</option>
          <option value="audio">Audio</option>
          <option value="archive">Archives</option>
          <option value="code">Code</option>
        </select>
      </div>
      <div>
        <label className="text-3 text-xs font-medium">Modified</label>
        <select className="input mt-1 !rounded-lg !py-1.5 !text-xs" value={days} onChange={(e) => setDays(e.target.value)}>
          <option value="">Any time</option>
          <option value="1">Today</option>
          <option value="7">Last 7 days</option>
          <option value="30">Last 30 days</option>
          <option value="365">Last year</option>
        </select>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-3 text-xs font-medium">Min MB</label>
          <input className="input mt-1 !rounded-lg !py-1.5 !text-xs" type="number" min={0} value={minSize} onChange={(e) => setMinSize(e.target.value)} />
        </div>
        <div>
          <label className="text-3 text-xs font-medium">Max MB</label>
          <input className="input mt-1 !rounded-lg !py-1.5 !text-xs" type="number" min={0} value={maxSize} onChange={(e) => setMaxSize(e.target.value)} />
        </div>
      </div>
      <button className="btn btn-primary w-full justify-center !py-1.5 !text-xs mt-2" onClick={apply}>
        Search
      </button>
    </div>
  );
}
