import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router';
import { CloudUpload, Download, Lock, Folder as FolderIcon, ChevronRight, FileX2 } from 'lucide-react';
import { api, type PublicShareInfo, type PublicFolderListing } from '../api';
import { fmtBytes, categoryIcon, CATEGORY_COLORS } from '../utils';
import { Spinner, EmptyState } from '../components/ui';
import { PreviewOverlay } from '../components/Preview';
import { usePreview } from '../store';
import { Toasts } from '../components/ui';
import type { FileDTO } from '../api';

export function PublicSharePage() {
  const { token } = useParams<{ token: string }>();
  const qc = useQueryClient();
  const { data, error, isLoading } = useQuery({
    queryKey: ['publicShare', token],
    queryFn: () => api.get<PublicShareInfo>(`/api/public/shares/${token}`),
    retry: false,
  });
  const err = error as { status?: number; message?: string } | null;
  return (
    <div className="min-h-full bg-subtle">
      <header className="surface border-b border-app px-5 py-3 flex items-center gap-2 font-semibold">
        <CloudUpload size={19} className="accent" /> TeleDrive
        <span className="text-3 font-normal text-sm ml-1">shared with you</span>
      </header>
      <div className="max-w-4xl mx-auto p-6">
        {isLoading && <div className="flex justify-center py-20"><Spinner size={28} /></div>}
        {err && <GoneState err={err} />}
        {data && !data.unlocked && data.requiresPassword && <PasswordGate token={token!} onUnlock={() => void qc.invalidateQueries({ queryKey: ['publicShare', token] })} />}
        {data && (data.unlocked || !data.requiresPassword) && <ShareBody token={token!} info={data} />}
      </div>
      <PreviewOverlay publicBase={`/api/public/shares/${token}`} />
      <Toasts />
    </div>
  );
}

function GoneState({ err }: { err: { status?: number; message?: string } | null }) {
  return <EmptyState icon={FileX2} title="This link is unavailable" body={err?.message ?? 'The share may have expired, been revoked, or hit its download limit.'} />;
}

function PasswordGate({ token, onUnlock }: { token: string; onUnlock: () => void }) {
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true); setErr('');
    try {
      await api.post(`/api/public/shares/${token}/unlock`, { password: pw });
      onUnlock();
    } catch { setErr('Wrong password'); } finally { setBusy(false); }
  };
  return (
    <div className="surface border border-app shadow-overlay rounded-2xl p-8 max-w-sm mx-auto mt-16 text-center fadein">
      <Lock size={28} className="mx-auto text-3 mb-3" />
      <h1 className="font-semibold mb-1">Password required</h1>
      <p className="text-2 text-sm mb-4">Enter the password to access this share.</p>
      <input className="input" type="password" placeholder="Password" value={pw} onChange={(e) => setPw(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && void submit()} autoFocus />
      {err && <div className="text-[var(--danger)] text-sm mt-2">{err}</div>}
      <button className="btn btn-primary w-full justify-center mt-4" onClick={() => void submit()} disabled={busy || !pw}>{busy ? <Spinner /> : 'Unlock'}</button>
    </div>
  );
}

function ShareBody({ token, info }: { token: string; info: PublicShareInfo }) {
  const base = `/api/public/shares/${token}`;
  if (info.type === 'file' && info.file) {
    const f = info.file;
    const Icon = categoryIcon(f.category);
    return (
      <div className="surface border border-app rounded-2xl p-8 text-center fadein">
        {f.hasThumbnail ? (
          <img src={`${base}/files/${f.id}/thumbnail`} alt="" className="mx-auto max-h-64 rounded-xl mb-5" />
        ) : (
          <div className="mx-auto h-24 w-24 surface-2 rounded-2xl flex items-center justify-center mb-5"><Icon size={44} style={{ color: CATEGORY_COLORS[f.category] }} /></div>
        )}
        <h1 className="font-semibold text-lg">{f.name}</h1>
        <p className="text-2 text-sm mt-1">{f.category} · {fmtBytes(f.size)}{f.width ? ` · ${f.width}×${f.height}` : ''}{f.duration ? ` · ${Math.floor(f.duration / 60)}m` : ''}</p>
        {f.description && <p className="text-2 text-sm mt-2 max-w-md mx-auto">{f.description}</p>}
        <div className="flex justify-center gap-2 mt-5">
          {info.allowDownload && <a className="btn btn-primary" href={`${base}/files/${f.id}/content?download=1`}><Download size={15} />Download</a>}
          <button className="btn" onClick={() => usePreview.getState().start([f as unknown as FileDTO], 0)}>Preview</button>
        </div>
      </div>
    );
  }
  return <FolderShare token={token} info={info} />;
}

function FolderShare({ token, info }: { token: string; info: PublicShareInfo }) {
  const [folderId, setFolderId] = useState<string | null>(info.folder?.id ?? null);
  const base = `/api/public/shares/${token}`;
  const { data } = useQuery({
    queryKey: ['publicFolder', token, folderId],
    queryFn: () => api.get<PublicFolderListing>(`${base}/folders/${folderId}`),
    enabled: info.type === 'folder',
  });
  return (
    <div className="fadein">
      <nav className="flex items-center gap-1 text-sm mb-4">
        {(data?.breadcrumbs ?? []).map((b, i) => (
          <span key={b.id} className="flex items-center gap-1">
            {i > 0 && <ChevronRight size={13} className="text-3" />}
            <button className="hover:underline font-medium" onClick={() => setFolderId(b.id)}>{b.name}</button>
          </span>
        ))}
      </nav>
      {data?.allowDownload && (
        <div className="mb-4"><a className="btn" href={`${base}/zip`}><Download size={14} />Download all (.zip)</a></div>
      )}
      <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill,minmax(160px,1fr))' }}>
        {(data?.folders ?? []).map((f) => (
          <button key={f.id} className="surface border border-app rounded-xl p-3 text-left card-hover" onDoubleClick={() => setFolderId(f.id)} onClick={() => setFolderId(f.id)}>
            <FolderIcon size={40} className="text-sky-400 mb-2" />
            <div className="text-[13px] font-medium truncate">{f.name}</div>
          </button>
        ))}
        {(data?.files ?? []).map((f, i) => {
          const Icon = categoryIcon(f!.category);
          return (
            <div key={f!.id} className="surface border border-app rounded-xl p-3 cursor-pointer card-hover group relative"
              onClick={() => usePreview.getState().start((data?.files ?? []) as FileDTO[], i)}>
              {f!.hasThumbnail
                ? <img src={`${base}/files/${f!.id}/thumbnail`} className="h-20 w-full object-cover rounded-md mb-2" alt="" />
                : <div className="h-20 flex items-center justify-center mb-2"><Icon size={40} style={{ color: CATEGORY_COLORS[f!.category] }} /></div>}
              <div className="text-[13px] font-medium truncate">{f!.name}</div>
              <div className="text-3 text-[11px]">{fmtBytes(f!.size)}</div>
              {data?.allowDownload && (
                <a className="icon-btn absolute top-2 right-2 opacity-0 group-hover:opacity-100 bg-[var(--surface)]" href={`${base}/files/${f!.id}/content?download=1`} onClick={(e) => e.stopPropagation()}><Download size={13} /></a>
              )}
            </div>
          );
        })}
      </div>
      {data && data.files.length === 0 && data.folders.length === 0 && <EmptyState icon={FolderIcon} title="Empty folder" />}

    </div>
  );
}
