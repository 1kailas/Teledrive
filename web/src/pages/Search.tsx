import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { useState } from 'react';
import { api, type SearchResult } from '../api';
import { Explorer } from '../components/Explorer';

import { useQueryClient } from '@tanstack/react-query';
import { CATEGORY_LABELS } from '../utils';
import clsx from 'clsx';

export function SearchPage() {
  const [params] = useSearchParams();
  const qc = useQueryClient();
  const [category, setCategory] = useState('');
  const [minSize, setMinSize] = useState('');
  const [starred, setStarred] = useState(false);
  const q = params.get('q') ?? '';
  const qs = new URLSearchParams({ q });
  if (category) qs.set('category', category);
  if (minSize) qs.set('minSize', String(Number(minSize) * 1024 * 1024));
  if (starred) qs.set('starred', 'true');
  const { data } = useQuery({
    queryKey: ['search', q, category, minSize, starred],
    queryFn: () => api.get<SearchResult>(`/api/search?${qs}`),
    enabled: q.length > 0,
  });
  return (
    <div className="h-full flex flex-col">
      <div className="px-4 py-3 flex flex-wrap items-center gap-2 border-b border-app surface">
        <span className="font-semibold text-[15px] mr-2">Results for “{q}”</span>
        {['', 'image', 'video', 'audio', 'document', 'code', 'archive', 'other'].map((c) => (
          <button key={c} className={clsx('btn !py-1 !px-2.5 !text-xs !rounded-full', category === c && 'accent-bg accent')}
            onClick={() => setCategory(c)}>{c ? CATEGORY_LABELS[c] : 'All'}</button>
        ))}
        <input className="input !w-28 !py-1 !text-xs" placeholder="Min size (MB)" value={minSize} onChange={(e) => setMinSize(e.target.value)} />
        <label className="text-xs text-2 flex items-center gap-1.5"><input type="checkbox" checked={starred} onChange={(e) => setStarred(e.target.checked)} />Starred</label>
        <span className="text-3 text-xs ml-auto">{data?.total ?? 0} files</span>
      </div>
      <div className="flex-1 overflow-hidden">
        <Explorer folders={data?.folders ?? []} files={data?.files ?? []} loading={!data} onRefresh={() => void qc.invalidateQueries({ queryKey: ['search'] })} />
      </div>
    </div>
  );
}

