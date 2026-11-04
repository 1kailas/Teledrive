import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type FileDTO, type FolderDTO, type Config } from '../api';
import { fmtBytes, fmtDate } from '../utils';
import { Trash2, RotateCcw, XOctagon } from 'lucide-react';
import { useDialog, toast } from '../store';
import { EmptyState, Thumb, FolderIcon } from '../components/ui';

export function TrashPage() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['trash'], queryFn: () => api.get<{ folders: FolderDTO[]; files: FileDTO[]; totalSize: number }>('/api/trash') });
  const { data: cfg } = useQuery({ queryKey: ['config'], queryFn: () => api.get<Config>('/api/config') });
  const d = useDialog.getState().open;
  const items = [...(data?.folders ?? []).map((f) => ({ kind: 'folder' as const, f })), ...(data?.files ?? []).map((f) => ({ kind: 'file' as const, f }))];
  const restore = (kind: string, id: string) => void api.post('/api/items/restore', kind === 'file' ? { fileIds: [id] } : { folderIds: [id] }).then(() => qc.invalidateQueries()).then(() => toast.success('Restored'));
  const del = (kind: string, id: string, name: string) => d({
    kind: 'confirm', title: 'Delete forever?', body: `"${name}" will be permanently deleted. This cannot be undone.`, danger: true,
    onOk: () => void api.post('/api/items/delete', kind === 'file' ? { fileIds: [id] } : { folderIds: [id] }).then(() => qc.invalidateQueries()),
  });

  return (
    <div className="h-full flex flex-col bg-surface">
      <div className="px-6 pt-4 pb-3 border-b border-app flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-xl font-medium text-text">Trash</span>
          {items.length > 0 && (
            <span className="text-3 text-xs">
              {fmtBytes(data?.totalSize ?? 0)} · Items are permanently deleted after {cfg?.trashRetentionDays ?? 30} days
            </span>
          )}
        </div>
        {items.length > 0 && (
          <button
            className="btn btn-danger !text-xs !py-1 !px-3"
            onClick={() => d({ kind: 'confirm', title: 'Empty trash?', body: `Permanently delete all ${items.length} items? This cannot be undone.`, danger: true, onOk: () => void api.del('/api/trash').then(() => qc.invalidateQueries()) })}
          >
            <Trash2 size={14} /> Empty trash
          </button>
        )}
      </div>

      <div className="flex-1 overflow-auto p-6">
        {items.length === 0 ? (
          <EmptyState icon={Trash2} title="Trash is empty" body="Items moved to trash will appear here." />
        ) : (
          <div className="space-y-2 max-w-4xl">
            {items.map(({ kind, f }) => (
              <div key={f.id} className="flex items-center gap-3 px-4 py-2.5 surface-2 border border-app rounded-xl text-[13.5px]">
                {kind === 'file' ? <Thumb file={f as FileDTO} className="w-8 h-8 rounded-lg shrink-0" /> : <FolderIcon size={22} className="text-amber-500 fill-amber-400 shrink-0" />}
                <span className="font-medium truncate flex-1">{f.name}</span>
                <span className="text-3 text-xs">Deleted {fmtDate(f.trashedAt)}</span>
                <button className="btn !py-1 !px-2.5 text-xs" onClick={() => restore(kind, f.id)}>
                  <RotateCcw size={13} /> Restore
                </button>
                <button className="btn btn-danger !py-1 !px-2.5 text-xs" onClick={() => del(kind, f.id, f.name)}>
                  <XOctagon size={13} /> Delete forever
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
