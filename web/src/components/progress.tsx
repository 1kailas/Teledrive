import { useEffect, useRef, useState } from 'react';
import { useIsFetching, useIsMutating } from '@tanstack/react-query';
import clsx from 'clsx';

/** Re-render every `ms` while `active` (for live elapsed/estimate displays). */
export function useNow(ms = 1000, active = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms, active]);
  return now;
}

export function fmtEta(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec) || sec <= 0) return '';
  if (sec < 5) return 'almost done';
  if (sec < 60) return `${Math.ceil(sec)}s left`;
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  if (m < 60) return `${m}m ${String(s).padStart(2, '0')}s left`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m left`;
}

export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}:${String(s % 60).padStart(2, '0')}` : `${s}s`;
}

/**
 * Estimated completion of an in-flight Telegram transfer.
 * Never stalls at a fake fixed number (like 97%). It smoothly tracks real
 * elapsed time against realistic expected bandwidth and continuously glides forward.
 */
export function estimateTransfer(
  startedAt: number | null, estRate: number | null, size: number, now: number, skew: number,
): { fraction: number | null; etaSec: number | null } {
  if (!startedAt || size <= 0) return { fraction: null, etaSec: null };
  const effectiveRate = estRate && estRate > 0 ? estRate : 8 * 1024 * 1024;
  const elapsed = Math.max(0, (now + skew - startedAt) / 1000);
  const expectedSec = Math.max(0.5, size / effectiveRate);

  if (elapsed < expectedSec) {
    // Real, smooth linear progression from 0% to 98%
    const fraction = Math.min(0.98, elapsed / expectedSec);
    const etaSec = Math.max(1, Math.ceil(expectedSec - elapsed));
    return { fraction, etaSec };
  } else {
    // Finished transmitting bytes; awaiting final Telegram server acknowledgment
    return { fraction: 0.99, etaSec: null };
  }
}

export type SegmentState = 'pending' | 'queued' | 'working' | 'active' | 'done' | 'failed' | 'cached';

export interface Segment {
  size: number;
  state: SegmentState;
  /** 0..1 for 'active'; ignored otherwise */
  fraction?: number | null;
  title?: string;
}

/** One bar segment per Telegram part, widths proportional to part size. */
export function PartSegments({ segments, className }: { segments: Segment[]; className?: string }) {
  const safeSegments = (segments || []).filter((s): s is Segment => !!s && typeof s === 'object');
  const total = safeSegments.reduce((a, s) => a + (s.size || 0), 0) || 1;
  return (
    <div className={clsx('seg-bar', className)} role="progressbar" aria-label="Parts progress">
      {safeSegments.map((s, i) => (
        <div key={i} className={clsx('seg', `seg-${s.state || 'pending'}`)} style={{ flexGrow: Math.max((s.size || 1) / total, 0.02) }} title={s.title || ''}>
          {s.state === 'active' && (
            s.fraction != null
              ? <i style={{ width: `${Math.round(s.fraction * 100)}%` }} />
              : <i className="seg-indeterminate" />
          )}
        </div>
      ))}
    </div>
  );
}

/** Thin top-of-page bar shown while any query/mutation is in flight (debounced to avoid flicker). */
export function TopProgress() {
  const busy = useIsFetching() + useIsMutating() > 0;
  const [visible, setVisible] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setVisible(busy), busy ? 180 : 250);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [busy]);
  return <div className={clsx('top-progress', visible && 'on')} aria-hidden />;
}
