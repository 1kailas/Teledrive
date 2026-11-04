import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { api, type DriveResponse } from '../api';
import { setNativeDropFolder } from '../upload';
import { Explorer } from '../components/Explorer';
import { ChevronRight, ChevronDown, Copy, CornerLeftUp } from 'lucide-react';
import { toast } from '../store';

export function DrivePage() {
  const { folderId } = useParams();
  useEffect(() => {
    setNativeDropFolder(folderId ?? null);
    return () => setNativeDropFolder(null);
  }, [folderId]);
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['drive', folderId ?? 'root'],
    queryFn: () => api.get<DriveResponse>(`/api/drive${folderId ? `?folderId=${folderId}` : ''}`),
  });

  const refresh = () => void qc.invalidateQueries({ queryKey: ['drive'] });

  const parentBreadcrumb = (data?.breadcrumbs ?? []).filter((b) => b.id !== 'root' && b.id !== folderId).pop();
  const parentUrl = parentBreadcrumb ? `/drive/${parentBreadcrumb.id}` : '/drive';

  return (
    <div className="h-full flex flex-col bg-surface">
      {/* ── Google Drive Folder Header ── */}
      <div className="px-6 pt-4 pb-3 flex items-center justify-between border-b border-app">
        <div className="flex items-center gap-1.5 text-xl font-medium text-text">
          {folderId && (
            <Link
              to={parentUrl}
              className="icon-btn !w-8 !h-8 text-3 hover:text-text mr-0.5 hover:bg-surface-2"
              title="Up to parent folder (Alt+Up)"
            >
              <CornerLeftUp size={16} />
            </Link>
          )}
          <Link to="/drive" className="hover:bg-surface-2 px-2.5 py-1 rounded-lg transition-colors flex items-center gap-1.5">
            <span>My Drive</span>
            {!folderId && <ChevronDown size={17} className="text-3 mt-0.5" />}
          </Link>
          {folderId && (data?.breadcrumbs ?? [])
            .filter((b) => b.id !== 'root' && b.id !== 'drive' && b.name.toLowerCase() !== 'my drive')
            .map((b, idx, arr) => {
              const isLast = idx === arr.length - 1;
              return (
                <span key={b.id} className="flex items-center gap-1.5">
                  <ChevronRight size={16} className="text-3" />
                  <Link
                    to={`/drive/${b.id}`}
                    className={`hover:bg-surface-2 px-2.5 py-1 rounded-lg transition-colors truncate max-w-[200px] ${
                      isLast ? 'font-semibold text-text' : 'text-text-2'
                    }`}
                  >
                    {b.name}
                  </Link>
                </span>
              );
            })}
          {folderId && (
            <button
              className="icon-btn !w-7 !h-7 text-3 hover:text-text ml-1"
              title="Copy folder path"
              onClick={() => {
                const fullPath = ['My Drive', ...(data?.breadcrumbs ?? []).filter((b) => b.id !== 'root').map((b) => b.name)].join(' / ');
                navigator.clipboard.writeText(fullPath).then(() => toast.success(`Copied path: ${fullPath}`));
              }}
            >
              <Copy size={13} />
            </button>
          )}
        </div>

        {/* Total Item Count */}
        <div className="text-xs text-3 font-medium">
          {data ? `${(data.folders?.length ?? 0) + (data.files?.length ?? 0)} items` : ''}
        </div>
      </div>

      {/* ── Explorer (Folder cards & File grid/table) ── */}
      <div className="flex-1 overflow-hidden">
        <Explorer
          folders={data?.folders ?? []}
          files={data?.files ?? []}
          folderId={folderId ?? null}
          currentFolder={data?.folder ?? null}
          loading={isLoading}
          onRefresh={refresh}
        />
      </div>
    </div>
  );
}
