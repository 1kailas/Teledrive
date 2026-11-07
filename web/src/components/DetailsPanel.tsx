import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type FileDTO, type FolderDTO } from '../api';
import { fmtBytes, relDate, fmtDuration, categoryIcon, CATEGORY_COLORS, typeLabel } from '../utils';
import { Star, X } from 'lucide-react';
import { useUi } from '../store';
import { Thumb, FolderIcon } from './ui';

export function DetailsPanel({ item, sheet }: { item: FileDTO | FolderDTO; sheet?: boolean }) {
  const isFile = 'size' in item;
  return isFile
    ? <FileDetails key={item.id} f={item as FileDTO} sheet={sheet} />
    : <FolderDetails key={item.id} f={item as FolderDTO} sheet={sheet} />;
}

function PanelShell({ children, sheet }: { children: React.ReactNode; sheet?: boolean }) {
  const setDetailsOpen = useUi((s) => s.setDetailsOpen);
  return (
    <aside className={sheet ? 'p-4' : 'w-[340px] shrink-0 h-full border-l border-app surface overflow-y-auto p-4 fadein'} aria-label="Details">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold text-sm">Details</h3>
        <button className="icon-btn" onClick={() => setDetailsOpen(false)} aria-label="Close details"><X size={16} /></button>
      </div>
      {children}
    </aside>
  );
}

function FolderDetails({ f, sheet }: { f: FolderDTO; sheet?: boolean }) {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['drive', f.id],
    queryFn: () => api.get<{ folders: FolderDTO[]; files: FileDTO[] }>(`/api/drive?folderId=${f.id}`),
  });
  const { data: statsData } = useQuery({
    queryKey: ['folderStats', f.id],
    queryFn: () => api.get<{ folders: FolderDTO[]; files: FileDTO[] }>(`/api/drive?folderId=${f.id}&limit=2000`),
  });
  const childSize = (statsData?.files ?? []).reduce((a, x) => a + x.size, 0);
  return (
    <PanelShell sheet={sheet}>
      <div className="flex justify-center mb-3">
        <div className="h-24 w-24 flex items-center justify-center surface-2 rounded-2xl">
          <FolderIcon size={48} className="text-sky-400 fill-sky-100 dark:fill-sky-950" />
        </div>
      </div>
      <div className="flex items-center gap-2 mb-1">
        <div className="font-medium text-sm break-all flex-1">{f.name}</div>
        <button className="icon-btn" aria-label="Star folder"
          onClick={() => void api.post('/api/items/star', { folderIds: [f.id], starred: !f.starred }).then(() => void qc.invalidateQueries())}>
          <Star size={16} className={f.starred ? 'fill-amber-400 text-amber-400' : ''} />
        </button>
      </div>
      <dl className="text-[12.5px] space-y-1.5 mt-3">
        <Row k="Type" v="Folder" />
        <Row k="Items" v={`${(data?.folders.length ?? 0) + (data?.files.length ?? 0)} direct children`} />
        <Row k="Size" v={childSize ? `≥ ${fmtBytes(childSize)}` : '—'} />
        <Row k="Created" v={relDate(f.createdAt)} />
        <Row k="Modified" v={relDate(f.updatedAt)} />
      </dl>
    </PanelShell>
  );
}

function FileDetails({ f: item, sheet }: { f: FileDTO; sheet?: boolean }) {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['file', item.id],
    queryFn: () => api.get<{ file: FileDTO; breadcrumbs: { id: string; name: string }[] }>(`/api/files/${item.id}`),
  });
  const f = data?.file ?? item;
  const [desc, setDesc] = useState<string | null>(null);
  const [tags, setTags] = useState<string | null>(null);
  const Icon = categoryIcon(f.category);
  const meta = (f.metadata ?? {}) as Record<string, unknown>;
  const save = (patch: Record<string, unknown>) =>
    void api.patch(`/api/files/${f.id}`, patch).then(() => { void qc.invalidateQueries({ queryKey: ['file', f.id] }); void qc.invalidateQueries({ queryKey: ['drive'] }); });
  return (
    <PanelShell sheet={sheet}>
      <div className="flex justify-center mb-3">
        {(f.hasThumbnail || f.category === 'image')
          ? <Thumb file={f} className="w-full h-44 rounded-xl" />
          : <div className="h-24 w-24 flex items-center justify-center surface-2 rounded-xl"><Icon size={44} style={{ color: CATEGORY_COLORS[f.category] }} /></div>}
      </div>
      <div className="flex items-center gap-2 mb-1">
        <div className="font-medium text-sm break-all flex-1">{f.name}</div>
        <button className="icon-btn" onClick={() => save({ starred: !f.starred })} aria-label="Star">
          <Star size={16} className={f.starred ? 'fill-amber-400 text-amber-400' : ''} />
        </button>
      </div>
      <dl className="text-[12.5px] space-y-1.5 mt-3">
        <Row k="Type" v={`${typeLabel({ category: f.category, ext: f.extension })} · ${f.mimeType}`} />
        <Row k="Size" v={`${fmtBytes(f.size)} (${f.size.toLocaleString()} B)`} />
        {f.width != null && <Row k="Dimensions" v={`${f.width} × ${f.height} px`} />}
        {meta['aspectRatio'] != null && <Row k="Aspect ratio" v={String(meta['aspectRatio'])} />}
        {meta['format'] != null && <Row k="Format" v={String(meta['format'])} />}
        {meta['colorSpace'] != null && <Row k="Color space" v={String(meta['colorSpace'])} />}
        {f.duration != null && <Row k="Duration" v={fmtDuration(f.duration)} />}
        {meta['codec'] != null && <Row k="Codec" v={String(meta['codec'])} />}
        {meta['artist'] != null && <Row k="Artist" v={String(meta['artist'])} />}
        {meta['album'] != null && <Row k="Album" v={String(meta['album'])} />}
        {meta['title'] != null && <Row k="Title" v={String(meta['title'])} />}
        {meta['year'] != null && <Row k="Year" v={String(meta['year'])} />}
        {meta['genre'] != null && <Row k="Genre" v={String(meta['genre'])} />}
        {meta['pageCount'] != null && <Row k="Pages" v={`${Number(meta['pageCount']).toLocaleString()} pages`} />}
        {meta['lines'] != null && <Row k="Lines" v={`${Number(meta['lines']).toLocaleString()} lines`} />}
        {meta['words'] != null && <Row k="Words" v={`${Number(meta['words']).toLocaleString()} words`} />}
        {meta['characters'] != null && <Row k="Characters" v={`${Number(meta['characters']).toLocaleString()} chars`} />}
        {meta['make'] != null && <Row k="Camera" v={`${meta['make']} ${meta['model'] ?? ''}`} />}
        {meta['lens'] != null && <Row k="Lens" v={String(meta['lens'])} />}
        {meta['iso'] != null && <Row k="ISO" v={String(meta['iso'])} />}
        {meta['shutterSpeed'] != null && <Row k="Shutter" v={String(meta['shutterSpeed'])} />}
        {meta['fNumber'] != null && <Row k="Aperture" v={`ƒ/${meta['fNumber']}`} />}
        {meta['focalLength'] != null && <Row k="Focal" v={`${meta['focalLength']} mm`} />}
        {f.takenAt != null && <Row k="Taken" v={new Date(f.takenAt).toLocaleString()} />}
        <Row k="Parts" v={String(f.partCount)} />
        {data?.breadcrumbs && <Row k="Location" v={`/${data.breadcrumbs.map((b) => b.name).join('/')}`} />}
        <Row k="Created" v={relDate(f.createdAt)} />
        <Row k="Modified" v={relDate(f.updatedAt)} />
        <Row k="Last opened" v={relDate(f.lastAccessedAt)} />
      </dl>
      <div className="mt-4">
        <label className="text-3 text-xs font-medium">Description</label>
        <textarea className="input mt-1 h-16 resize-none" defaultValue={f.description}
          onChange={(e) => setDesc(e.target.value)} onBlur={() => desc !== null && save({ description: desc })} />
      </div>
      <div className="mt-3">
        <label className="text-3 text-xs font-medium">Tags (comma separated)</label>
        <input className="input mt-1" defaultValue={Array.isArray(f.tags) ? f.tags.join(', ') : String(f.tags || '')}
          onChange={(e) => setTags(e.target.value)}
          onBlur={() => tags !== null && save({ tags: tags.split(',').map((t) => t.trim()).filter(Boolean) })} />
      </div>
    </PanelShell>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return <div className="flex gap-2"><dt className="text-3 w-24 shrink-0">{k}</dt><dd className="break-words">{v}</dd></div>;
}
