import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type DriveResponse, type FolderDTO } from '../api';
import { Explorer } from '../components/Explorer';
import { fmtBytes } from '../utils';
import { Image, Video, FileText, Music, Sparkles, FolderPlus } from 'lucide-react';
import { toast, useDialog } from '../store';

interface MediaViewProps {
  title: string;
  category: 'photos' | 'videos' | 'documents' | 'audio';
  icon: typeof Image;
  subtitle: string;
}

function MediaView({ title, category, icon: Icon, subtitle }: MediaViewProps) {
  const qc = useQueryClient();

  // 1. Fetch or ensure the dedicated folder exists
  const { data: dedicated, isLoading: isFolderLoading } = useQuery({
    queryKey: ['dedicated-folder', category],
    queryFn: () => api.get<{ folder: FolderDTO }>(`/api/folders/dedicated/${category}`),
  });

  const folderId = dedicated?.folder?.id;

  // 2. Query only the contents of this dedicated folder
  const { data: driveData, isLoading: isDriveLoading } = useQuery({
    queryKey: ['drive', folderId ?? 'pending'],
    queryFn: () => api.get<DriveResponse>(`/api/drive?folderId=${folderId}`),
    enabled: !!folderId,
  });

  const files = driveData?.files ?? [];
  const folders = driveData?.folders ?? [];
  const totalBytes = files.reduce((acc, f) => acc + (f.size || 0), 0);
  const isLoading = isFolderLoading || (!!folderId && isDriveLoading);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['drive', folderId] });
    void qc.invalidateQueries({ queryKey: ['dedicated-folder', category] });
  };

  return (
    <div className="h-full flex flex-col bg-surface">
      <div className="px-6 py-3.5 border-b border-app flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-accent/10 border border-accent/20 flex items-center justify-center text-accent">
            <Icon size={20} />
          </div>
          <div>
            <div className="text-base font-semibold text-text flex items-center gap-2">
              <span>{title}</span>
              <span className="text-xs font-normal text-3 bg-surface-2 px-2 py-0.5 rounded-full border border-app">
                {files.length + folders.length} {(files.length + folders.length) === 1 ? 'item' : 'items'} · {fmtBytes(totalBytes)}
              </span>
            </div>
            <div className="text-xs text-3">{subtitle}</div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {category === 'videos' && (
            <button
              onClick={async () => {
                try {
                  await api.post('/api/folders/templates');
                  toast.success('Generated template folders: Videos/stream/Series/Seasons');
                  refresh();
                  void qc.invalidateQueries({ queryKey: ['folder-tree'] });
                } catch {
                  toast.error('Failed to generate template folders');
                }
              }}
              className="btn !py-1.5 !px-3 !text-xs flex items-center gap-1.5 cursor-pointer text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 hover:bg-emerald-500/20"
              title="Generate template folder structure for streaming website (Videos/stream/Series/Seasons)"
            >
              <Sparkles size={14} />
              <span>Generate Stream Templates</span>
            </button>
          )}

          {category === 'videos' && (
            <div className="hidden sm:flex items-center gap-1.5 px-3 py-1 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-500 text-xs font-medium">
              <Sparkles size={13} />
              <span>Instant HD Streaming</span>
            </div>
          )}

          {folderId && (
            <button
              onClick={() => useDialog.getState().open({ kind: 'newFolder', parentId: folderId })}
              className="btn !py-1.5 !px-3 !text-xs flex items-center gap-1.5 cursor-pointer text-text"
              title="Create new subfolder / album"
            >
              <FolderPlus size={14} />
              <span>New Album</span>
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-hidden">
        <Explorer
          folders={folders}
          files={files}
          folderId={folderId ?? null}
          currentFolder={dedicated?.folder ?? null}
          loading={isLoading}
          onRefresh={refresh}
        />
      </div>
    </div>
  );
}

export function PhotosPage() {
  return (
    <MediaView
      title="Photos"
      category="photos"
      icon={Image}
      subtitle="Dedicated photo library — only pictures placed or uploaded here are kept in this collection"
    />
  );
}

export function VideosPage() {
  return (
    <MediaView
      title="Videos"
      category="videos"
      icon={Video}
      subtitle="Dedicated video library with instant streaming — only videos placed here appear here"
    />
  );
}

export function DocumentsPage() {
  return (
    <MediaView
      title="Documents"
      category="documents"
      icon={FileText}
      subtitle="Dedicated documents archive — only documents placed here appear here"
    />
  );
}

export function AudioPage() {
  return (
    <MediaView
      title="Audio & Music"
      category="audio"
      icon={Music}
      subtitle="Dedicated audio library — only songs and audio placed here appear here"
    />
  );
}
