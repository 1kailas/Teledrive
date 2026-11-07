import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { api, type Stats, type FileDTO } from '../api';
import { fmtBytes, categoryUsage, CATEGORY_COLORS } from '../utils';
import { Thumb } from '../components/ui';
import { usePreview } from '../store';
import { pickFiles } from '../components/Explorer';
import { HardDrive, Clock, Upload, FolderOpen } from 'lucide-react';

export function HomePage() {
  const { data: stats } = useQuery({ queryKey: ['stats'], queryFn: () => api.get<Stats>('/api/stats') });
  const { data: recent } = useQuery({ queryKey: ['recent'], queryFn: () => api.get<{ files: FileDTO[] }>('/api/recent?limit=12') });
  const nav = useNavigate();
  const hasRecent = (recent?.files.length ?? 0) > 0;
  const usage = categoryUsage(stats?.byCategory ?? []);

  return (
    <div className="h-full flex flex-col bg-surface overflow-auto p-8 space-y-8 max-w-6xl">
      {/* ── Welcome Heading ── */}
      <div>
        <h1 className="text-2xl font-semibold text-text tracking-tight">Welcome to TeleDrive</h1>
        <p className="text-2 text-sm mt-1">Your unlimited private cloud drive — powered by your private Telegram channel.</p>
      </div>

      {/* ── Empty Drive CTA ── */}
      {!hasRecent && (
        <section className="surface-2 rounded-2xl p-8 border border-app max-w-2xl">
          <div className="w-12 h-12 rounded-2xl bg-accent/15 text-accent flex items-center justify-center mb-4">
            <Upload size={22} />
          </div>
          <h2 className="text-lg font-semibold text-text">Your cloud drive is ready</h2>
          <p className="text-2 text-sm mt-1.5 max-w-lg">
            Upload files of any size. TeleDrive automatically chunks, hashes, and streams them into your private Telegram channel with multi-bot parallel speeds.
          </p>
          <div className="flex flex-wrap items-center gap-2 mt-5">
            <button className="btn btn-primary" onClick={() => pickFiles(null)}>
              <Upload size={15} />
              Upload files
            </button>
            <button className="btn" onClick={() => nav('/drive')}>
              <FolderOpen size={15} />
              Open My Drive
            </button>
          </div>
        </section>
      )}

      {/* ── Recent Files Section (Google Drive style) ── */}
      {hasRecent && recent && (
        <section>
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold text-base flex items-center gap-2 text-text">
              <Clock size={18} className="text-accent" />
              <span>Suggested files</span>
            </h2>
            <button className="text-xs text-accent hover:underline font-medium" onClick={() => nav('/recent')}>
              View all
            </button>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
            {recent.files.slice(0, 6).map((f, i) => (
              <div
                key={f.id}
                className="gdrive-file-card p-2 group"
                onClick={() => usePreview.getState().start(recent.files, i)}
              >
                <div className="preview-area rounded-lg overflow-hidden mb-2">
                  <Thumb file={f} className="w-full h-full" />
                </div>
                <div className="px-1">
                  <div className="text-xs font-medium text-text truncate" title={f.name}>{f.name}</div>
                  <div className="text-3 text-[11px] mt-0.5">{fmtBytes(f.size)}</div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── Storage Overview Card ── */}
      <section className="surface-2 rounded-2xl p-6 border border-app max-w-xl">
        <h2 className="font-semibold text-base mb-3 flex items-center gap-2">
          <HardDrive size={18} className="text-accent" />
          <span>Self-hosted Telegram Storage</span>
        </h2>
        <div className="seg-bar mb-3 bg-surface-3 rounded-full">
          {usage.length > 0 ? usage.map((item) => (
            <div
              key={item.category}
              className="seg"
              style={{ width: `${item.percent}%`, background: CATEGORY_COLORS[item.category] ?? CATEGORY_COLORS.other }}
              title={`${item.category}: ${fmtBytes(item.size)}`}
            />
          )) : <div className="seg flex-1" />}
        </div>
        <div className="text-xs text-2 space-y-1">
          <div>
            <strong className="text-text">{fmtBytes(stats?.totalSize ?? 0)}</strong> stored in Telegram private channel (Unlimited capacity)
          </div>
          <div className="text-3">{stats?.fileCount ?? 0} files across {stats?.folderCount ?? 0} folders</div>
        </div>
        <div className="mt-4 pt-3 border-t border-app flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs text-3">
            {stats?.bots?.filter((b) => b.healthy).length ?? 0} of {stats?.bots?.length ?? 0} bots active
          </span>
          <div className="flex items-center gap-2">
            <button className="btn !py-1 !px-3 text-xs" onClick={() => pickFiles(null)}>
              <Upload size={13} />
              Upload
            </button>
            <button className="btn !py-1 !px-3 text-xs" onClick={() => nav('/drive')}>
              Go to My Drive
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
