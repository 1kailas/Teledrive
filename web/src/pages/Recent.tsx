import { useState, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Clock, Download, CloudUpload, HardDrive, Search,
  ExternalLink, FolderOpen, ArrowDownUp,
  RefreshCw, CheckCircle2, FileText
} from 'lucide-react';
import { useNavigate } from 'react-router';
import { api, type FileDTO } from '../api';
import { Explorer } from '../components/Explorer';
import { useDownloads, openDownloadedFile, revealDownloadedFile } from '../download';
import { useUploads } from '../upload';
import { fmtBytes, relDate, categoryIcon, CATEGORY_COLORS } from '../utils';

function categoryOf(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'heic'].includes(ext)) return 'image';
  if (['mp4', 'mkv', 'avi', 'mov', 'webm', 'wmv', 'flv'].includes(ext)) return 'video';
  if (['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac'].includes(ext)) return 'audio';
  if (['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'rtf'].includes(ext)) return 'document';
  if (['zip', 'rar', '7z', 'tar', 'gz', 'bz2'].includes(ext)) return 'archive';
  if (['js', 'ts', 'jsx', 'tsx', 'py', 'rs', 'go', 'java', 'c', 'cpp', 'h', 'html', 'css', 'json', 'sh'].includes(ext)) return 'code';
  return 'other';
}

type RecentTab = 'all' | 'files' | 'downloads' | 'uploads';

export function RecentPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [tab, setTab] = useState<RecentTab>('all');
  const [search, setSearch] = useState('');

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['recent'],
    queryFn: () => api.get<{ files: FileDTO[] }>('/api/recent?limit=200'),
  });

  const files = data?.files ?? [];
  const downloads = useDownloads((s) => s.downloads);
  const uploads = useUploads((s) => s.tasks);

  const filterText = search.trim().toLowerCase();

  const filteredFiles = useMemo(() => {
    if (!filterText) return files;
    return files.filter((f) => f.name.toLowerCase().includes(filterText));
  }, [files, filterText]);

  const filteredDownloads = useMemo(() => {
    if (!filterText) return downloads;
    return downloads.filter((d) => d.name.toLowerCase().includes(filterText));
  }, [downloads, filterText]);

  const filteredUploads = useMemo(() => {
    if (!filterText) return uploads;
    return uploads.filter((u) => u.name.toLowerCase().includes(filterText));
  }, [uploads, filterText]);

  // Combined timeline items for "all"
  const allItems = useMemo(() => {
    type TimelineItem =
      | { type: 'file'; id: string; name: string; size: number; timestamp: number; data: FileDTO }
      | { type: 'download'; id: string; name: string; size: number; timestamp: number; status: string; destPath?: string; isNative?: boolean }
      | { type: 'upload'; id: string; name: string; size: number; timestamp: number; status: string };

    const list: TimelineItem[] = [];

    for (const f of filteredFiles) {
      list.push({
        type: 'file',
        id: f.id,
        name: f.name,
        size: f.size,
        timestamp: f.updatedAt || f.createdAt,
        data: f,
      });
    }

    for (const d of filteredDownloads) {
      list.push({
        type: 'download',
        id: d.id,
        name: d.name,
        size: d.size,
        timestamp: d.startedAt,
        status: d.status,
        destPath: d.destPath,
        isNative: d.isNative,
      });
    }

    for (const u of filteredUploads) {
      list.push({
        type: 'upload',
        id: u.key,
        name: u.name,
        size: u.size,
        timestamp: Date.now(),
        status: u.status,
      });
    }

    list.sort((a, b) => b.timestamp - a.timestamp);
    return list;
  }, [filteredFiles, filteredDownloads, filteredUploads]);

  return (
    <div className="h-full flex flex-col bg-surface overflow-hidden">
      {/* Header bar */}
      <div className="px-6 pt-5 pb-3 border-b border-app shrink-0 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-accent-soft text-accent flex items-center justify-center shrink-0">
              <Clock size={20} />
            </div>
            <div>
              <h1 className="text-lg font-bold text-text leading-tight">Recent Activity</h1>
              <p className="text-xs text-3 mt-0.5">
                {files.length} cloud files · {downloads.length} downloads · {uploads.length} uploads
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <div className="relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-3 pointer-events-none" />
              <input
                type="text"
                placeholder="Search recent items…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="input !h-8 !pl-8 !pr-3 !text-xs !w-48 sm:!w-64"
              />
            </div>

            <button
              className="btn btn-ghost !h-8 !px-2.5 !text-xs flex items-center gap-1.5"
              title="Refresh recent activity"
              onClick={() => {
                void qc.invalidateQueries({ queryKey: ['recent'] });
                void refetch();
              }}
            >
              <RefreshCw size={13} className={isLoading ? 'animate-spin' : ''} />
              <span className="hidden sm:inline">Refresh</span>
            </button>

            <button
              className="btn btn-ghost !h-8 !px-2.5 !text-xs text-accent flex items-center gap-1.5"
              onClick={() => navigate('/transfers')}
              title="Go to Transfers Hub"
            >
              <ArrowDownUp size={13} />
              <span className="hidden sm:inline">Transfers Hub</span>
            </button>
          </div>
        </div>

        {/* Navigation Tabs */}
        <div className="flex items-center gap-1.5 border-b border-transparent">
          <button
            onClick={() => setTab('all')}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5 ${
              tab === 'all'
                ? 'bg-accent text-white shadow-xs'
                : 'text-3 hover:text-text hover:bg-surface-2'
            }`}
          >
            <Clock size={13} />
            <span>All Activity</span>
            <span className="opacity-70 text-[10px] tabular-nums">({allItems.length})</span>
          </button>

          <button
            onClick={() => setTab('files')}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5 ${
              tab === 'files'
                ? 'bg-accent text-white shadow-xs'
                : 'text-3 hover:text-text hover:bg-surface-2'
            }`}
          >
            <HardDrive size={13} />
            <span>Recent Files</span>
            <span className="opacity-70 text-[10px] tabular-nums">({filteredFiles.length})</span>
          </button>

          <button
            onClick={() => setTab('downloads')}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5 ${
              tab === 'downloads'
                ? 'bg-accent text-white shadow-xs'
                : 'text-3 hover:text-text hover:bg-surface-2'
            }`}
          >
            <Download size={13} />
            <span>Downloads</span>
            <span className="opacity-70 text-[10px] tabular-nums">({filteredDownloads.length})</span>
          </button>

          <button
            onClick={() => setTab('uploads')}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5 ${
              tab === 'uploads'
                ? 'bg-accent text-white shadow-xs'
                : 'text-3 hover:text-text hover:bg-surface-2'
            }`}
          >
            <CloudUpload size={13} />
            <span>Uploads</span>
            <span className="opacity-70 text-[10px] tabular-nums">({filteredUploads.length})</span>
          </button>
        </div>
      </div>

      {/* Main Content Area */}
      <div className="flex-1 overflow-auto">
        {tab === 'files' ? (
          <Explorer
            folders={[]}
            files={filteredFiles}
            loading={isLoading}
            onRefresh={() => void qc.invalidateQueries({ queryKey: ['recent'] })}
          />
        ) : tab === 'downloads' ? (
          <div className="p-6 max-w-5xl mx-auto space-y-3">
            {filteredDownloads.length === 0 ? (
              <div className="text-center py-16 text-3">
                <Download size={36} className="mx-auto mb-3 opacity-40 stroke-1" />
                <p className="text-sm font-medium">No recent downloads found</p>
                <p className="text-xs mt-1 text-3">Files downloaded in this session appear here with quick open options.</p>
              </div>
            ) : (
              filteredDownloads.map((d) => {
                const cat = categoryOf(d.name);
                const Icon = categoryIcon(cat);
                const isDone = d.status === 'done';
                return (
                  <div
                    key={d.id}
                    className="flex items-center justify-between p-3.5 rounded-xl border border-app bg-surface-2/40 hover:bg-surface-2 transition-colors gap-3"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div
                        className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0 border border-app/60"
                        style={{ backgroundColor: `${CATEGORY_COLORS[cat]}18`, color: CATEGORY_COLORS[cat] }}
                      >
                        <Icon size={18} />
                      </div>
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-text truncate" title={d.name}>
                          {d.name}
                        </div>
                        <div className="flex items-center gap-2 text-xs text-3 mt-0.5 tabular-nums">
                          <span>{fmtBytes(d.size)}</span>
                          <span>•</span>
                          <span className={isDone ? 'text-emerald-400 font-medium' : 'text-sky-400'}>
                            {isDone ? 'Downloaded' : d.status}
                          </span>
                          <span>•</span>
                          <span>{relDate(d.startedAt)}</span>
                          {d.destPath && (
                            <>
                              <span>•</span>
                              <span className="font-mono text-[11px] truncate max-w-[200px]" title={d.destPath}>
                                {d.destPath}
                              </span>
                            </>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                      {isDone && d.isNative && (
                        <>
                          <button
                            className="btn btn-ghost !h-7 !px-2.5 !text-xs flex items-center gap-1 text-accent"
                            title="Open downloaded file"
                            onClick={() => void openDownloadedFile(d.id)}
                          >
                            <ExternalLink size={12} />
                            <span>Open</span>
                          </button>
                          <button
                            className="btn btn-ghost !h-7 !px-2.5 !text-xs flex items-center gap-1"
                            title="Show in Windows File Explorer"
                            onClick={() => void revealDownloadedFile(d.id)}
                          >
                            <FolderOpen size={12} />
                            <span>Reveal</span>
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        ) : tab === 'uploads' ? (
          <div className="p-6 max-w-5xl mx-auto space-y-3">
            {filteredUploads.length === 0 ? (
              <div className="text-center py-16 text-3">
                <CloudUpload size={36} className="mx-auto mb-3 opacity-40 stroke-1" />
                <p className="text-sm font-medium">No recent uploads found</p>
                <p className="text-xs mt-1 text-3">Files uploaded to your drive appear here.</p>
              </div>
            ) : (
              filteredUploads.map((u) => {
                const cat = categoryOf(u.name);
                const Icon = categoryIcon(cat);
                const isDone = u.status === 'done';
                return (
                  <div
                    key={u.key}
                    className="flex items-center justify-between p-3.5 rounded-xl border border-app bg-surface-2/40 hover:bg-surface-2 transition-colors gap-3"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div
                        className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0 border border-app/60"
                        style={{ backgroundColor: `${CATEGORY_COLORS[cat]}18`, color: CATEGORY_COLORS[cat] }}
                      >
                        <Icon size={18} />
                      </div>
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-text truncate" title={u.name}>
                          {u.name}
                        </div>
                        <div className="flex items-center gap-2 text-xs text-3 mt-0.5 tabular-nums">
                          <span>{fmtBytes(u.size)}</span>
                          <span>•</span>
                          <span className={isDone ? 'text-emerald-400 font-medium' : 'text-amber-400'}>
                            {isDone ? 'Saved to Cloud Drive' : u.status}
                          </span>
                          <span>•</span>
                          <span>{isDone ? 'Recently saved' : 'In progress'}</span>
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                      {isDone ? (
                        <span className="flex items-center gap-1 text-xs text-emerald-400 font-medium">
                          <CheckCircle2 size={13} />
                          <span>Uploaded</span>
                        </span>
                      ) : (
                        <span className="flex items-center gap-1 text-xs text-3">
                          <span>{u.status}</span>
                        </span>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        ) : (
          /* "all" Timeline View */
          <div className="p-6 max-w-5xl mx-auto space-y-3">
            {allItems.length === 0 ? (
              <div className="text-center py-16 text-3">
                <Clock size={36} className="mx-auto mb-3 opacity-40 stroke-1" />
                <p className="text-sm font-medium">No recent activity found</p>
                <p className="text-xs mt-1 text-3">Recent cloud files, downloads, and uploads will be listed here.</p>
              </div>
            ) : (
              allItems.map((item) => {
                const cat = categoryOf(item.name);
                const Icon = categoryIcon(cat);

                return (
                  <div
                    key={`${item.type}-${item.id}`}
                    className="flex items-center justify-between p-3.5 rounded-xl border border-app bg-surface-2/40 hover:bg-surface-2 transition-colors gap-3"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div
                        className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0 border border-app/60"
                        style={{ backgroundColor: `${CATEGORY_COLORS[cat]}18`, color: CATEGORY_COLORS[cat] }}
                      >
                        <Icon size={18} />
                      </div>

                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-text truncate" title={item.name}>
                          {item.name}
                        </div>
                        <div className="flex items-center gap-2 text-xs text-3 mt-0.5 tabular-nums">
                          <span
                            className={`px-1.5 py-0.2 rounded text-[10px] font-semibold uppercase ${
                              item.type === 'file'
                                ? 'bg-indigo-500/15 text-indigo-400'
                                : item.type === 'download'
                                ? 'bg-sky-500/15 text-sky-400'
                                : 'bg-emerald-500/15 text-emerald-400'
                            }`}
                          >
                            {item.type === 'file' ? 'Cloud File' : item.type}
                          </span>
                          <span>•</span>
                          <span>{fmtBytes(item.size)}</span>
                          <span>•</span>
                          <span>{relDate(item.timestamp)}</span>
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                      {item.type === 'download' && item.status === 'done' && item.isNative && (
                        <>
                          <button
                            className="btn btn-ghost !h-7 !px-2.5 !text-xs flex items-center gap-1 text-accent"
                            title="Open downloaded file"
                            onClick={() => void openDownloadedFile(item.id)}
                          >
                            <ExternalLink size={12} />
                            <span>Open</span>
                          </button>
                          <button
                            className="btn btn-ghost !h-7 !px-2.5 !text-xs flex items-center gap-1"
                            title="Show in Windows File Explorer"
                            onClick={() => void revealDownloadedFile(item.id)}
                          >
                            <FolderOpen size={12} />
                            <span>Reveal</span>
                          </button>
                        </>
                      )}

                      {item.type === 'file' && (
                        <button
                          className="btn btn-ghost !h-7 !px-2.5 !text-xs flex items-center gap-1 text-accent"
                          title="View file"
                          onClick={() => {
                            setTab('files');
                          }}
                        >
                          <FileText size={12} />
                          <span>View in Files</span>
                        </button>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>
    </div>
  );
}
