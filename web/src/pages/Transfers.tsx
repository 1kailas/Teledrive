import { useState, useMemo, useEffect } from 'react';
import {
  ArrowDownUp, Download, Upload, CheckCircle2, Pause, Play, X, RotateCw,
  FolderOpen, ExternalLink, Search, Folder, Trash2, ArrowUpRight, AlertCircle,
} from 'lucide-react';
import clsx from 'clsx';
import { useNavigate } from 'react-router';
import {
  useDownloads, pauseDownload, resumeDownload, cancelDownload, retryDownload,
  openDownloadedFile, revealDownloadedFile, pickDownloadDir, syncNativeDownloads,
  startNativePolling, type DownloadTask,
} from '../download';
import {
  useUploads, pauseUpload, resumeUpload, cancelUpload, resumeServerUpload,
  retryServerUpload, discardUpload, clientKey, startUpload, type UploadTask
} from '../upload';
import { fmtBytes, categoryIcon, CATEGORY_COLORS } from '../utils';
import { fmtEta } from '../components/progress';
import { pickFiles } from '../components/Explorer';

type TabKey = 'all' | 'downloads' | 'uploads' | 'active' | 'completed';

function categoryOf(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (/^(png|jpe?g|gif|webp|heic|bmp|tiff?|avif|svg)$/.test(ext)) return 'image';
  if (/^(mp4|mkv|webm|mov|avi|m4v|wmv|flv)$/.test(ext)) return 'video';
  if (/^(mp3|flac|wav|ogg|m4a|aac|opus|wma)$/.test(ext)) return 'audio';
  if (/^(zip|rar|7z|tar|gz|bz2|xz|zst|iso)$/.test(ext)) return 'archive';
  if (/^(pdf|docx?|xlsx?|pptx?|txt|md|csv|odt|epub|rtf)$/.test(ext)) return 'document';
  if (/^(js|ts|tsx|jsx|py|go|rs|java|c|cpp|h|json|ya?ml|html|css|sh|sql)$/.test(ext)) return 'code';
  return 'other';
}

export function TransfersPage() {
  const [tab, setTab] = useState<TabKey>('all');
  const [search, setSearch] = useState('');
  const { downloads, downloadDir, clearDone: clearDownloads } = useDownloads();
  const { tasks: uploads } = useUploads();

  useEffect(() => {
    void syncNativeDownloads();
    startNativePolling();
  }, []);

  useEffect(() => {
    if ((window as unknown as { desktopApi?: { nativeUploads?: boolean } }).desktopApi?.nativeUploads) return;
    const onDrop = (e: DragEvent) => {
      const dt = e.dataTransfer;
      if (!dt?.files?.length || dt.types.includes('application/x-teledrive-items')) return;
      e.preventDefault();
      for (const f of Array.from(dt.files)) startUpload(f, { folderId: null });
    };
    const onDrag = (e: DragEvent) => e.preventDefault();
    window.addEventListener('drop', onDrop);
    window.addEventListener('dragover', onDrag);
    return () => { window.removeEventListener('drop', onDrop); window.removeEventListener('dragover', onDrag); };
  }, []);

  const clearAllDone = () => {
    clearDownloads();
    for (const u of uploads.filter((t) => t.status === 'done')) {
      useUploads.getState().remove(u.key);
    }
  };

  // Stats calculation
  const activeDownloads = downloads.filter((d) => d.status === 'downloading' || d.status === 'finalizing' || d.status === 'paused' || d.status === 'queued');
  const activeUploads = uploads.filter((u) => ['uploading', 'creating', 'queued', 'processing'].includes(u.status));
  const doneDownloads = downloads.filter((d) => d.status === 'done');
  const doneUploads = uploads.filter((u) => u.status === 'done');

  const totalDlSpeed = activeDownloads.reduce((acc, d) => acc + (d.status === 'downloading' ? d.speed : 0), 0);
  const totalUpSpeed = activeUploads.reduce((acc, u) => acc + (u.status === 'uploading' ? (u.speed || 0) : 0), 0);

  // Filter items
  const filteredDownloads = useMemo(() => {
    return downloads.filter((d) => {
      if (search && !d.name.toLowerCase().includes(search.toLowerCase())) return false;
      if (tab === 'uploads') return false;
      if (tab === 'active') return ['downloading', 'finalizing', 'paused', 'queued'].includes(d.status);
      if (tab === 'completed') return d.status === 'done';
      return true;
    });
  }, [downloads, search, tab]);

  const filteredUploads = useMemo(() => {
    return uploads.filter((u) => {
      if (search && !u.name.toLowerCase().includes(search.toLowerCase())) return false;
      if (tab === 'downloads') return false;
      if (tab === 'active') return ['uploading', 'creating', 'queued', 'processing', 'paused'].includes(u.status);
      if (tab === 'completed') return u.status === 'done';
      return true;
    });
  }, [uploads, search, tab]);

  const totalFiltered = filteredDownloads.length + filteredUploads.length;

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-surface select-none">
      {/* ── Top Header ── */}
      <header className="px-6 py-4 border-b border-app/60 flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-accent/15 flex items-center justify-center text-accent">
              <ArrowDownUp size={22} />
            </div>
            <div>
              <h1 className="text-lg font-bold text-text">Transfers & Activity</h1>
              <p className="text-xs text-3">Native Windows direct I/O transfers with real-time speed & file launcher</p>
            </div>
          </div>

          {/* Quick stats pills */}
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-surface-2 border border-app text-xs">
              <Download size={14} className={clsx(totalDlSpeed > 0 ? 'text-sky-400 animate-bounce' : 'text-3')} />
              <span className="font-medium text-text">
                {activeDownloads.length} dl
              </span>
              {totalDlSpeed > 0 && (
                <span className="text-sky-400 font-semibold tabular-nums">
                  {fmtBytes(totalDlSpeed)}/s
                </span>
              )}
            </div>

            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-surface-2 border border-app text-xs">
              <Upload size={14} className={clsx(totalUpSpeed > 0 ? 'text-accent animate-bounce' : 'text-3')} />
              <span className="font-medium text-text">
                {activeUploads.length} up
              </span>
              {totalUpSpeed > 0 && (
                <span className="text-accent font-semibold tabular-nums">
                  {fmtBytes(totalUpSpeed)}/s
                </span>
              )}
            </div>

            <div className="flex items-center gap-1 ml-2">
              <button
                className="btn btn-secondary !py-1 !px-2.5 text-xs"
                title="Pause all active transfers"
                onClick={() => {
                  for (const d of activeDownloads) pauseDownload(d.id);
                  for (const u of activeUploads) pauseUpload(u.key);
                }}
              >
                <Pause size={13} /> Pause all
              </button>
              <button
                className="btn btn-secondary !py-1 !px-2.5 text-xs"
                title="Resume all paused transfers"
                onClick={() => {
                  for (const d of downloads.filter((x) => x.status === 'paused')) resumeDownload(d.id);
                  for (const u of uploads.filter((x) => x.status === 'paused')) resumeUpload(u.key);
                }}
              >
                <Play size={13} /> Resume all
              </button>
              <button
                className="btn btn-secondary !py-1 !px-2.5 text-xs hover:text-[var(--danger)]"
                title="Cancel all active transfers"
                onClick={() => {
                  if (!window.confirm('Cancel all active transfers?')) return;
                  for (const d of activeDownloads) cancelDownload(d.id);
                  for (const u of activeUploads) void cancelUpload(u.key);
                }}
              >
                <X size={13} /> Cancel all
              </button>
            </div>
            {(doneDownloads.length > 0 || doneUploads.length > 0) && (
              <button
                className="btn btn-secondary !py-1 !px-2.5 text-xs flex items-center gap-1.5 ml-2 hover:text-[var(--danger)]"
                onClick={clearAllDone}
                title="Clear completed transfers"
              >
                <Trash2 size={13} />
                <span>Clear Completed</span>
              </button>
            )}
          </div>
        </div>

        {/* ── Location & Controls bar ── */}
        <div className="flex items-center justify-between pt-1 text-xs">
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-surface-2 border border-app/60 text-2">
              <Folder size={13} className="text-amber-400 shrink-0" />
              <span className="text-3">Downloads folder:</span>
              <span className="font-mono text-text max-w-[320px] truncate" title={downloadDir || 'Default (Downloads)'}>
                {downloadDir || 'Windows Downloads'}
              </span>
            </div>
            <button
              className="btn btn-secondary !py-1 !px-2 text-xs flex items-center gap-1 font-medium"
              onClick={() => void pickDownloadDir()}
              title="Change default download location"
            >
              <FolderOpen size={13} />
              <span>Change Folder…</span>
            </button>
            <button
              className="btn btn-primary !py-1 !px-2.5 text-xs flex items-center gap-1 font-medium shadow-sm ml-1"
              onClick={() => pickFiles(null)}
              title="Upload files to Drive"
            >
              <Upload size={13} />
              <span>Upload Files</span>
            </button>
          </div>

          {/* Search */}
          <div className="relative w-64">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-3" />
            <input
              type="text"
              placeholder="Search transfers…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="input !py-1 !pl-8 !pr-3 text-xs w-full bg-surface-2"
            />
            {search && (
              <button
                className="absolute right-2 top-1/2 -translate-y-1/2 text-3 hover:text-text"
                onClick={() => setSearch('')}
              >
                <X size={12} />
              </button>
            )}
          </div>
        </div>
      </header>

      {/* ── Tabs bar ── */}
      <div className="px-6 border-b border-app/60 flex items-center gap-1 text-xs font-medium">
        <TabButton active={tab === 'all'} onClick={() => setTab('all')} label="All" count={downloads.length + uploads.length} />
        <TabButton active={tab === 'downloads'} onClick={() => setTab('downloads')} label="Downloads" count={downloads.length} />
        <TabButton active={tab === 'uploads'} onClick={() => setTab('uploads')} label="Uploads" count={uploads.length} />
        <TabButton active={tab === 'active'} onClick={() => setTab('active')} label="Active" count={activeDownloads.length + activeUploads.length} />
        <TabButton active={tab === 'completed'} onClick={() => setTab('completed')} label="Completed" count={doneDownloads.length + doneUploads.length} />
      </div>

      {/* ── Transfer List ── */}
      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-2.5">
        {totalFiltered === 0 ? (
          <EmptyState tab={tab} hasSearch={Boolean(search)} />
        ) : (
          <>
            {/* Downloads */}
            {filteredDownloads.map((d) => (
              <DownloadCard key={`dl-${d.id}`} d={d} />
            ))}

            {/* Uploads */}
            {filteredUploads.map((u) => (
              <UploadCard key={`up-${u.key}`} u={u} />
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function TabButton({ active, onClick, label, count }: { active: boolean; onClick: () => void; label: string; count: number }) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        'px-3.5 py-2.5 border-b-2 font-medium flex items-center gap-1.5 transition-colors',
        active ? 'border-accent text-accent' : 'border-transparent text-3 hover:text-text hover:border-app'
      )}
    >
      <span>{label}</span>
      <span className={clsx(
        'px-1.5 py-0.2 rounded-full text-[10px] font-bold tabular-nums',
        active ? 'bg-accent/20 text-accent' : 'bg-surface-2 text-3'
      )}>
        {count}
      </span>
    </button>
  );
}

function DownloadCard({ d }: { d: DownloadTask }) {
  const cat = categoryOf(d.name);
  const Icon = categoryIcon(cat);
  const pct = d.size > 0 ? Math.min(100, Math.round((d.downloaded / d.size) * 100)) : (d.status === 'done' ? 100 : 0);
  const isDone = d.status === 'done';
  const isFailed = d.status === 'failed';
  const isPaused = d.status === 'paused';
  const isFinalizing = d.status === 'finalizing';
  const isActive = d.status === 'downloading';

  return (
    <div className={clsx(
      'p-3.5 rounded-xl border bg-surface-2/60 transition-all hover:border-accent/40',
      isDone && 'border-emerald-500/20 bg-surface-2/30',
      isFailed && 'border-[var(--danger)]/30',
      (isActive || isFinalizing) && 'border-sky-500/40 shadow-sm'
    )}>
      <div className="flex items-start gap-3">
        {/* Category Icon */}
        <div
          className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0"
          style={{ backgroundColor: `${CATEGORY_COLORS[cat]}18`, color: CATEGORY_COLORS[cat] }}
        >
          <Icon size={20} />
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <h4 className="font-semibold text-text text-sm truncate" title={d.name}>
              {d.name}
            </h4>

            {/* Status Badge */}
            <div className="flex items-center gap-1.5 shrink-0">
              {isActive && (
                <span className="px-2 py-0.5 rounded-md text-[11px] font-semibold bg-sky-500/15 text-sky-400 border border-sky-500/30 flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-sky-400 animate-pulse" />
                  Downloading {pct}%
                </span>
              )}
              {isFinalizing && (
                <span className="px-2 py-0.5 rounded-md text-[11px] font-semibold bg-sky-500/15 text-sky-400 border border-sky-500/30 flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-sky-400 animate-pulse" />
                  Saving to disk…
                </span>
              )}
              {isPaused && (
                <span className="px-2 py-0.5 rounded-md text-[11px] font-semibold bg-amber-500/15 text-amber-400 border border-amber-500/30">
                  Paused ({pct}%)
                </span>
              )}
              {d.status === 'queued' && (
                <span className="px-2 py-0.5 rounded-md text-[11px] font-semibold bg-slate-500/15 text-slate-300 border border-slate-500/30">
                  Queued
                </span>
              )}
              {isDone && (
                <span className="px-2 py-0.5 rounded-md text-[11px] font-semibold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 flex items-center gap-1">
                  <CheckCircle2 size={12} />
                  Completed
                </span>
              )}
              {isFailed && (
                <span className="px-2 py-0.5 rounded-md text-[11px] font-semibold bg-[var(--danger)]/15 text-[var(--danger)] border border-[var(--danger)]/30 flex items-center gap-1">
                  <AlertCircle size={12} />
                  Failed
                </span>
              )}
              {d.status === 'cancelled' && (
                <span className="px-2 py-0.5 rounded-md text-[11px] font-semibold bg-slate-800 text-slate-400 border border-slate-700">
                  Cancelled
                </span>
              )}
            </div>
          </div>

          {/* Subtitle / path */}
          <div className="flex items-center gap-2 text-xs text-3 mt-0.5">
            <span className="tabular-nums">{fmtBytes(d.downloaded)} of {fmtBytes(d.size)}</span>
            <span>•</span>
            <span className="truncate max-w-[400px] text-2 font-mono text-[11px]" title={d.destPath || 'Downloads'}>
              {d.destPath || 'Downloads folder'}
            </span>
          </div>

          {/* Progress Bar */}
          {(isActive || isFinalizing || isPaused) && (
            <div className="w-full h-2 rounded-full bg-surface-3 overflow-hidden mt-2.5">
              <div
                className={clsx(
                  'h-full rounded-full transition-all duration-150',
                  isPaused
                    ? 'bg-amber-400'
                    : isFinalizing
                    ? 'bg-gradient-to-r from-sky-400 to-emerald-400'
                    : 'bg-gradient-to-r from-sky-400 to-accent'
                )}
                style={{ width: `${pct}%` }}
              />
            </div>
          )}

          {/* Metrics row */}
          {(isActive || isFinalizing || isPaused || isFailed) && (
            <div className="flex items-center justify-between text-xs mt-1.5 text-3 tabular-nums">
              <span>
                {isFinalizing
                  ? 'Moving file to Downloads…'
                  : isActive && d.speed > 0
                  ? `${fmtBytes(d.speed)}/s`
                  : isPaused
                  ? 'Paused'
                  : isFailed
                  ? (d.error || 'Download failed')
                  : 'Connecting…'}
              </span>
              {isActive && d.downloaded > 0 && d.speed > 0 && d.eta > 0 && (
                <span>ETA: {fmtEta(d.eta)}</span>
              )}
            </div>
          )}
        </div>

        {/* Action Buttons */}
        <div className="flex items-center gap-1.5 shrink-0 self-center">
          {/* Completed actions: Open file, Reveal in Folder */}
          {isDone && (
            <>
              <button
                className="btn btn-primary !py-1 !px-2.5 text-xs flex items-center gap-1.5 font-medium shadow-sm"
                onClick={() => void openDownloadedFile(d.id)}
                title="Open file with default program"
              >
                <ExternalLink size={13} />
                <span>Open File</span>
              </button>
              <button
                className="btn btn-secondary !py-1 !px-2.5 text-xs flex items-center gap-1.5 font-medium"
                onClick={() => void revealDownloadedFile(d.id)}
                title="Highlight in Windows Explorer"
              >
                <FolderOpen size={13} />
                <span>Show in Folder</span>
              </button>
            </>
          )}

          {/* Active actions */}
          {isActive && (
            <button
              className="icon-btn !w-8 !h-8 text-amber-400 hover:bg-amber-400/10"
              onClick={() => pauseDownload(d.id)}
              title="Pause download"
            >
              <Pause size={14} />
            </button>
          )}
          {isPaused && (
            <button
              className="icon-btn !w-8 !h-8 text-sky-400 hover:bg-sky-400/10"
              onClick={() => resumeDownload(d.id)}
              title="Resume download"
            >
              <Play size={14} />
            </button>
          )}
          {(isFailed || d.status === 'cancelled') && (
            <button
              className="icon-btn !w-8 !h-8 text-sky-400 hover:bg-sky-400/10"
              onClick={() => retryDownload(d.id)}
              title="Retry download"
            >
              <RotateCw size={14} />
            </button>
          )}
          {(isActive || isPaused || d.status === 'queued') && (
            <button
              className="icon-btn !w-8 !h-8 text-3 hover:text-[var(--danger)]"
              onClick={() => cancelDownload(d.id)}
              title="Cancel download"
            >
              <X size={14} />
            </button>
          )}
          {(isDone || isFailed || d.status === 'cancelled') && (
            <button
              className="icon-btn !w-8 !h-8 text-3 hover:text-text"
              onClick={() => useDownloads.getState().removeDownload(d.id)}
              title="Remove from history"
            >
              <X size={14} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function UploadCard({ u }: { u: UploadTask }) {
  const navigate = useNavigate();
  const cat = categoryOf(u.name);
  const Icon = categoryIcon(cat);
  const pct = u.size > 0 ? Math.min(100, Math.round((u.uploaded / u.size) * 100)) : 100;
  const isDone = u.status === 'done';
  const isFailed = ['failed', 'server-failed'].includes(u.status);
  const isPaused = u.status === 'paused';
  const isActive = ['uploading', 'creating', 'queued', 'processing'].includes(u.status);

  const pickResume = () => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.onchange = () => {
      const f = inp.files?.[0];
      if (f && u.uploadId && u.fileId) {
        resumeServerUpload(
          { id: u.uploadId, fileId: u.fileId, name: u.name, size: u.size, clientKey: u.clientKey ?? clientKey({ name: u.name, size: u.size }) },
          f
        );
      }
    };
    inp.click();
  };

  return (
    <div className={clsx(
      'p-3.5 rounded-xl border bg-surface-2/60 transition-all hover:border-accent/40',
      isDone && 'border-emerald-500/20 bg-surface-2/30',
      isFailed && 'border-[var(--danger)]/30',
      isActive && 'border-accent/40 shadow-sm'
    )}>
      <div className="flex items-start gap-3">
        {/* Category Icon */}
        <div
          className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0"
          style={{ backgroundColor: `${CATEGORY_COLORS[cat]}18`, color: CATEGORY_COLORS[cat] }}
        >
          <Icon size={20} />
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <h4 className="font-semibold text-text text-sm truncate" title={u.name}>
              {u.name}
            </h4>
            {u.native && <span className="px-1.5 py-px rounded text-[10px] font-semibold bg-accent/15 text-accent border border-accent/30 shrink-0 self-center">Native</span>}

            {/* Status Badge */}
            <div className="flex items-center gap-1.5 shrink-0">
              {u.status === 'uploading' && (
                <span className="px-2 py-0.5 rounded-md text-[11px] font-semibold bg-accent/15 text-accent border border-accent/30 flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
                  Uploading {pct}%
                </span>
              )}
              {u.status === 'processing' && (
                <span className="px-2 py-0.5 rounded-md text-[11px] font-semibold bg-sky-500/15 text-sky-400 border border-sky-500/30 flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-sky-400 animate-pulse" />
                  Storing on Telegram
                </span>
              )}
              {isPaused && (
                <span className="px-2 py-0.5 rounded-md text-[11px] font-semibold bg-amber-500/15 text-amber-400 border border-amber-500/30">
                  Paused ({pct}%)
                </span>
              )}
              {u.status === 'queued' && (
                <span className="px-2 py-0.5 rounded-md text-[11px] font-semibold bg-slate-500/15 text-slate-300 border border-slate-500/30">
                  Queued
                </span>
              )}
              {isDone && (
                <span className="px-2 py-0.5 rounded-md text-[11px] font-semibold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 flex items-center gap-1">
                  <CheckCircle2 size={12} />
                  Saved to Drive
                </span>
              )}
              {isFailed && (
                <span className="px-2 py-0.5 rounded-md text-[11px] font-semibold bg-[var(--danger)]/15 text-[var(--danger)] border border-[var(--danger)]/30 flex items-center gap-1">
                  <AlertCircle size={12} />
                  Failed
                </span>
              )}
            </div>
          </div>

          {/* Subtitle */}
          <div className="flex items-center gap-2 text-xs text-3 mt-0.5">
            <span className="tabular-nums">{fmtBytes(u.uploaded)} of {fmtBytes(u.size)}</span>
            <span>•</span>
            <span>Cloud Drive</span>
            {u.partsTotal > 1 && (
              <>
                <span>•</span>
                <span className="tabular-nums text-sky-400 font-medium">Part {Math.min(u.slicesDone + 1, u.partsTotal)}/{u.partsTotal}</span>
              </>
            )}
          </div>

          {/* Progress Bar */}
          {isActive && (
            <div className="w-full h-2 rounded-full bg-surface-3 overflow-hidden mt-2.5">
              <div
                className="h-full rounded-full transition-all duration-200 bg-gradient-to-r from-accent to-sky-400"
                style={{ width: `${pct}%` }}
              />
            </div>
          )}

          {/* Metrics row */}
          {(isActive || isPaused || isFailed) && (
            <div className="flex items-center justify-between text-xs mt-1.5 text-3 tabular-nums">
              <span>
                {u.status === 'uploading' && u.speed > 0
                  ? `${fmtBytes(u.speed)}/s`
                  : u.status === 'processing'
                  ? 'Dispatching parts to Telegram bot pool…'
                  : isPaused
                  ? 'Paused'
                  : isFailed
                  ? (u.error || 'Upload failed')
                  : 'Staging…'}
              </span>
              {u.status === 'uploading' && u.eta > 0 && (
                <span>ETA: {fmtEta(u.eta)}</span>
              )}
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1.5 shrink-0 self-center">
          {isDone && (
            <button
              className="btn btn-secondary !py-1 !px-2.5 text-xs flex items-center gap-1.5 font-medium"
              onClick={() => navigate('/drive')}
              title="Go to Drive"
            >
              <ArrowUpRight size={13} />
              <span>View in Drive</span>
            </button>
          )}
          {u.status === 'uploading' && (
            <button
              className="icon-btn !w-8 !h-8 text-amber-400 hover:bg-amber-400/10"
              onClick={() => pauseUpload(u.key)}
              title="Pause upload"
            >
              <Pause size={14} />
            </button>
          )}
          {isPaused && !u.noLocalFile && (
            <button
              className="icon-btn !w-8 !h-8 text-accent hover:bg-accent/10"
              onClick={() => resumeUpload(u.key)}
              title="Resume upload"
            >
              <Play size={14} />
            </button>
          )}
          {isPaused && u.noLocalFile && (
            <button className="btn btn-primary !py-1 !px-2.5 text-xs" onClick={pickResume}>
              Select file
            </button>
          )}
          {isFailed && u.uploadId && (
            <button
              className="icon-btn !w-8 !h-8 text-accent hover:bg-accent/10"
              onClick={() => void retryServerUpload(u.key)}
              title="Retry upload"
            >
              <RotateCw size={14} />
            </button>
          )}
          {isFailed && (
            <button
              className="icon-btn !w-8 !h-8 text-3 hover:text-text"
              onClick={() => discardUpload(u.key)}
              title="Discard"
            >
              <X size={14} />
            </button>
          )}
          {isActive && (
            <button
              className="icon-btn !w-8 !h-8 text-3 hover:text-[var(--danger)]"
              onClick={() => void cancelUpload(u.key)}
              title="Cancel upload"
            >
              <X size={14} />
            </button>
          )}
          {isDone && (
            <button
              className="icon-btn !w-8 !h-8 text-3 hover:text-text"
              onClick={() => useUploads.getState().remove(u.key)}
              title="Remove from history"
            >
              <X size={14} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function EmptyState({ tab, hasSearch }: { tab: TabKey; hasSearch: boolean }) {
  const message = hasSearch
    ? 'No transfers match your search query.'
    : tab === 'active'
    ? 'No transfers currently active.'
    : tab === 'completed'
    ? 'No completed downloads or uploads in this session.'
    : tab === 'downloads'
    ? 'No file downloads yet. Click Download on any file in your Drive to start.'
    : tab === 'uploads'
    ? 'No file uploads yet. Click + New to upload files or folders.'
    : 'No active or recent transfers.';

  return (
    <div className="flex flex-col items-center justify-center py-20 text-center select-none">
      <div className="w-16 h-16 rounded-2xl bg-surface-2 border border-app flex items-center justify-center text-3 mb-3">
        <ArrowDownUp size={28} className="opacity-60" />
      </div>
      <h3 className="text-sm font-semibold text-text mb-1">All quiet here</h3>
      <p className="text-xs text-3 max-w-sm mb-4">{message}</p>
      {!hasSearch && (
        <button
          className="btn btn-primary !py-1.5 !px-3.5 text-xs flex items-center gap-1.5 font-medium shadow-sm"
          onClick={() => pickFiles(null)}
        >
          <Upload size={14} />
          <span>Upload Files</span>
        </button>
      )}
    </div>
  );
}
