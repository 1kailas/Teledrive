import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Folder as FolderIcon, Copy as CopyIcon, Link as LinkIcon, Check } from 'lucide-react';
import { api, type TreeFolder, type ShareDTO } from '../api';
import { useDialog, toast } from '../store';
import { Modal, Spinner } from './ui';
import { fmtBytes } from '../utils';
import clsx from 'clsx';

export function DialogHost() {
  const dialog = useDialog((s) => s.dialog);
  const close = useDialog((s) => s.close);
  const qc = useQueryClient();
  const refresh = () => void qc.invalidateQueries();
  if (!dialog) return null;
  switch (dialog.kind) {
    case 'rename': return <RenameDialog item={dialog.item} close={close} refresh={refresh} />;
    case 'newFolder': return <NewFolderDialog parentId={dialog.parentId} close={close} refresh={refresh} />;
    case 'newText': return <NewTextDialog folderId={dialog.folderId} close={close} refresh={refresh} />;
    case 'move': return <MoveDialog {...dialog} close={close} refresh={refresh} />;
    case 'share': return <ShareDialog {...dialog} close={close} />;
    case 'confirm': return <ConfirmDialog {...dialog} close={close} />;
    case 'conflict': return <ConflictDialog {...dialog} close={close} />;
  }
}

function RenameDialog({ item, close, refresh }: { item: { id: string; name: string; isFolder: boolean }; close: () => void; refresh: () => void }) {
  const [name, setName] = useState(item.name);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const dot = item.name.lastIndexOf('.');
    ref.current?.setSelectionRange(0, dot > 0 && !item.isFolder ? dot : item.name.length);
  }, [item]);
  const submit = async () => {
    setBusy(true);
    try {
      await api.patch(item.isFolder ? `/api/folders/${item.id}` : `/api/files/${item.id}`, { name });
      refresh(); close(); toast.success('Renamed');
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Modal title="Rename" onClose={close}>
      <input ref={ref} className="input" value={name} onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && void submit()} />
      <div className="flex justify-end gap-2 mt-4">
        <button className="btn" onClick={close}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || !name.trim()} onClick={() => void submit()}>{busy ? <Spinner /> : 'Rename'}</button>
      </div>
    </Modal>
  );
}

function NewFolderDialog({ parentId, close, refresh }: { parentId: string | null; close: () => void; refresh: () => void }) {
  const [name, setName] = useState('');
  const submit = async () => {
    try {
      await api.post('/api/folders', { name, parentId });
      refresh(); close(); toast.success('Folder created');
    } catch (e) { toast.error((e as Error).message); }
  };
  return (
    <Modal title="New folder" onClose={close}>
      <input className="input" autoFocus placeholder="Folder name" value={name} onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && void submit()} />
      <div className="flex justify-end gap-2 mt-4">
        <button className="btn" onClick={close}>Cancel</button>
        <button className="btn btn-primary" disabled={!name.trim()} onClick={() => void submit()}>Create</button>
      </div>
    </Modal>
  );
}

function NewTextDialog({ folderId, close, refresh }: { folderId: string | null; close: () => void; refresh: () => void }) {
  const [name, setName] = useState('untitled.txt');
  const [content, setContent] = useState('');
  const submit = async () => {
    try {
      await api.post('/api/files/text', { name, content, folderId });
      refresh(); close(); toast.success('Text file created');
    } catch (e) { toast.error((e as Error).message); }
  };
  return (
    <Modal title="New text file" onClose={close} wide>
      <input className="input mb-3" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
      <textarea className="input h-48 font-mono text-[12.5px]" placeholder="Start typing…" value={content} onChange={(e) => setContent(e.target.value)} />
      <div className="flex justify-end gap-2 mt-4">
        <button className="btn" onClick={close}>Cancel</button>
        <button className="btn btn-primary" disabled={!name.trim()} onClick={() => void submit()}>Create</button>
      </div>
    </Modal>
  );
}

function MoveDialog({ fileIds, folderIds, copy, close, refresh }: { fileIds: string[]; folderIds: string[]; copy: boolean; close: () => void; refresh: () => void }) {
  const { data } = useQuery({ queryKey: ['folderTree'], queryFn: () => api.get<{ folders: TreeFolder[] }>('/api/folders/tree') });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [target, setTarget] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const childrenOf = useMemo(() => {
    const m = new Map<string | null, TreeFolder[]>();
    for (const f of data?.folders ?? []) {
      const arr = m.get(f.parentId) ?? []; arr.push(f); m.set(f.parentId, arr);
    }
    return m;
  }, [data]);
  const blocked = new Set<string>();
  for (const id of folderIds) {
    const walk = (pid: string | null) => { for (const f of childrenOf.get(pid) ?? []) { blocked.add(f.id); walk(f.id); } };
    blocked.add(id); walk(id);
  }
  const renderLevel = (pid: string | null, depth: number): React.ReactNode =>
    (childrenOf.get(pid) ?? []).map((f) => {
      const kids = childrenOf.get(f.id) ?? [];
      const open = expanded.has(f.id);
      const dis = blocked.has(f.id);
      return (
        <div key={f.id}>
          <div className={clsx('flex items-center gap-1 py-1 px-2 rounded-md text-[13px] cursor-pointer',
            dis && 'opacity-40', target === f.id && 'accent-bg accent font-medium')}
            style={{ paddingLeft: 8 + depth * 18 }}
            onClick={() => !blocked.has(f.id) && setTarget(f.id)}>
            {kids.length ? (
              <button className="icon-btn !w-4 !h-4" onClick={(e) => { e.stopPropagation(); const n = new Set(expanded); if (open) n.delete(f.id); else n.add(f.id); setExpanded(n); }}>
                {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              </button>
            ) : <span className="w-4" />}
            <FolderIcon size={15} className="text-sky-400" /> {f.name}
          </div>
          {open && renderLevel(f.id, depth + 1)}
        </div>
      );
    });
  const submit = async () => {
    setBusy(true);
    try {
      if (copy) {
        await api.post('/api/items/copy', { fileIds, folderIds, targetFolderId: target });
      } else {
        await api.post('/api/items/move', { fileIds, folderIds, targetFolderId: target });
      }
      refresh(); close(); toast.success(copy ? 'Copied' : 'Moved');
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Modal title={copy ? 'Copy to…' : 'Move to…'} onClose={close}>
      <div className={clsx('flex items-center gap-1 py-1 px-2 rounded-md text-[13px] cursor-pointer mb-1', target === null && 'accent-bg accent font-medium')} onClick={() => setTarget(null)}>
        <FolderIcon size={15} className="text-sky-400" /> My Drive
      </div>
      <div className="max-h-72 overflow-auto border border-app rounded-lg p-1">{renderLevel(null, 0)}</div>
      <div className="flex justify-end gap-2 mt-4">
        <button className="btn" onClick={close}>Cancel</button>
        <button className="btn btn-primary" disabled={busy} onClick={() => void submit()}>{busy ? <Spinner /> : copy ? 'Copy here' : 'Move here'}</button>
      </div>
    </Modal>
  );
}

function ShareDialog({ fileId, folderId, name, close }: { fileId?: string; folderId?: string; name: string; close: () => void }) {
  const { data: shares, refetch } = useQuery({ queryKey: ['shares'], queryFn: () => api.get<{ shares: ShareDTO[] }>('/api/shares') });
  const existing = shares?.shares.find((s) =>
    s.status === 'active' && ((fileId && s.fileId === fileId) || (folderId && s.folderId === folderId)),
  );
  const [password, setPassword] = useState('');
  const [expiry, setExpiry] = useState('never');
  const [maxDl, setMaxDl] = useState('');
  const [allowDl, setAllowDl] = useState(true);
  const [created, setCreated] = useState<ShareDTO | null>(null);
  const [copied, setCopied] = useState(false);
  const share = created ?? existing ?? null;
  const create = async () => {
    try {
      const expMs = expiry === 'never' ? undefined : Date.now() + ({ '1h': 3600e3, '1d': 86400e3, '7d': 604800e3, '30d': 2592000e3 }[expiry] ?? 0);
      const { share: s } = await api.post<{ share: ShareDTO }>('/api/shares', {
        fileId, folderId, password: password || undefined, expiresAt: expMs,
        maxDownloads: maxDl ? Number(maxDl) : undefined, allowDownload: allowDl,
      });
      setCreated(s); void refetch(); toast.success('Share link created');
    } catch (e) { toast.error((e as Error).message); }
  };
  const revoke = async () => {
    if (!share) return;
    await api.del(`/api/shares/${share.id}`).catch((e) => toast.error((e as Error).message));
    setCreated(null); void refetch();
  };
  const copyLink = () => {
    const url = share ? `${location.origin}/s/${share.token}` : '';
    void navigator.clipboard.writeText(url);
    setCopied(true); setTimeout(() => setCopied(false), 1500);
  };
  return (
    <Modal title={`Share "${name}"`} onClose={close}>
      {share ? (
        <div>
          <div className="flex items-center gap-2 p-2 surface-2 rounded-lg">
            <LinkIcon size={15} className="text-3" />
            <input className="input !border-0 !bg-transparent flex-1 !p-0 text-[13px]" readOnly value={`${location.origin}/s/${share.token}`} onFocus={(e) => e.target.select()} />
            <button className="btn" onClick={copyLink}>{copied ? <Check size={14} /> : <CopyIcon size={14} />}Copy</button>
          </div>
          <div className="text-2 text-xs mt-3 space-y-1">
            <div>Status: <span className="capitalize">{share.status}</span></div>
            <div>Password: {share.requiresPassword ? 'yes' : 'no'}</div>
            <div>Downloads: {share.downloadCount}{share.maxDownloads ? `/${share.maxDownloads}` : ''}</div>
            <div>Expires: {share.expiresAt ? new Date(share.expiresAt).toLocaleString() : 'never'}</div>
          </div>
          <div className="flex justify-end mt-4">
            <button className="btn btn-danger" onClick={() => void revoke()}>Revoke link</button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <div>
            <label className="text-3 text-xs font-medium">Password (optional)</label>
            <input className="input mt-1" placeholder="Leave empty for no password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-3 text-xs font-medium">Expires</label>
              <select className="input mt-1" value={expiry} onChange={(e) => setExpiry(e.target.value)}>
                <option value="never">Never</option><option value="1h">1 hour</option><option value="1d">1 day</option>
                <option value="7d">7 days</option><option value="30d">30 days</option>
              </select>
            </div>
            <div>
              <label className="text-3 text-xs font-medium">Max downloads</label>
              <input className="input mt-1" type="number" min={1} placeholder="Unlimited" value={maxDl} onChange={(e) => setMaxDl(e.target.value)} />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={allowDl} onChange={(e) => setAllowDl(e.target.checked)} /> Allow downloads
          </label>
          <div className="flex justify-end gap-2">
            <button className="btn" onClick={close}>Cancel</button>
            <button className="btn btn-primary" onClick={() => void create()}>Create link</button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function ConfirmDialog({ title, body, danger, onOk, close }: { title: string; body: string; danger?: boolean; onOk: () => void; close: () => void }) {
  return (
    <Modal title={title} onClose={close}>
      <p className="text-sm text-2">{body}</p>
      <div className="flex justify-end gap-2 mt-4">
        <button className="btn" onClick={close}>Cancel</button>
        <button className={clsx('btn', danger ? '!bg-[var(--danger)] !border-[var(--danger)] !text-white' : 'btn-primary')}
          autoFocus onClick={() => { onOk(); close(); }}>Confirm</button>
      </div>
    </Modal>
  );
}

function ConflictDialog({
  fileName,
  sourceSize,
  sourceTime,
  targetSize,
  targetTime,
  conflictIndex,
  totalConflicts,
  onResolve,
  onCancel,
  close,
}: {
  fileName: string;
  sourceSize: number;
  sourceTime?: number;
  targetSize: number;
  targetTime: number;
  conflictIndex: number;
  totalConflicts: number;
  onResolve: (action: 'replace' | 'rename' | 'skip', applyToAll: boolean) => void;
  onCancel?: () => void;
  close: () => void;
}) {
  const [choice, setChoice] = useState<'replace' | 'rename' | 'skip'>('replace');
  const [applyToAll, setApplyToAll] = useState(false);

  const handleClose = () => {
    close();
    onCancel?.();
  };

  const handleContinue = () => {
    close();
    onResolve(choice, applyToAll);
  };

  return (
    <Modal title="Replace or Skip Files" onClose={handleClose}>
      <div className="space-y-4 text-xs">
        <p className="text-[13.5px] font-medium leading-relaxed">
          {totalConflicts > 1 ? <span className="font-semibold text-text">Conflict ({conflictIndex} of {totalConflicts}): </span> : null}
          The destination already has a file named <strong className="font-semibold text-text">"{fileName}"</strong>
        </p>

        {/* Side-by-side comparison card */}
        <div className="grid grid-cols-2 gap-3 p-3 rounded-xl bg-surface-2 border border-app">
          <div className="space-y-1">
            <span className="text-[10px] uppercase font-bold tracking-wider text-purple-400">Existing in Drive</span>
            <div className="font-semibold text-sm text-text">{fmtBytes(targetSize)}</div>
            <div className="text-3 text-[11px]">{new Date(targetTime).toLocaleString()}</div>
          </div>
          <div className="space-y-1 border-l border-app pl-3">
            <span className="text-[10px] uppercase font-bold tracking-wider text-sky-400">Incoming file</span>
            <div className="font-semibold text-sm text-text">{fmtBytes(sourceSize)}</div>
            {sourceTime ? (
              <div className="text-3 text-[11px]">{new Date(sourceTime).toLocaleString()}</div>
            ) : (
              <div className="text-3 text-[11px]">Local computer</div>
            )}
          </div>
        </div>

        {/* Choices */}
        <div className="space-y-2 pt-1">
          <label className={clsx(
            'flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition select-none',
            choice === 'replace' ? 'bg-surface-2 border-sky-500/40 shadow-sm' : 'border-app hover:bg-surface-2/60'
          )}>
            <input
              type="radio"
              name="conflictChoice"
              checked={choice === 'replace'}
              onChange={() => setChoice('replace')}
              className="mt-0.5"
            />
            <div>
              <div className="font-medium text-text text-xs">Replace the file in the destination</div>
              <div className="text-3 text-[11px] mt-0.5">Replaces the existing cloud file with this newly uploaded version</div>
            </div>
          </label>

          <label className={clsx(
            'flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition select-none',
            choice === 'rename' ? 'bg-surface-2 border-sky-500/40 shadow-sm' : 'border-app hover:bg-surface-2/60'
          )}>
            <input
              type="radio"
              name="conflictChoice"
              checked={choice === 'rename'}
              onChange={() => setChoice('rename')}
              className="mt-0.5"
            />
            <div>
              <div className="font-medium text-text text-xs">Keep both files (Rename new file)</div>
              <div className="text-3 text-[11px] mt-0.5">The uploaded file will be saved with a number suffix like "(1)"</div>
            </div>
          </label>

          <label className={clsx(
            'flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition select-none',
            choice === 'skip' ? 'bg-surface-2 border-sky-500/40 shadow-sm' : 'border-app hover:bg-surface-2/60'
          )}>
            <input
              type="radio"
              name="conflictChoice"
              checked={choice === 'skip'}
              onChange={() => setChoice('skip')}
              className="mt-0.5"
            />
            <div>
              <div className="font-medium text-text text-xs">Skip this file</div>
              <div className="text-3 text-[11px] mt-0.5">Do not upload this file and leave the existing file unchanged</div>
            </div>
          </label>
        </div>

        {totalConflicts > 1 && (
          <label className="flex items-center gap-2 pt-1 text-3 hover:text-text cursor-pointer select-none">
            <input
              type="checkbox"
              checked={applyToAll}
              onChange={(e) => setApplyToAll(e.target.checked)}
              className="rounded"
            />
            <span>Do this for all remaining conflicts ({totalConflicts - conflictIndex + 1} files)</span>
          </label>
        )}

        <div className="flex justify-end gap-2 pt-3 border-t border-app">
          <button className="btn" onClick={handleClose}>Cancel</button>
          <button className="btn btn-primary" onClick={handleContinue}>Continue</button>
        </div>
      </div>
    </Modal>
  );
}
