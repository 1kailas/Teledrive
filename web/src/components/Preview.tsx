import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowLeft, ChevronLeft, ChevronRight, Download, Share2, Save, FileCode, FileText,
  ZoomIn, ZoomOut, Maximize, X,
} from 'lucide-react';
import { usePreview, useDialog, useUi, toast } from '../store';
import { startDownload } from '../download';
import type { FileDTO } from '../api';
import { fmtBytes, isTextEditable, cmLanguageExt, CATEGORY_COLORS, categoryIcon } from '../utils';
import { useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Thumb, Spinner } from './ui';
import { CinemaPlayer } from './CinemaPlayer';

const CodeMirror = lazy(() => import('@uiw/react-codemirror'));
const langs = {
  javascript: () => import('@codemirror/lang-javascript').then((m) => m.javascript()),
  python: () => import('@codemirror/lang-python').then((m) => m.python()),
  markdown: () => import('@codemirror/lang-markdown').then((m) => m.markdown()),
};

export function PreviewOverlay({ publicBase }: { publicBase?: string }) {
  const { files, index, open, close, nav } = usePreview();
  const desktopMode = useUi((s) => s.desktopMode);
  const [zoomCtl, setZoomCtl] = useState<{ z: number } | null>(null);
  const file = files[index];
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
      if (e.key === 'ArrowLeft') nav(-1);
      if (e.key === 'ArrowRight') nav(1);
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, close, nav]);
  if (!open || !file) return null;
  const contentUrl = publicBase
    ? `${publicBase}/files/${file.id}/content`
    : `/api/files/${file.id}/content`;

  const hasPrev = index > 0;
  const hasNext = index < files.length - 1;

  return createPortal(
    <div className="preview-backdrop" role="dialog" aria-modal="true" aria-label={`Preview ${file.name}`}>
      {/* ── Toolbar ── */}
      <div className="pv-toolbar">
        {/* Google Drive style Back button */}
        <button className="pv-back-btn" onClick={close} aria-label="Back to Drive">
          <ArrowLeft size={16} />
          <span>Back to Drive</span>
        </button>

        <div className="w-[1px] h-5 bg-white/20 mx-2" />

        {/* File name */}
        <div className="min-w-0 flex-1 px-1">
          <div className="font-semibold text-sm truncate text-white" title={file.name}>{file.name}</div>
          <div className="text-[11px] text-white/60 tabular-nums">{fmtBytes(file.size)} · {index + 1} of {files.length}</div>
        </div>

        {/* Zoom controls for images */}
        {file.category === 'image' && (
          <span className="flex items-center gap-0.5 mr-1">
            <button className="pv-btn" title="Zoom out" onClick={() => setZoomCtl({ z: Math.random() * -1 - 1 })}><ZoomOut size={16} /></button>
            <button className="pv-btn" title="Fit to screen" onClick={() => setZoomCtl({ z: 0.5 + Math.random() })}><Maximize size={15} /></button>
            <button className="pv-btn" title="Zoom in" onClick={() => setZoomCtl({ z: Math.random() * 1 + 1 })}><ZoomIn size={16} /></button>
          </span>
        )}

        <div className="w-[1px] h-5 bg-white/20 mx-1" />

        {/* Prev / Next */}
        <button className="pv-btn" onClick={() => nav(-1)} disabled={!hasPrev} title="Previous (←)"><ChevronLeft size={18} /></button>
        <button className="pv-btn" onClick={() => nav(1)} disabled={!hasNext} title="Next (→)"><ChevronRight size={18} /></button>

        <div className="w-[1px] h-5 bg-white/20 mx-1" />

        {/* Download */}
        <button className="btn btn-primary !py-1 !px-2.5 !text-xs !text-white flex items-center gap-1.5" onClick={() => void startDownload(file)}>
          <Download size={14} /> <span>Download</span>
        </button>

        {/* Share */}
        {!publicBase && !desktopMode && (
          <button className="pv-btn" title="Share" onClick={() => useDialog.getState().open({ kind: 'share', fileId: file.id, name: file.name })}>
            <Share2 size={15} />
          </button>
        )}

        {/* Explicit close X */}
        <button className="pv-btn ml-1" onClick={close} title="Close (Esc)" aria-label="Close">
          <X size={18} />
        </button>
      </div>

      {/* ── Content area ── */}
      <div className="relative flex-1 overflow-hidden">
        {/* Edge nav hit zones */}
        {hasPrev && (
          <div className="pv-hit left-0 justify-start" onClick={() => nav(-1)}>
            <span><ChevronLeft size={22} /></span>
          </div>
        )}
        {hasNext && (
          <div className="pv-hit right-0 justify-end" onClick={() => nav(1)}>
            <span><ChevronRight size={22} /></span>
          </div>
        )}
        <PreviewBody file={file} contentUrl={contentUrl} publicMode={!!publicBase} zoomCtl={zoomCtl} />
      </div>
    </div>,
    document.body,
  );
}

function PreviewBody({ file, contentUrl, publicMode, zoomCtl }: {
  file: FileDTO; contentUrl: string; publicMode: boolean; zoomCtl: { z: number } | null;
}) {
  const qc = useQueryClient();
  if (file.status === 'processing' || file.status === 'uploading') {
    return (
      <div className="h-full flex items-center justify-center text-white/70">
        <div className="text-center space-y-3">
          <Spinner size={28} className="mx-auto" />
          <p className="text-sm">Still being stored in Telegram…</p>
          <p className="text-xs text-white/40">Safe to leave this open</p>
        </div>
      </div>
    );
  }
  switch (file.category) {
    case 'image': return <ImageView file={file} contentUrl={contentUrl} zoomCtl={zoomCtl} />;
    case 'video':
      return (
        <div className="h-full w-full flex items-center justify-center p-2 sm:p-4">
          <div className="w-full h-full max-w-6xl max-h-[85vh] rounded-2xl overflow-hidden shadow-2xl border border-white/10">
            <CinemaPlayer file={file} contentUrl={contentUrl} poster={file.thumbnailUrl ?? undefined} />
          </div>
        </div>
      );
    case 'audio':
      return (
        <div className="h-full flex items-center justify-center">
          <div className="rounded-2xl p-8 flex flex-col items-center gap-5 w-80"
            style={{ background: 'rgba(255,255,255,.06)', border: '1px solid rgba(255,255,255,.1)' }}>
            {file.hasThumbnail
              ? <Thumb file={file} className="w-44 h-44 rounded-2xl shadow-2xl" />
              : <div className="h-44 w-44 rounded-2xl flex items-center justify-center text-5xl"
                  style={{ background: 'rgba(255,255,255,.08)' }}>♪</div>}
            <div className="font-medium text-sm text-center text-white/90">{file.name}</div>
            <audio src={contentUrl} controls className="w-full" />
          </div>
        </div>
      );
    case 'document':
      if (file.mimeType === 'application/pdf') {
        return (
          <div className="w-full h-full flex flex-col">
            {/* PDF is rendered in an iframe; use the browser's native viewer */}
            <iframe
              src={contentUrl}
              title={file.name}
              className="w-full flex-1"
              style={{ border: 'none', background: '#fff' }}
            />
          </div>
        );
      }
      if (isTextEditable(file) && file.size <= 10 * 1024 * 1024)
        return <TextView file={file} contentUrl={contentUrl} publicMode={publicMode} qc={qc} />;
      return <NoPreview file={file} />;
    case 'code':
      return <TextView file={file} contentUrl={contentUrl} publicMode={publicMode} qc={qc} />;
    default:
      if (isTextEditable(file) && file.size <= 10 * 1024 * 1024)
        return <TextView file={file} contentUrl={contentUrl} publicMode={publicMode} qc={qc} />;
      return <NoPreview file={file} />;
  }
}

function ImageView({ file, contentUrl, zoomCtl }: { file: FileDTO; contentUrl: string; zoomCtl: { z: number } | null }) {
  const ref = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  useEffect(() => { setZoom(1); setPan({ x: 0, y: 0 }); }, [file.id]);
  useEffect(() => {
    if (!zoomCtl) return;
    const v = zoomCtl.z;
    if (Math.abs(v) < 1) { setZoom(1); setPan({ x: 0, y: 0 }); }
    else setZoom((z) => Math.min(8, Math.max(1, z * (v > 0 ? 1.25 : 0.8))));
  }, [zoomCtl]);
  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    setZoom((z) => {
      const nz = Math.min(8, Math.max(1, z * (e.deltaY < 0 ? 1.15 : 0.87)));
      if (nz === 1) setPan({ x: 0, y: 0 });
      return nz;
    });
  };
  return (
    <div ref={ref} className="h-full w-full overflow-hidden flex items-center justify-center select-none"
      style={{ cursor: zoom > 1 ? 'grab' : 'default' }}
      onWheel={onWheel}
      onDoubleClick={() => { setZoom((z) => (z > 1 ? 1 : Math.min(2, z * 2))); if (zoom > 1) setPan({ x: 0, y: 0 }); }}
      onPointerDown={(e) => { if (zoom > 1) { drag.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y }; (e.target as HTMLElement).setPointerCapture?.(e.pointerId); } }}
      onPointerMove={(e) => { if (drag.current) setPan({ x: drag.current.px + e.clientX - drag.current.x, y: drag.current.py + e.clientY - drag.current.y }); }}
      onPointerUp={() => { drag.current = null; }}>
      <img src={contentUrl} alt={file.name} draggable={false}
        style={{
          transform: `translate(${pan.x}px,${pan.y}px) scale(${zoom})`,
          transition: drag.current ? 'none' : 'transform .12s ease-out',
          maxWidth: '100%', maxHeight: '100%',
          width: file.width && (ref.current?.clientWidth ?? 0) > file.width * 4 ? file.width * 4 : 'auto',
        }}
        className="object-contain" />
    </div>
  );
}

function NoPreview({ file }: { file: FileDTO }) {
  const Icon = categoryIcon(file.category);
  return (
    <div className="h-full flex items-center justify-center p-6">
      <div className="text-center w-72 space-y-4" style={{ color: '#e7eaf0' }}>
        <div className="mx-auto h-24 w-24 rounded-2xl flex items-center justify-center"
          style={{ background: 'rgba(255,255,255,.07)' }}>
          <Icon size={44} style={{ color: CATEGORY_COLORS[file.category] }} />
        </div>
        <div>
          <div className="font-semibold text-base mb-1">{file.name}</div>
          <div className="text-sm" style={{ color: 'rgba(255,255,255,.45)' }}>{fmtBytes(file.size)}</div>
          <div className="text-sm mt-1" style={{ color: 'rgba(255,255,255,.35)' }}>No preview available for this file type</div>
        </div>
        <button className="btn btn-primary inline-flex mx-auto" onClick={() => void startDownload(file)}>
          <Download size={15} /> Download file
        </button>
      </div>
    </div>
  );
}

function TextView({ file, contentUrl, publicMode, qc }: {
  file: FileDTO; contentUrl: string; publicMode: boolean; qc: ReturnType<typeof useQueryClient>;
}) {
  const [text, setText] = useState<string | null>(null);
  const [edit, setEdit] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [mdMode, setMdMode] = useState<'rendered' | 'raw'>('rendered');
  const [extensions, setExtensions] = useState<unknown[]>([]);
  const theme = useUi((s) => s.theme);
  const isMd = ['md', 'markdown'].includes(file.extension);
  useEffect(() => {
    setText(null); setEdit(null); setDirty(false);
    void fetch(contentUrl).then((r) => r.text()).then(setText).catch(() => setText(''));
    const wanted = cmLanguageExt(file.extension);
    void Promise.all(wanted.map((l) => langs[l as keyof typeof langs]())).then(setExtensions).catch(() => setExtensions([]));
  }, [contentUrl, file.extension]);
  const editing = edit !== null;
  useEffect(() => {
    if (!editing) return;
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); void saveRef.current(); }
    };
    document.addEventListener('keydown', h, true);
    return () => document.removeEventListener('keydown', h, true);
  }, [editing]);
  const saveRef = useRef<() => void>(() => {});
  const save = async () => {
    if (edit === null) return;
    try {
      const r = await fetch(`/api/files/${file.id}/text`, {
        method: 'PUT', headers: { 'content-type': 'text/plain', 'x-requested-with': 'teledrive' }, body: edit,
      });
      if (!r.ok) throw new Error(String(r.status));
      setText(edit); setDirty(false); toast.success('Saved');
      void qc.invalidateQueries({ queryKey: ['file', file.id] });
    } catch { toast.error('Save failed'); }
  };
  saveRef.current = save;
  if (text === null) return <div className="h-full flex items-center justify-center"><Spinner size={24} className="text-white" /></div>;
  const ext = [...extensions] as never[];
  const dark = theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  return (
    <div className="h-full flex items-center justify-center p-4">
      <div className="rounded-xl w-[min(92vw,900px)] h-full flex flex-col overflow-hidden"
        style={{ background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.1)' }}
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 px-3 py-2 text-xs" style={{ borderBottom: '1px solid rgba(255,255,255,.08)' }}>
          <span style={{ color: 'rgba(255,255,255,.55)' }} className="font-mono">{file.name}</span>
          {dirty && <span className="h-1.5 w-1.5 rounded-full bg-amber-400" title="Unsaved changes" />}
          {isMd && !editing && (
            <div className="ml-auto flex gap-1">
              <button className={clsx('btn !py-1 !px-2 text-xs', mdMode === 'rendered' && 'accent-bg accent')} onClick={() => setMdMode('rendered')}>
                <FileText size={12} />Preview
              </button>
              <button className={clsx('btn !py-1 !px-2 text-xs', mdMode === 'raw' && 'accent-bg accent')} onClick={() => setMdMode('raw')}>
                <FileCode size={12} />Raw
              </button>
            </div>
          )}
          {!publicMode && !editing && <button className="btn !py-1 !px-2 text-xs ml-auto" onClick={() => setEdit(text)}>Edit</button>}
          {editing && (
            <div className="ml-auto flex gap-1.5">
              <button className="btn !py-1 !px-2 text-xs" onClick={() => { if (!dirty || confirm('Discard unsaved changes?')) { setEdit(null); setDirty(false); } }}>Close</button>
              <button className="btn btn-primary !py-1 !px-2 text-xs" onClick={() => void save()}><Save size={12} />Save</button>
            </div>
          )}
        </div>
        <div className="flex-1 overflow-auto">
          {editing ? (
            <Suspense fallback={<div className="p-6"><Spinner /></div>}>
              <CodeMirror value={edit} height="100%" theme={dark ? 'dark' : 'light'} extensions={ext}
                onChange={(v) => { setEdit(v); setDirty(true); }} />
            </Suspense>
          ) : isMd && mdMode === 'rendered' ? (
            <MarkdownView text={text} />
          ) : (
            <Suspense fallback={<div className="p-6"><Spinner /></div>}>
              <CodeMirror value={text} height="100%" theme={dark ? 'dark' : 'light'} extensions={ext} readOnly editable={false} />
            </Suspense>
          )}
        </div>
      </div>
    </div>
  );
}

function MarkdownView({ text }: { text: string }) {
  const [html, setHtml] = useState('');
  useEffect(() => {
    void Promise.all([import('marked'), import('dompurify')]).then(([m, d]) => {
      setHtml(d.default.sanitize(m.marked.parse(text, { async: false }) as string));
    });
  }, [text]);
  return (
    <div className="p-6 max-w-none text-sm text-white/85 [&_pre]:bg-white/10 [&_pre]:p-3 [&_pre]:rounded-lg [&_pre]:overflow-auto [&_code]:text-[0.9em] [&_h1]:text-xl [&_h1]:font-semibold [&_h1]:mb-3 [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:mb-2 [&_h3]:text-base [&_h3]:font-semibold [&_a]:text-indigo-300 [&_a]:underline [&_img]:max-w-full [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_table]:border-collapse [&_td]:border [&_td]:border-white/20 [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-white/20 [&_th]:px-2 [&_th]:py-1 [&_blockquote]:border-l-2 [&_blockquote]:border-white/20 [&_blockquote]:pl-3 [&_blockquote]:text-white/50"
      dangerouslySetInnerHTML={{ __html: html }} />
  );
}
