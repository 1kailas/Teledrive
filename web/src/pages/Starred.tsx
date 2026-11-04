import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type FileDTO, type FolderDTO } from '../api';
import { Explorer } from '../components/Explorer';

export function StarredPage() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['starred'], queryFn: () => api.get<{ files: FileDTO[]; folders: FolderDTO[] }>('/api/starred') });
  return (
    <div className="h-full flex flex-col bg-surface">
      <div className="px-6 pt-4 pb-3 border-b border-app text-lg font-semibold text-text">Starred</div>
      <div className="flex-1 overflow-hidden">
        <Explorer folders={data?.folders ?? []} files={data?.files ?? []} loading={isLoading} onRefresh={() => void qc.invalidateQueries({ queryKey: ['starred'] })} />
      </div>
    </div>
  );
}
