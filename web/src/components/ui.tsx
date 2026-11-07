import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X, Star, Loader2, CheckCircle2, AlertCircle, Info } from 'lucide-react';
import clsx from 'clsx';
import { useToasts } from '../store';
import { categoryIcon, CATEGORY_COLORS, FolderIcon } from '../utils';
import type { FileDTO } from '../api';
import { WindowsPreview } from './WindowsPreview';

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const first = ref.current?.querySelector<HTMLElement>('input,select,textarea,button:not([data-x])');
    first?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label={title}
        className={clsx('surface shadow-overlay rounded-xl border border-app w-full fadein', wide ? 'max-w-2xl' : 'max-w-md')}>
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-app">
          <h2 className="font-semibold text-[15px]">{title}</h2>
          <button className="icon-btn" data-x onClick={onClose} aria-label="Close" title="Close"><X size={17} /></button>
        </div>
        <div className="px-5 py-4">{children}</div>
      </div>
    </div>, document.body);
}

export function Spinner({ size = 16, className }: { size?: number; className?: string }) {
  return <Loader2 size={size} className={clsx('animate-spin', className)} />;
}

const EXT_COLORS: Record<string, string> = {
  pdf: '#dc2626', doc: '#185abd', docx: '#185abd',
  xls: '#107c41', xlsx: '#107c41', csv: '#107c41',
  ppt: '#c43e1c', pptx: '#c43e1c',
  zip: '#d97706', rar: '#d97706', '7z': '#d97706',
  exe: '#2563eb', msi: '#2563eb',
};

export function FileTypeIcon({ category, ext, size = 22, className }: { category?: string; ext?: string; size?: number; className?: string }) {
  const Icon = categoryIcon(category ?? 'other');
  const e = (ext || '').toLowerCase();
  const color = EXT_COLORS[e] ?? CATEGORY_COLORS[category ?? 'other'] ?? '#6b7280';
  return <Icon size={size} style={{ color }} className={className} aria-hidden />;
}

export function Thumb({ file, className, big }: { file: FileDTO; className?: string; big?: boolean }) {
  return <WindowsPreview file={file} big={big} className={className} />;
}

export function StarBadge({ show }: { show: boolean }) {
  return show ? <Star size={13} className="fill-amber-400 text-amber-400 shrink-0" /> : null;
}

export function EmptyState({ icon: Icon, title, body, action }: { icon: React.ComponentType<{ size?: number; className?: string }>; title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <Icon size={44} className="text-3 mb-4" />
      <div className="font-medium text-[15px]">{title}</div>
      {body && <div className="text-2 text-sm mt-1.5 max-w-sm">{body}</div>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function Toasts() {
  const { toasts, dismiss } = useToasts();
  return createPortal(
    <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-[90] flex flex-col gap-2 items-center max-w-[92vw]">
      {toasts.map((t) => (
        <div key={t.id} className={clsx('toast fadein', t.kind)} role="status">
          {t.kind === 'success' ? <CheckCircle2 size={16} className="t-icon" /> : t.kind === 'error' ? <AlertCircle size={16} className="t-icon" /> : <Info size={16} className="t-icon" />}
          <span className="break-words">{t.text}</span>
          <button className="icon-btn !w-6 !h-6 -mr-1" onClick={() => dismiss(t.id)} aria-label="Dismiss"><X size={13} /></button>
        </div>
      ))}
    </div>, document.body);
}

export { FolderIcon };
