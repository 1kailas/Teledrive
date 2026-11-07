import { useState } from 'react';
import clsx from 'clsx';
import {
  FileText, Music, Play, AppWindow, Archive, FileSpreadsheet,
  FileCode, Presentation, File,
} from 'lucide-react';
import type { FileDTO } from '../api';

interface WindowsPreviewProps {
  file: FileDTO;
  big?: boolean;
  className?: string;
}

type FileGroup =
  | 'pdf'
  | 'word'
  | 'excel'
  | 'powerpoint'
  | 'text'
  | 'code'
  | 'audio'
  | 'video'
  | 'archive'
  | 'executable'
  | 'image'
  | 'generic';

export function getFileGroup(ext: string, category: string): FileGroup {
  const e = (ext || '').toLowerCase();
  if (e === 'pdf') return 'pdf';
  if (['doc', 'docx', 'odt', 'rtf'].includes(e)) return 'word';
  if (['xls', 'xlsx', 'csv', 'ods', 'tsv'].includes(e)) return 'excel';
  if (['ppt', 'pptx', 'odp', 'key'].includes(e)) return 'powerpoint';
  if (['txt', 'log', 'md', 'markdown', 'rtf', 'tex'].includes(e)) return 'text';
  if (
    ['js', 'ts', 'jsx', 'tsx', 'py', 'html', 'css', 'json', 'sql', 'sh', 'bash', 'zsh', 'rs', 'go', 'c', 'cpp', 'h', 'hpp', 'java', 'kt', 'rb', 'php', 'swift', 'yaml', 'yml', 'xml', 'toml', 'env'].includes(e) ||
    category === 'code'
  ) return 'code';
  if (category === 'audio' || ['mp3', 'wav', 'flac', 'm4a', 'ogg', 'aac', 'wma', 'opus', 'alac'].includes(e)) return 'audio';
  if (category === 'video' || ['mp4', 'mkv', 'webm', 'mov', 'avi', 'flv', 'wmv', 'm4v', '3gp'].includes(e)) return 'video';
  if (category === 'archive' || ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'iso', 'dmg'].includes(e)) return 'archive';
  if (['exe', 'msi', 'deb', 'rpm', 'apk', 'app', 'bat', 'cmd', 'ps1', 'vbs'].includes(e)) return 'executable';
  if (category === 'image' || ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico', 'tiff', 'heic'].includes(e)) return 'image';
  return 'generic';
}

interface GroupMeta {
  icon: React.ComponentType<{ size?: number; className?: string; strokeWidth?: number; color?: string; style?: React.CSSProperties }>;
  accentColor: string;
  label: string;
}

const META: Record<FileGroup, GroupMeta> = {
  pdf: {
    icon: FileText,
    accentColor: '#ef4444',
    label: 'PDF',
  },
  word: {
    icon: FileText,
    accentColor: '#3b82f6',
    label: 'DOC',
  },
  excel: {
    icon: FileSpreadsheet,
    accentColor: '#10b981',
    label: 'XLSX',
  },
  powerpoint: {
    icon: Presentation,
    accentColor: '#f97316',
    label: 'PPT',
  },
  text: {
    icon: FileText,
    accentColor: '#94a3b8',
    label: 'TXT',
  },
  code: {
    icon: FileCode,
    accentColor: '#38bdf8',
    label: 'CODE',
  },
  audio: {
    icon: Music,
    accentColor: '#a855f7',
    label: 'AUDIO',
  },
  video: {
    icon: Play,
    accentColor: '#f59e0b',
    label: 'VIDEO',
  },
  archive: {
    icon: Archive,
    accentColor: '#f59e0b',
    label: 'ZIP',
  },
  executable: {
    icon: AppWindow,
    accentColor: '#0284c7',
    label: 'APP',
  },
  image: {
    icon: File,
    accentColor: '#10b981',
    label: 'IMG',
  },
  generic: {
    icon: File,
    accentColor: '#94a3b8',
    label: 'FILE',
  },
};

export function WindowsPreview({ file, big, className }: WindowsPreviewProps) {
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState(false);
  const ext = (file.extension || '').toUpperCase() || 'FILE';
  const group = getFileGroup(file.extension, file.category);
  const meta = META[group];
  const thumbUrl = file.thumbnailUrl;
  const showImg = !!thumbUrl && !err;

  // ── Small Icon for List View ──
  if (!big) {
    if (showImg) {
      return (
        <div className={clsx('relative overflow-hidden flex items-center justify-center rounded bg-surface-2 border border-app shrink-0', className)}>
          {!loaded && <div className="absolute inset-0 skel" />}
          <img
            src={thumbUrl!}
            alt=""
            loading="lazy"
            draggable={false}
            className={clsx('w-full h-full object-cover transition-opacity duration-150', loaded ? 'opacity-100' : 'opacity-0')}
            onLoad={() => setLoaded(true)}
            onError={() => setErr(true)}
          />
        </div>
      );
    }

    const Icon = meta.icon;
    return (
      <div
        className={clsx('relative flex items-center justify-center shrink-0 select-none', className)}
        title={`${file.name} (${ext})`}
      >
        <Icon size={16} style={{ color: meta.accentColor }} strokeWidth={2} />
      </div>
    );
  }

  // ── Big Card Preview for Grid View ──

  // 1. Real Image/Document/Video Thumbnail (from disk or server)
  if (showImg) {
    return (
      <div className={clsx('relative w-full h-full flex items-center justify-center p-2.5 overflow-hidden select-none bg-surface-2', className)}>
        {!loaded && <div className="absolute inset-0 skel" />}
        <img
          src={thumbUrl!}
          alt={file.name}
          loading="lazy"
          draggable={false}
          className={clsx('max-w-full max-h-full object-contain rounded transition-opacity duration-150 shadow-sm', loaded ? 'opacity-100' : 'opacity-0')}
          onLoad={() => setLoaded(true)}
          onError={() => setErr(true)}
        />
      </div>
    );
  }

  // 2. Realistic Document Sheet & Native Previews (Zero "Neo" artifacts, 100% Authentic Content Feel)

  // (A) PDF Document Sheet Thumbnail
  if (group === 'pdf') {
    return (
      <div className={clsx('relative w-full h-full flex items-center justify-center p-3 select-none bg-surface-2', className)}>
        <div className="w-24 h-32 rounded bg-[#f8fafc] text-slate-800 shadow-md border border-slate-300/60 relative overflow-hidden flex flex-col p-2.5">
          <div className="absolute top-0 right-0 w-3.5 h-3.5 bg-slate-300 rounded-bl shadow-2xs" />
          <div className="w-7 h-4 rounded-xs bg-[#ea4335] flex items-center justify-center text-[8px] font-bold text-white tracking-wider mb-2 shrink-0">
            PDF
          </div>
          <div className="h-2 w-3/4 bg-slate-400/80 rounded-xs mb-2 shrink-0" />
          <div className="space-y-1.5 opacity-60">
            <div className="h-1.5 w-full bg-slate-300 rounded-xs" />
            <div className="h-1.5 w-11/12 bg-slate-300 rounded-xs" />
            <div className="h-1.5 w-4/5 bg-slate-300 rounded-xs" />
          </div>
          <div className="space-y-1.5 mt-2 opacity-50">
            <div className="h-1.5 w-full bg-slate-300 rounded-xs" />
            <div className="h-1.5 w-3/5 bg-slate-300 rounded-xs" />
          </div>
          <div className="mt-auto pt-1 flex items-center justify-between opacity-40">
            <div className="h-1 w-6 bg-slate-400 rounded-xs" />
            <div className="h-1 w-4 bg-slate-400 rounded-xs" />
          </div>
        </div>
      </div>
    );
  }

  // (B) Word / Text Document Sheet Thumbnail
  if (group === 'word' || group === 'text') {
    const isDoc = group === 'word';
    const tagBg = isDoc ? 'bg-[#3b82f6]' : 'bg-[#64748b]';
    const tagText = isDoc ? 'DOC' : 'TXT';
    return (
      <div className={clsx('relative w-full h-full flex items-center justify-center p-3 select-none bg-surface-2', className)}>
        <div className="w-24 h-32 rounded bg-[#f8fafc] text-slate-800 shadow-md border border-slate-300/60 relative overflow-hidden flex flex-col p-2.5">
          <div className="absolute top-0 right-0 w-3.5 h-3.5 bg-slate-300 rounded-bl shadow-2xs" />
          <div className={`w-7 h-4 rounded-xs ${tagBg} flex items-center justify-center text-[8px] font-bold text-white tracking-wider mb-2 shrink-0`}>
            {tagText}
          </div>
          <div className="h-2 w-3/4 bg-slate-400/80 rounded-xs mb-2 shrink-0" />
          <div className="space-y-1.5 opacity-60">
            <div className="h-1.5 w-full bg-slate-300 rounded-xs" />
            <div className="h-1.5 w-11/12 bg-slate-300 rounded-xs" />
            <div className="h-1.5 w-4/5 bg-slate-300 rounded-xs" />
          </div>
          <div className="space-y-1.5 mt-2 opacity-50">
            <div className="h-1.5 w-full bg-slate-300 rounded-xs" />
            <div className="h-1.5 w-3/5 bg-slate-300 rounded-xs" />
          </div>
        </div>
      </div>
    );
  }

  // (C) Excel Spreadsheet Thumbnail
  if (group === 'excel') {
    return (
      <div className={clsx('relative w-full h-full flex items-center justify-center p-3 select-none bg-surface-2', className)}>
        <div className="w-26 h-32 rounded bg-[#f8fafc] text-slate-800 shadow-md border border-slate-300/60 relative overflow-hidden flex flex-col p-2.5">
          <div className="absolute top-0 right-0 w-3.5 h-3.5 bg-slate-300 rounded-bl shadow-2xs" />
          <div className="w-7 h-4 rounded-xs bg-[#10b981] flex items-center justify-center text-[8px] font-bold text-white tracking-wider mb-2 shrink-0">
            XLS
          </div>
          {/* Mini Table Grid */}
          <div className="border border-slate-300 rounded-xs overflow-hidden flex-1 flex flex-col text-[7px] text-slate-500">
            <div className="grid grid-cols-3 bg-emerald-100/70 border-b border-slate-300 py-0.5 text-center font-bold text-emerald-800">
              <div>A</div><div>B</div><div>C</div>
            </div>
            <div className="grid grid-cols-3 border-b border-slate-200 py-0.5 px-1 opacity-70">
              <div className="h-1 bg-slate-300 rounded-xs my-0.5" /><div className="h-1 bg-slate-300 rounded-xs my-0.5" /><div className="h-1 bg-slate-300 rounded-xs my-0.5" />
            </div>
            <div className="grid grid-cols-3 border-b border-slate-200 py-0.5 px-1 opacity-70">
              <div className="h-1 bg-slate-300 rounded-xs my-0.5" /><div className="h-1 bg-slate-300 rounded-xs my-0.5" /><div className="h-1 bg-slate-300 rounded-xs my-0.5" />
            </div>
            <div className="grid grid-cols-3 py-0.5 px-1 opacity-70">
              <div className="h-1 bg-slate-300 rounded-xs my-0.5" /><div className="h-1 bg-slate-300 rounded-xs my-0.5" /><div className="h-1 bg-slate-300 rounded-xs my-0.5" />
            </div>
          </div>
        </div>
      </div>
    );
  }

  // (D) Windows Desktop Executable / Application Window Preview
  if (group === 'executable') {
    const cleanName = file.name.replace(/\.(exe|msi|app|bat|cmd)$/i, '');
    return (
      <div className={clsx('relative w-full h-full flex items-center justify-center p-3 select-none bg-surface-2', className)}>
        <div className="w-28 h-24 rounded-lg bg-surface border border-app shadow-md flex flex-col overflow-hidden">
          <div className="h-5 px-2 bg-surface-2 border-b border-app flex items-center justify-between">
            <div className="flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-slate-400 opacity-60" />
              <span className="w-1.5 h-1.5 rounded-full bg-slate-400 opacity-60" />
              <span className="w-1.5 h-1.5 rounded-full bg-slate-400 opacity-60" />
            </div>
            <span className="text-[8.5px] font-mono text-3 tracking-wider uppercase">{ext.slice(0, 3)}</span>
          </div>
          <div className="flex-1 flex flex-col items-center justify-center p-2 bg-surface">
            <div className="w-8 h-8 rounded-lg bg-sky-500/15 flex items-center justify-center text-sky-400 mb-1">
              <AppWindow size={18} />
            </div>
            <span className="text-[10px] font-semibold text-text truncate max-w-[90px]">{cleanName}</span>
            <span className="text-[8.5px] text-3">Windows App</span>
          </div>
        </div>
      </div>
    );
  }

  // (E) Code File Editor Snapshot
  if (group === 'code') {
    return (
      <div className={clsx('relative w-full h-full flex items-center justify-center p-3 select-none bg-surface-2', className)}>
        <div className="w-28 h-24 rounded-lg bg-[#181a1f] border border-white/10 shadow-md flex flex-col overflow-hidden p-2 font-mono text-[9px] text-slate-300">
          <div className="flex items-center gap-1 mb-1.5 opacity-60">
            <span className="w-1.5 h-1.5 rounded-full bg-rose-400" />
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
          </div>
          <div className="space-y-1">
            <div className="truncate"><span className="text-purple-400">export</span> <span className="text-sky-300">const</span></div>
            <div className="truncate pl-1.5"><span className="text-emerald-400">config</span> = &#123; ... &#125;;</div>
            <div className="truncate text-3 opacity-60">// {file.name}</div>
          </div>
        </div>
      </div>
    );
  }

  // (F) Default / Generic Clean File Card
  const Icon = meta.icon;
  return (
    <div className={clsx('relative w-full h-full flex items-center justify-center p-3 select-none bg-surface-2', className)}>
      <div className="w-24 h-28 rounded-lg bg-surface border border-app shadow-sm flex flex-col items-center justify-center p-3">
        <Icon size={28} style={{ color: meta.accentColor }} strokeWidth={1.75} />
        <span className="text-[9px] font-mono text-3 tracking-wider uppercase mt-2 font-semibold">
          {ext.length > 5 ? ext.slice(0, 4) : ext}
        </span>
      </div>
    </div>
  );
}
