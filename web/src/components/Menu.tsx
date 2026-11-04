import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import clsx from 'clsx';

export interface MenuItem { label: string; icon?: ReactNode; danger?: boolean; onClick: () => void; divider?: boolean }

export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: (MenuItem | null)[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('mousedown', close, true);
    window.addEventListener('keydown', key, true);
    window.addEventListener('blur', onClose);
    return () => { window.removeEventListener('mousedown', close, true); window.removeEventListener('keydown', key, true); window.removeEventListener('blur', onClose); };
  }, [onClose]);
  const vw = window.innerWidth, vh = window.innerHeight;
  const w = 220, h = items.length * 34 + 10;
  const px = Math.min(x, vw - w - 8), py = Math.min(y, vh - h - 8);
  return createPortal(
    <div
      ref={ref}
      className="fixed z-[99] bg-[#161920]/95 backdrop-blur-xl border border-white/10 rounded-xl p-1.5 shadow-2xl select-none min-w-[210px] text-[13px] text-text"
      style={{ left: px, top: py, width: w }}
      role="menu"
    >
      {items.map((it, i) => it === null
        ? <div key={i} className="my-1 border-t border-white/8" />
        : (
          <div
            key={i}
            role="menuitem"
            tabIndex={0}
            className={clsx(
              'flex items-center gap-2.5 px-3 py-1.5 rounded-lg cursor-pointer transition-colors text-[13px] font-medium outline-none select-none',
              it.danger
                ? 'text-rose-400 hover:bg-rose-500/15 hover:text-rose-300'
                : 'text-text hover:bg-white/8 hover:text-white'
            )}
            onClick={() => { onClose(); it.onClick(); }}
            onKeyDown={(e) => { if (e.key === 'Enter') { onClose(); it.onClick(); } }}
          >
            <span className={clsx('shrink-0', it.danger ? 'text-rose-400' : 'text-text-2')}>
              {it.icon}
            </span>
            <span className="flex-1">{it.label}</span>
          </div>
        ))}
    </div>, document.body);
}

/** Simple anchored dropdown used by topbar/sort/theme/user menus. */
export function Dropdown({ trigger, children, align = 'right' }: { trigger: ReactNode; children: ReactNode; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('mousedown', close, true);
    return () => window.removeEventListener('mousedown', close, true);
  }, [open]);
  return (
    <div ref={ref} className="relative inline-flex items-center">
      <div onClick={() => setOpen((v) => !v)}>{trigger}</div>
      {open && (
        <div className={clsx('absolute top-full mt-2 z-[99] bg-[#161920]/95 backdrop-blur-xl border border-white/10 rounded-xl p-1.5 min-w-[190px] shadow-2xl select-none', align === 'right' ? 'right-0' : 'left-0')}
          onClick={() => setOpen(false)}>
          {children}
        </div>
      )}
    </div>
  );
}
