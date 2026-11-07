import { useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import {
  ChevronDown, ChevronUp, Pause, Play, X, RotateCw, CheckCircle2,
  AlertCircle, CloudUpload, Download, Loader2, ArrowDownToLine,
  ExternalLink, FolderOpen, ArrowDownUp,
} from 'lucide-react';
import clsx from 'clsx';
import { api, type UploadListItem, type UploadProgress } from '../api';
import {
  useUploads, pauseUpload, resumeUpload, cancelUpload, resumeServerUpload,
  retryServerUpload, discardUpload, type UploadTask, noteInterruptedUploads, clientKey,
} from '../upload';
import {
  useDownloads, pauseDownload, resumeDownload, retryDownload, cancelDownload,
  openDownloadedFile, revealDownloadedFile, type DownloadTask
} from '../download';
import { fmtBytes, categoryIcon, CATEGORY_COLORS } from '../utils';
import { PartSegments, estimateTransfer, fmtEta, useNow, type Segment } from './progress';

const LIVE = ['queued', 'creating', 'uploading', 'paused', 'processing'];

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

export function UploadPanel() {
  const navigate = useNavigate();
  const { tasks, panelOpen: uploadPanelOpen, panelCollapsed, setPanel } = useUploads();
  const { downloads, clearDone: clearDoneDownloads } = useDownloads();

  const { data: interrupted } = useQuery({
    queryKey: ['uploads-interrupted'],
    queryFn: async () => {
      const lists = await Promise.all(
        ['active', 'processing', 'failed'].map((s) => api.get<{ uploads: UploadListItem[] }>(`/api/uploads?status=${s}`)),
      );
      return lists.flatMap((l) => l.uploads);
    },
    refetchInterval: 30_000,
  });
  useEffect(() => {
    if (interrupted?.length) noteInterruptedUploads(interrupted);
  }, [interrupted]);

  const summary = useMemo(() => {
    const sending = tasks.filter((t) => ['uploading', 'creating', 'queued'].includes(t.status));
    const processing = tasks.filter((t) => t.status === 'processing');
    const failed = tasks.filter((t) => ['failed', 'server-failed'].includes(t.status));
    const done = tasks.filter((t) => t.status === 'done');

    const activeDl = downloads.filter((d) => d.status === 'downloading' || d.status === 'finalizing' || d.status === 'paused');
    const doneDl = downloads.filter((d) => d.status === 'done');
    const failedDl = downloads.filter((d) => ['failed', 'cancelled'].includes(d.status));

    const totalUp = tasks.filter((t) => ['uploading', 'processing', 'creating', 'queued'].includes(t.status)).reduce((a, t) => a + t.size, 0);
    const upBytes = tasks.filter((t) => ['uploading', 'processing', 'creating', 'queued'].includes(t.status)).reduce((a, t) => a + Math.min(t.uploaded, t.size), 0);
    const upSpeed = tasks.filter((t) => ['uploading', 'processing'].includes(t.status)).reduce((a, t) => a + (t.speed || 0), 0);

    const totalDl = activeDl.reduce((a, d) => a + (d.size || d.downloaded), 0);
    const dlBytes = activeDl.reduce((a, d) => a + d.downloaded, 0);
    const dlSpeed = activeDl.reduce((a, d) => a + (d.status === 'downloading' ? d.speed : 0), 0);

    const isSending = sending.length > 0;
    const isDownloading = activeDl.length > 0;
    const isProcessing = processing.length > 0 && !isSending;

    const totalBytes = totalUp + totalDl;
    const transferredBytes = upBytes + dlBytes;
    const combinedSpeed = upSpeed + dlSpeed;
    const eta = combinedSpeed > 0 && totalBytes > transferredBytes ? (totalBytes - transferredBytes) / combinedSpeed : null;

    return {
      sending, processing, failed, done, activeDl, doneDl, failedDl,
      isSending, isDownloading, isProcessing,
      totalUp, upBytes, upSpeed, totalDl, dlBytes, dlSpeed,
      totalBytes, transferredBytes, combinedSpeed, eta,
    };
  }, [tasks, downloads]);

  const hasTransfers = tasks.length > 0 || downloads.length > 0;
  if (!uploadPanelOpen && !hasTransfers) return null;

  const {
    sending, processing, failed, done, activeDl, doneDl, failedDl,
    isProcessing, upSpeed, dlSpeed, totalBytes, transferredBytes, eta,
  } = summary;

  const pct = totalBytes ? Math.min(100, Math.round((transferredBytes / totalBytes) * 100)) : 0;

  let headline = 'Transfers';
  if (sending.length > 0 && activeDl.length > 0) {
    headline = `${sending.length} uploading, ${activeDl.length} downloading`;
  } else if (sending.length > 0) {
    headline = `Uploading ${sending.length} file${sending.length > 1 ? 's' : ''}`;
  } else if (activeDl.length > 0) {
    headline = `Downloading ${activeDl.length} file${activeDl.length > 1 ? 's' : ''}`;
  } else if (processing.length > 0) {
    headline = `Saving files…`;
  } else if (failed.length > 0 || failedDl.length > 0) {
    headline = `${failed.length + failedDl.length} transfer(s) need attention`;
  } else if (done.length > 0 || doneDl.length > 0) {
    headline = `${done.length + doneDl.length} transfer(s) complete`;
  }

  const sublineParts: string[] = [];
  if (upSpeed > 0) sublineParts.push(`↑ ${fmtBytes(upSpeed)}/s`);
  if (dlSpeed > 0) sublineParts.push(`↓ ${fmtBytes(dlSpeed)}/s`);
  if (eta != null && eta > 0) sublineParts.push(fmtEta(eta));
  else if (isProcessing) sublineParts.push('Finalizing on your drive…');
  const subline = sublineParts.join(' · ');

  const isWorking = sending.length > 0 || activeDl.length > 0 || processing.length > 0;

  return (
    <div
      className="fixed bottom-4 right-4 z-[55] w-[420px] max-w-[94vw] surface shadow-overlay border border-app rounded-2xl overflow-hidden fadein"
      id="upload-panel"
    >
      {/* Header / toggle */}
      <button
        className="w-full text-left px-4 pt-3 pb-3 surface-2 hover:bg-[var(--surface-2)]/80 transition-colors"
        onClick={() => setPanel({ collapsed: !panelCollapsed })}
        aria-expanded={!panelCollapsed}
      >
        <div className="flex items-center gap-2.5 text-sm font-semibold">
          {sending.length > 0 && activeDl.length > 0 ? (
            <ArrowDownToLine size={16} className="text-sky-400 shrink-0 animate-bounce" />
          ) : sending.length > 0 ? (
            <CloudUpload size={16} className="accent shrink-0 animate-pulse" />
          ) : activeDl.length > 0 ? (
            <Download size={16} className="text-sky-400 shrink-0 animate-pulse" />
          ) : processing.length > 0 ? (
            <Loader2 size={15} className="accent animate-spin shrink-0" />
          ) : failed.length > 0 || failedDl.length > 0 ? (
            <AlertCircle size={16} className="text-[var(--danger)] shrink-0" />
          ) : (
            <CheckCircle2 size={16} className="text-emerald-500 shrink-0" />
          )}

          <span className="flex-1 truncate">{headline}</span>

          {isWorking && (
            <span
              className="text-xs font-semibold tabular-nums px-2 py-0.5 rounded-full"
              style={{ background: 'var(--accent-soft)', color: 'var(--accent-text)' }}
            >
              {pct}%
            </span>
          )}
          {panelCollapsed ? <ChevronUp size={14} className="text-3 shrink-0" /> : <ChevronDown size={14} className="text-3 shrink-0" />}
        </div>
        {subline && <div className="text-[11px] text-3 mt-1 truncate tabular-nums">{subline}</div>}
        {isWorking && (
          <div className="bar mt-2.5">
            <i style={{ width: `${pct}%`, transition: 'width 250ms ease-out' }} />
          </div>
        )}
      </button>

      {/* Task list */}
      {!panelCollapsed && (
        <div className="max-h-[24rem] overflow-auto divide-y divide-app">
          {/* Active downloads */}
          {downloads.map((d) => <DownloadRow key={d.id} d={d} />)}

          {/* Active / recent uploads */}
          {tasks.map((t) => <TaskRow key={t.key} t={t} />)}

          {tasks.length === 0 && downloads.length === 0 && (
            <div className="p-5 text-3 text-sm text-center">No active transfers</div>
          )}

          <div className="p-2 border-t border-app flex items-center justify-between bg-surface-2/40 text-xs">
            <button
              className="text-accent hover:underline flex items-center gap-1 font-medium"
              onClick={() => {
                setPanel({ open: false });
                navigate('/transfers');
              }}
            >
              <ArrowDownUp size={12} />
              <span>Transfers Hub →</span>
            </button>

            {(done.length > 0 || doneDl.length > 0) && (
              <button
                className="text-3 hover:text-text hover:underline text-[11px]"
                onClick={() => {
                  for (const t of done) useUploads.getState().remove(t.key);
                  clearDoneDownloads();
                  if (useUploads.getState().tasks.length === 0 && useDownloads.getState().downloads.length === 0) {
                    setPanel({ open: false });
                  }
                }}
              >
                Clear completed ({done.length + doneDl.length})
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function DownloadRow({ d }: { d: DownloadTask }) {
  const cat = categoryOf(d.name);
  const Icon = d.status === 'done' ? CheckCircle2
    : d.status === 'failed' ? AlertCircle
    : d.status === 'paused' ? Pause
    : categoryIcon(cat);
  const pct = d.size > 0
    ? Math.min(100, Math.round((d.downloaded / d.size) * 100))
    : (d.status === 'done' || d.status === 'finalizing' ? 100 : 0);

  const downloadText = () => {
    switch (d.status) {
      case 'downloading': {
        if (d.downloaded === 0 || d.speed === 0) {
          return [`${fmtBytes(d.downloaded)}${d.size > 0 ? ` of ${fmtBytes(d.size)}` : ''}`, 'Connecting to Telegram…'].filter(Boolean).join(' · ');
        }
        const speedText = `${fmtBytes(d.speed)}/s`;
        const etaText = d.eta > 0 ? fmtEta(d.eta) : '';
        return [`${fmtBytes(d.downloaded)}${d.size > 0 ? ` of ${fmtBytes(d.size)}` : ''}`, speedText, etaText].filter(Boolean).join(' · ');
      }
      case 'finalizing':
        return `${fmtBytes(d.size)} received · Saving to disk…`;
      case 'paused':
        return `Paused at ${pct}% · ${fmtBytes(d.downloaded)}${d.size > 0 ? ` of ${fmtBytes(d.size)}` : ''}`;
      case 'done':
        return `${fmtBytes(d.downloaded)} · downloaded ✓`;
      case 'cancelled':
        return 'Cancelled';
      default:
        return d.error ?? 'Download failed';
    }
  };

  const showBar = d.status === 'downloading' || d.status === 'finalizing' || d.status === 'paused';

  return (
    <div className="px-4 py-3 bg-surface hover:bg-surface-2/30 transition-colors">
      <div className="flex items-center gap-2.5 text-[13px]">
        <Icon
          size={15}
          className={clsx(
            'shrink-0',
            d.status === 'done' && 'text-emerald-500',
            d.status === 'failed' && 'text-[var(--danger)]',
            d.status === 'paused' && 'text-amber-400',
            (d.status === 'downloading' || d.status === 'finalizing') && 'text-sky-400'
          )}
          style={d.status !== 'done' && d.status !== 'failed' && d.status !== 'paused' && d.status !== 'downloading' && d.status !== 'finalizing' ? { color: CATEGORY_COLORS[cat] } : undefined}
        />
        <span className="truncate flex-1 font-medium" title={d.name}>{d.name}</span>
        {d.status === 'downloading' && (
          <button className="icon-btn !w-6 !h-6" title="Pause download" onClick={() => pauseDownload(d.id)}>
            <Pause size={11} />
          </button>
        )}
        {d.status === 'paused' && (
          <button className="icon-btn !w-6 !h-6" title="Resume download" onClick={() => resumeDownload(d.id)}>
            <Play size={11} />
          </button>
        )}
        {(d.status === 'failed' || d.status === 'cancelled') && (
          <button className="icon-btn !w-6 !h-6" title="Retry download" onClick={() => retryDownload(d.id)}>
            <RotateCw size={11} />
          </button>
        )}
        {(d.status === 'downloading' || d.status === 'paused') && (
          <button className="icon-btn !w-6 !h-6 text-3 hover:text-[var(--danger)]" title="Cancel download" onClick={() => cancelDownload(d.id)}>
            <X size={11} />
          </button>
        )}
        {d.status === 'done' && d.isNative && (
          <div className="flex items-center gap-1 shrink-0">
            <button
              className="btn btn-primary !py-0.5 !px-2 !text-[10.5px] flex items-center gap-1 font-medium shadow-sm"
              title="Open file"
              onClick={() => void openDownloadedFile(d.id)}
            >
              <ExternalLink size={10} />
              <span>Open</span>
            </button>
            <button
              className="icon-btn !w-6 !h-6"
              title="Show in folder"
              onClick={() => void revealDownloadedFile(d.id)}
            >
              <FolderOpen size={11} />
            </button>
          </div>
        )}
        {['done', 'cancelled', 'failed'].includes(d.status) && (
          <button className="icon-btn !w-6 !h-6" title="Dismiss" onClick={() => useDownloads.getState().removeDownload(d.id)}>
            <X size={11} />
          </button>
        )}
      </div>

      {showBar && (
        <div className="bar mt-2">
          <i style={{ width: `${pct}%`, transition: 'width 150ms ease-out', background: d.status === 'paused' ? 'linear-gradient(90deg, #f59e0b, #d97706)' : d.status === 'finalizing' ? 'linear-gradient(90deg, #38bdf8, #34d399)' : 'linear-gradient(90deg, #38bdf8, #0ea5e9)' }} />
        </div>
      )}
      <div className="text-3 text-[11px] mt-1.5 truncate tabular-nums" title={downloadText()}>
        {downloadText()}
      </div>
    </div>
  );
}

function Steps({ t }: { t: UploadTask }) {
  const uploadDone = ['processing', 'done'].includes(t.status);
  const storeOn = t.status === 'processing';
  const ready = t.status === 'done';

  return (
    <div className="flex items-center gap-1.5 text-[10.5px] font-medium mt-2.5 select-none">
      <span
        className={clsx(
          'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[10px] border transition-colors',
          uploadDone
            ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30 font-semibold'
            : 'bg-sky-500/15 text-sky-400 border-sky-500/30 font-semibold'
        )}
      >
        <span
          className={clsx(
            'w-1.5 h-1.5 rounded-full shrink-0',
            uploadDone ? 'bg-emerald-400' : 'bg-sky-400 animate-pulse'
          )}
        />
        1. Staged
      </span>
      <span className="text-slate-500 text-xs font-bold">›</span>
      <span
        className={clsx(
          'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[10px] border transition-colors',
          ready
            ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30 font-semibold'
            : storeOn
            ? 'bg-sky-500/15 text-sky-400 border-sky-500/30 font-semibold'
            : 'bg-slate-800/80 text-slate-400 border-slate-700/60'
        )}
      >
        <span
          className={clsx(
            'w-1.5 h-1.5 rounded-full shrink-0',
            ready ? 'bg-emerald-400' : storeOn ? 'bg-sky-400 animate-pulse' : 'bg-slate-500'
          )}
        />
        2. Telegram storage
      </span>
      <span className="text-slate-500 text-xs font-bold">›</span>
      <span
        className={clsx(
          'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[10px] border transition-colors',
          ready
            ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30 font-semibold'
            : 'bg-slate-800/80 text-slate-400 border-slate-700/60'
        )}
      >
        <span
          className={clsx(
            'w-1.5 h-1.5 rounded-full shrink-0',
            ready ? 'bg-emerald-400' : 'bg-slate-500'
          )}
        />
        3. Ready
      </span>
    </div>
  );
}

function TaskRow({ t }: { t: UploadTask }) {
  const failed = ['failed', 'server-failed'].includes(t.status);
  const cat = categoryOf(t.name);
  const Icon = t.status === 'done' ? CheckCircle2 : failed ? AlertCircle : categoryIcon(cat);
  const pct = t.size ? Math.min(100, Math.round((t.uploaded / t.size) * 100)) : 100;

  const pickResume = () => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.onchange = () => {
      const f = inp.files?.[0];
      if (f && t.uploadId && t.fileId) {
        resumeServerUpload(
          { id: t.uploadId, fileId: t.fileId, name: t.name, size: t.size, clientKey: t.clientKey ?? clientKey({ name: t.name, size: t.size }) },
          f,
        );
      }
    };
    inp.click();
  };

  const clientText = (): string => {
    switch (t.status) {
      case 'queued':       return `Waiting · ${fmtBytes(t.size)}`;
      case 'creating':     return 'Preparing upload…';
      case 'uploading': {
        const speedText = t.speed > 0 ? `${fmtBytes(t.speed)}/s` : 'Buffering slices…';
        const partsText = t.partsTotal > 1 ? ` (Part ${Math.min(t.partsStored + 1, t.partsTotal)}/${t.partsTotal})` : '';
        return [`${fmtBytes(t.uploaded)} of ${fmtBytes(t.size)}${partsText}`, speedText, fmtEta(t.eta)].filter(Boolean).join(' · ');
      }
      case 'processing': {
        const speedText = t.speed > 0 ? `${fmtBytes(t.speed)}/s` : 'Connecting to Telegram…';
        return [`${fmtBytes(t.uploaded)} of ${fmtBytes(t.size)} · Telegram storage`, speedText, fmtEta(t.eta)].filter(Boolean).join(' · ');
      }
      case 'paused':       return t.noLocalFile ? `Interrupted at ${pct}% — select the same file to resume` : `Paused at ${pct}%`;
      case 'done':         return `${fmtBytes(t.size)} · saved to your drive ✓`;
      case 'cancelled':    return 'Cancelled';
      case 'server-failed': return t.error ?? 'Upload failed — retry or discard';
      default:             return t.error ?? 'Upload failed';
    }
  };

  return (
    <div className="px-4 py-3 bg-surface hover:bg-surface-2/30 transition-colors">
      <div className="flex items-center gap-2.5 text-[13px]">
        <Icon
          size={15}
          className={clsx('shrink-0', t.status === 'done' && 'text-emerald-500', failed && 'text-[var(--danger)]')}
          style={!failed && t.status !== 'done' ? { color: CATEGORY_COLORS[cat] } : undefined}
        />
        <span className="truncate flex-1 font-medium" title={t.name}>{t.name}</span>
          {t.native && <span className="px-1.5 py-px rounded text-[10px] font-semibold bg-accent/15 text-accent border border-accent/30 shrink-0">Native</span>}

        {/* Action buttons */}
        {t.status === 'uploading' && (
          <button className="icon-btn !w-6 !h-6" title="Pause" onClick={() => pauseUpload(t.key)}>
            <Pause size={11} />
          </button>
        )}
        {t.status === 'paused' && !t.noLocalFile && (
          <button className="icon-btn !w-6 !h-6" title="Resume" onClick={() => resumeUpload(t.key)}>
            <Play size={11} />
          </button>
        )}
        {t.status === 'paused' && t.noLocalFile && (
          <button className="btn !py-0.5 !px-2 text-xs" onClick={pickResume}>Select file</button>
        )}
        {failed && t.uploadId && (
          <button className="icon-btn !w-6 !h-6" title="Retry" onClick={() => void retryServerUpload(t.key)}>
            <RotateCw size={11} />
          </button>
        )}
        {failed && (
          <button className="icon-btn !w-6 !h-6" title="Discard" onClick={() => discardUpload(t.key)}>
            <X size={11} />
          </button>
        )}
        {LIVE.includes(t.status) && (
          <button className="icon-btn !w-6 !h-6 text-3 hover:text-[var(--danger)]" title="Cancel upload" onClick={() => void cancelUpload(t.key)}>
            <X size={11} />
          </button>
        )}
        {['done', 'cancelled'].includes(t.status) && (
          <button className="icon-btn !w-6 !h-6" title="Dismiss" onClick={() => useUploads.getState().remove(t.key)}>
            <X size={11} />
          </button>
        )}
      </div>

      {/* Progress */}
      {t.status === 'processing' && t.uploadId ? (
        <TelegramProgress t={t} />
      ) : (
        <>
          {LIVE.includes(t.status) && (
            <div className={clsx('bar mt-2', failed && 'danger')}>
              <i style={{ width: `${pct}%`, transition: 'width 200ms ease-out' }} />
            </div>
          )}
          <div className="text-3 text-[11px] mt-1.5 truncate tabular-nums" title={clientText()}>
            {clientText()}
          </div>
        </>
      )}
      {LIVE.includes(t.status) && <Steps t={t} />}
    </div>
  );
}

/** Phase 2: live per-part view of the server storing parts on your drive. */
function TelegramProgress({ t }: { t: UploadTask }) {
  const { data } = useQuery({
    queryKey: ['upload-progress', t.uploadId],
    queryFn: () => api.get<UploadProgress>(`/api/uploads/${t.uploadId}/progress`),
    refetchInterval: 600,
  });
  const now = useNow(400);

  const parts = Array.isArray(data?.parts) ? data.parts : [];
  const skew = ((data?.serverNow ?? Date.now()) - Date.now());
  const stored = parts.filter((p) => p.status === 'stored').length;
  const totalBytes = parts.reduce((a, p) => a + (p.size ?? 0), 0) || t.size || 1;
  let doneBytes = 0;
  let line = '';
  let activeSpeed = 0;

  const segments: Segment[] = parts.map((p) => {
    if (p.status === 'stored') {
      doneBytes += p.size ?? 0;
      return { size: p.size ?? 1, state: 'done', title: `Part ${p.idx + 1}: stored via @${p.botUsername ?? 'bot'}` };
    }
    if (p.status === 'failed') {
      const retryIn = p.nextAttemptAt ? Math.max(0, Math.round((p.nextAttemptAt - (now + skew)) / 1000)) : null;
      line ||= `Part ${p.idx + 1} failed${retryIn != null ? ` · retrying in ${retryIn}s` : ''}`;
      return { size: p.size ?? 1, state: 'failed', title: p.lastError ?? 'failed' };
    }
    if (p.phase === 'sending') {
      const { fraction, etaSec } = estimateTransfer(p.startedAt, p.estRate, p.size, now, skew);
      const estPartBytes = (p.size ?? 0) * (fraction ?? 0);
      doneBytes += estPartBytes;
      const rate = p.estRate && p.estRate > 0 ? p.estRate : 3.5 * 1024 * 1024;
      activeSpeed += rate;
      const fracText = fraction != null ? `~${Math.round(fraction * 100)}%` : '';
      const rateText = rate > 0 ? ` · ${fmtBytes(rate)}/s` : '';
      const etaText = etaSec != null && etaSec > 0 ? ` · ${fmtEta(etaSec)}` : '';
      const elapsedSec = p.startedAt ? Math.max(0, Math.round((now + skew - p.startedAt) / 1000)) : 0;
      line ||= `Part ${p.idx + 1}/${parts.length} → @${p.botUsername ?? 'bot'} · ${fracText}${rateText}${etaText} (${elapsedSec}s elapsed)`;
      return { size: p.size ?? 1, state: 'active', fraction, title: `Sending part ${p.idx + 1} (${elapsedSec}s)` };
    }
    return { size: p.size ?? 1, state: 'pending' };
  });

  const sendingParts = parts.filter((p) => p.phase === 'sending');
  if (sendingParts.length > 1) {
    const elapsedMax = Math.max(0, ...sendingParts.map((p) => p.startedAt ? Math.round((now + skew - p.startedAt) / 1000) : 0));
    const etaTotal = activeSpeed > 0 ? Math.ceil(Math.max(0, totalBytes - doneBytes) / activeSpeed) : 0;
    line = `${sendingParts.length} bots uploading in parallel · ${fmtBytes(activeSpeed)}/s${etaTotal > 0 ? ` · ${fmtEta(etaTotal)}` : ''} (${elapsedMax}s elapsed)`;
  }

  const pct = totalBytes ? (stored === parts.length && parts.length > 0 ? 100 : Math.min(99, Math.round((doneBytes / totalBytes) * 100))) : 0;

  if (!data) {
    return (
      <div className="mt-2">
        <div className="seg-bar"><div className="seg seg-working" style={{ flexGrow: 1 }} /></div>
        <div className="text-3 text-[11px] mt-1.5">Connecting to Telegram cloud…</div>
      </div>
    );
  }

  return (
    <>
      <PartSegments segments={segments} className="mt-2" />
      <div className="text-3 text-[11px] mt-1.5 truncate tabular-nums font-medium text-sky-400" title={line}>
        {line || `${stored}/${parts.length} parts stored`}
      </div>
      <div className="text-3 text-[10.5px] tabular-nums mt-0.5 text-slate-400">
        {stored}/{parts.length} parts stored · {pct}% · multi-bot parallel dispatch
      </div>
    </>
  );
}
