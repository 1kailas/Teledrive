import { useState, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { api, type SystemInfo, type SessionInfo, type Backup, type Stats } from '../api';
import { useUi, toast } from '../store';
import { fmtBytes, fmtDate } from '../utils';
import { Spinner } from '../components/ui';
import { Sliders, Shield, Cpu, Archive, Info as InfoIcon, HardDrive, RefreshCw, AlertTriangle, FolderOpen, ExternalLink } from 'lucide-react';
import { resetConfigCache, refreshUploadConfig } from '../upload';

const TABS = [
  { id: 'General', label: 'General', icon: Sliders },
  { id: 'Security', label: 'Security', icon: Shield },
  { id: 'System', label: 'System & Bots', icon: Cpu },
  { id: 'Backups', label: 'Backups', icon: Archive },
  { id: 'About', label: 'About', icon: InfoIcon },
] as const;

export function SettingsPage() {
  const [tab, setTab] = useState<(typeof TABS)[number]['id']>('General');
  return (
    <div className="h-full overflow-y-scroll px-8 py-6 max-w-5xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-text tracking-tight">Settings</h1>
        <p className="text-3 text-xs mt-1">Configure your preferences, security, storage bots, and system diagnostics.</p>
      </div>

      <div className="flex gap-2 border-b border-app pb-3 mb-6 overflow-x-auto">
        {TABS.map((t) => {
          const Icon = t.icon;
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              className={clsx(
                'px-4 py-2 text-xs font-medium rounded-full flex items-center gap-2 transition-colors cursor-pointer',
                active
                  ? 'bg-accent/15 text-accent font-semibold shadow-xs'
                  : 'text-2 hover:bg-hover hover:text-text'
              )}
              onClick={() => setTab(t.id)}
            >
              <Icon size={14} />
              <span>{t.label}</span>
            </button>
          );
        })}
      </div>
      {tab === 'General' && <GeneralTab />}
      {tab === 'Security' && <SecurityTab />}
      {tab === 'System' && <SystemTab />}
      {tab === 'Backups' && <BackupsTab />}
      {tab === 'About' && <AboutTab />}
    </div>
  );
}

function GeneralTab() {
  const { theme, setTheme, viewMode, setViewMode, cardSize, setCardSize, nameDisplay, setNameDisplay, uploadConflict, setUploadConflict } = useUi();
  return (
    <div className="space-y-6">
      <div className="surface border border-app rounded-2xl p-6 space-y-5">
        <div>
          <h3 className="font-semibold text-sm text-text">Appearance & Display</h3>
          <p className="text-3 text-xs mt-0.5">Customize your desktop theme, default views, folder card scales, and name truncation.</p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-1">
          <Field label="Theme Mode">
            <select className="input" value={theme} onChange={(e) => setTheme(e.target.value as 'light' | 'dark' | 'system')}>
              <option value="system">System (Follows OS)</option>
              <option value="light">Light</option>
              <option value="dark">Dark (Deep Charcoal)</option>
            </select>
          </Field>
          <Field label="Default View Mode">
            <select className="input" value={viewMode} onChange={(e) => setViewMode(e.target.value as 'grid' | 'list')}>
              <option value="grid">Grid View</option>
              <option value="list">List Details View</option>
            </select>
          </Field>
          <Field label="File & Folder Card Size">
            <select className="input" value={cardSize} onChange={(e) => setCardSize(e.target.value as typeof cardSize)}>
              <option value="tiny">Mini / Extra Small (Google Drive style)</option>
              <option value="compact">Small (170px)</option>
              <option value="standard">Medium / Standard (220px)</option>
              <option value="large">Large (280px)</option>
              <option value="xlarge">Extra Large (360px)</option>
            </select>
          </Field>
          <Field label="File & Folder Name Display">
            <select className="input" value={nameDisplay} onChange={(e) => setNameDisplay(e.target.value as typeof nameDisplay)}>
              <option value="full">Full Complete Name (Multi-line wrap, no dots)</option>
              <option value="multiline">Balanced Wrap (2–3 lines)</option>
              <option value="single">Compact Single Line (Truncate with dots)</option>
            </select>
          </Field>
          <Field label="On Upload Name Conflict">
            <select className="input" value={uploadConflict} onChange={(e) => setUploadConflict(e.target.value as 'rename' | 'replace' | 'error')}>
              <option value="rename">Keep both (auto-rename duplicate)</option>
              <option value="replace">Replace existing file</option>
              <option value="error">Ask / abort</option>
            </select>
          </Field>
        </div>
      </div>

      <MirrorSettingsCard />
    </div>
  );
}

interface MirrorStats {
  enabled: boolean;
  path: string;
  syncedFiles: number;
  syncedFolders: number;
  totalSizeBytes: number;
  lastSyncAt: number;
  error?: string | null;
}

function MirrorSettingsCard() {
  const qc = useQueryClient();
  const { data: mirror, isLoading } = useQuery<MirrorStats>({
    queryKey: ['mirror-stats'],
    queryFn: () => api.get<MirrorStats>('/api/mirror'),
    refetchInterval: 10_000,
  });

  const [path, setPath] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [cleanOld, setCleanOld] = useState(false);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [picking, setPicking] = useState(false);

  useEffect(() => {
    if (mirror) {
      setPath(mirror.path || 'A:\\Teledrive');
      setEnabled(mirror.enabled);
    }
  }, [mirror]);

  const handleSave = async (targetPath = path, isEnabled = enabled) => {
    setSaving(true);
    try {
      await api.post('/api/mirror', { path: targetPath, enabled: isEnabled, cleanOld });
      await qc.invalidateQueries({ queryKey: ['mirror-stats'] });
      toast.success('Mirror clone folder updated');
    } catch (e: any) {
      toast.error(e?.message || 'Failed to update mirror settings');
    } finally {
      setSaving(false);
    }
  };

  const handlePickFolder = async () => {
    setPicking(true);
    try {
      const res = await api.post<{ selected: boolean; path: string | null }>('/api/mirror/pick-folder', {});
      if (res.selected && res.path) {
        setPath(res.path);
        await handleSave(res.path, enabled);
        toast.success(`Selected folder: ${res.path}`);
      }
    } catch (e: any) {
      toast.error(e?.message || 'Failed to open folder picker');
    } finally {
      setPicking(false);
    }
  };

  const handleOpenFolder = async () => {
    try {
      await api.post('/api/mirror/open-folder', {});
    } catch (e: any) {
      toast.error(e?.message || 'Could not open folder in Explorer');
    }
  };

  const handleSyncNow = async () => {
    setSyncing(true);
    try {
      const res = await api.post<MirrorStats>('/api/mirror/sync', {});
      await qc.invalidateQueries({ queryKey: ['mirror-stats'] });
      if (res.error) {
        toast.error(`Mirror warning: ${res.error}`);
      } else {
        toast.success(`Mirrored ${res.syncedFiles} files (${fmtBytes(res.totalSizeBytes)})`);
      }
    } catch (e: any) {
      toast.error(e?.message || 'Mirror sync failed');
    } finally {
      setSyncing(false);
    }
  };

  const presets = ['A:\\Teledrive', 'C:\\Teledrive', 'D:\\Teledrive', 'E:\\Teledrive'];

  return (
    <div className="surface border border-app rounded-2xl p-6 space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <HardDrive size={18} className="text-accent" />
            <h3 className="font-semibold text-sm text-text">Local Cache & Metadata Directory</h3>
            <span className="text-[10px] font-semibold text-sky-400 uppercase tracking-wider bg-sky-500/10 px-2 py-0.5 rounded-full border border-sky-500/20">
              Cache & Metadata Only
            </span>
          </div>
          <p className="text-3 text-xs mt-1 max-w-2xl">
            Stores your cloud drive metadata catalog and high-speed streaming video cache on this drive. Does not keep duplicate backup storage of your files — strictly used for metadata and temporary media streaming caches.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={handleOpenFolder}
            className="btn !py-1.5 !px-3 !text-xs flex items-center gap-1.5 cursor-pointer text-text"
            title="Open clone folder in Windows Explorer"
          >
            <ExternalLink size={13} />
            <span>Open in Explorer</span>
          </button>
          <button
            onClick={handleSyncNow}
            disabled={syncing || isLoading}
            className="btn !py-1.5 !px-3 !text-xs flex items-center gap-1.5 cursor-pointer"
            title="Manually trigger mirror synchronization"
          >
            {syncing ? <Spinner size={13} /> : <RefreshCw size={13} />}
            <span>{syncing ? 'Syncing…' : 'Sync Now'}</span>
          </button>
        </div>
      </div>

      <div className="space-y-4 pt-1">
        <Field label="Clone Folder Location">
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
            <input
              className="input flex-1 font-mono text-xs"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="A:\Teledrive"
            />
            <button
              onClick={handlePickFolder}
              disabled={picking}
              className="btn !py-2 !px-3.5 !text-xs flex items-center justify-center gap-1.5 cursor-pointer shrink-0"
              title="Choose folder from Windows dialog"
            >
              <FolderOpen size={14} />
              <span>{picking ? 'Opening…' : 'Choose Folder…'}</span>
            </button>
            <button
              onClick={() => void handleSave()}
              disabled={saving || (path === mirror?.path && enabled === mirror?.enabled)}
              className="btn btn-primary !py-2 !px-4 !text-xs shrink-0 cursor-pointer disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save Path'}
            </button>
          </div>
        </Field>

        {/* Quick Drive Presets */}
        <div className="flex items-center flex-wrap gap-2 pt-0.5">
          <span className="text-[11px] text-3 font-medium">Quick Presets:</span>
          {presets.map((preset) => (
            <button
              key={preset}
              onClick={() => {
                setPath(preset);
                void handleSave(preset, enabled);
              }}
              className={clsx(
                'px-2.5 py-1 text-xs rounded-lg border font-mono transition-colors cursor-pointer',
                path === preset
                  ? 'bg-accent/15 border-accent text-accent font-semibold'
                  : 'bg-surface-2 border-app text-2 hover:text-text hover:bg-hover'
              )}
            >
              {preset}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-1">
          <label className="flex items-center gap-2.5 p-3 rounded-xl border border-app bg-surface-2 cursor-pointer">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => {
                const val = e.target.checked;
                setEnabled(val);
                void handleSave(path, val);
                toast.info(val ? 'Metadata mirror enabled' : 'Metadata mirror disabled');
              }}
              className="rounded accent-accent h-4 w-4"
            />
            <div>
              <div className="text-xs font-medium text-text">
                {enabled ? 'Automatic Live Mirroring' : 'Mirroring Paused'}
              </div>
              <div className="text-[11px] text-3">
                Keeps folder in sync with uploads, deletions, and moves
              </div>
            </div>
          </label>

          <label className="flex items-center gap-2.5 p-3 rounded-xl border border-app bg-surface-2 cursor-pointer">
            <input
              type="checkbox"
              checked={cleanOld}
              onChange={(e) => setCleanOld(e.target.checked)}
              className="rounded accent-accent h-4 w-4"
            />
            <div>
              <div className="text-xs font-medium text-text">
                Clean Old Location on Path Switch
              </div>
              <div className="text-[11px] text-3">
                Removes files from previous directory when changing clone path
              </div>
            </div>
          </label>
        </div>
      </div>

      {mirror && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2">
          <div className="p-3 rounded-xl bg-surface-2/60 border border-app">
            <div className="text-[11px] text-3">Cached Media Files</div>
            <div className="text-sm font-semibold text-text mt-0.5 tabular-nums">
              {mirror.syncedFiles}
            </div>
          </div>
          <div className="p-3 rounded-xl bg-surface-2/60 border border-app">
            <div className="text-[11px] text-3">Cataloged Folders</div>
            <div className="text-sm font-semibold text-text mt-0.5 tabular-nums">
              {mirror.syncedFolders}
            </div>
          </div>
          <div className="p-3 rounded-xl bg-surface-2/60 border border-app">
            <div className="text-[11px] text-3">Active Cache Size</div>
            <div className="text-sm font-semibold text-text mt-0.5 tabular-nums">
              {fmtBytes(mirror.totalSizeBytes)}
            </div>
          </div>
          <div className="p-3 rounded-xl bg-surface-2/60 border border-app">
            <div className="text-[11px] text-3">Storage Policy</div>
            <div className="text-sm font-semibold text-emerald-500 mt-0.5 tabular-nums">
              Zero Duplicates
            </div>
          </div>
        </div>
      )}

      {mirror?.error && (
        <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-500 text-xs flex items-center gap-2">
          <AlertTriangle size={15} className="shrink-0" />
          <span>{mirror.error} (drive letter may be unmounted or require admin rights)</span>
        </div>
      )}
    </div>
  );
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><label className="text-3 text-xs font-medium block mb-1.5">{label}</label>{children}</div>;
}

function SecurityTab() {
  const qc = useQueryClient();
  const desktopMode = useUi((s) => s.desktopMode);
  const { data: sessions } = useQuery({ queryKey: ['sessions'], queryFn: () => api.get<{ sessions: SessionInfo[] }>('/api/auth/sessions') });
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const change = async () => {
    try {
      await api.post('/api/auth/password', { currentPassword: cur, newPassword: next });
      toast.success('Password changed'); setCur(''); setNext('');
    } catch (e) { toast.error((e as Error).message); }
  };
  if (desktopMode) {
    return (
      <div className="space-y-6">
        <div className="surface border border-app rounded-2xl p-6 space-y-3">
          <div>
            <h3 className="font-semibold text-sm text-text">Desktop Security & Privacy</h3>
            <p className="text-3 text-xs mt-1 leading-relaxed">
              TeleDrive runs locally on your computer and transmits directly to your private Telegram storage channel.
              There is no third-party intermediary server or tracking.
            </p>
          </div>
          <ul className="text-[12px] text-2 space-y-1.5">
            <li>• Files are chunked and streamed directly to your private Telegram storage channel.</li>
            <li>• Bot tokens and configuration are stored securely in your Windows user profile.</li>
            <li>• Access to storage files is restricted to your authorized Telegram bots and channel.</li>
            <li>• Local disk is strictly used for metadata database and temporary thumbnail caches.</li>
          </ul>
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-6">
      <div className="surface border border-app rounded-2xl p-6 space-y-4">
        <div>
          <h3 className="font-semibold text-sm text-text">Change Master Password</h3>
          <p className="text-3 text-xs mt-0.5">Ensure your TeleDrive admin account is protected with a strong password.</p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-1">
          <input className="input" type="password" placeholder="Current password" value={cur} onChange={(e) => setCur(e.target.value)} />
          <input className="input" type="password" placeholder="New password (min 10 chars)" value={next} onChange={(e) => setNext(e.target.value)} />
        </div>
        <div className="pt-1">
          <button className="btn btn-primary" disabled={next.length < 10 || !cur} onClick={() => void change()}>Change password</button>
        </div>
      </div>

      <div className="surface border border-app rounded-2xl p-6 space-y-4">
        <div>
          <h3 className="font-semibold text-sm text-text">Active Client Sessions</h3>
          <p className="text-3 text-xs mt-0.5">Connected devices and desktop instances authorized on this TeleDrive instance.</p>
        </div>
        <div className="space-y-2 pt-1">
          {(sessions?.sessions ?? []).map((s) => (
            <div key={s.id} className="surface-2 border border-app rounded-xl p-3 text-[13px] flex items-center justify-between gap-3">
              <div className="flex-1 min-w-0">
                <div className="font-medium text-text flex items-center gap-2">
                  <span>{s.userAgent?.slice(0, 60) ?? 'TeleDrive Desktop Client'}</span>
                  {s.current && <span className="text-xs px-2 py-0.5 rounded-full bg-accent-soft text-accent font-semibold">(current)</span>}
                </div>
                <div className="text-3 text-xs mt-0.5">{s.ip} · last seen {fmtDate(s.lastSeenAt)}</div>
              </div>
              {!s.current && (
                <button className="btn btn-danger !py-1 !px-2.5 text-xs" onClick={() => void api.del(`/api/auth/sessions/${s.id}`).then(() => qc.invalidateQueries({ queryKey: ['sessions'] }))}>
                  Revoke
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function SystemTab() {
  const qc = useQueryClient();
  const { data: sys, refetch } = useQuery({ queryKey: ['system'], queryFn: () => api.get<SystemInfo>('/api/system'), refetchInterval: 30_000 });
  const { data: stats } = useQuery({ queryKey: ['stats'], queryFn: () => api.get<Stats>('/api/stats') });
  const { data: setRes } = useQuery({
    queryKey: ['settings-part-size'],
    queryFn: () => api.get<{
      settings: {
        partSizeMb?: number;
        effectivePartSizeMb?: number;
        maxAllowedMb?: number;
        minAllowedMb?: number;
        isLocalBotApi?: boolean;
        sliceSizeMb?: number;
        uploadConcurrency?: number;
        telegramUploadConcurrency?: number;
        botMaxConcurrentUploads?: number;
        downloadConcurrency?: number;
        cacheLimitGb?: number;
      };
    }>('/api/settings'),
  });
  const isLocalApi = setRes?.settings?.isLocalBotApi ?? false;
  const maxAllowed = setRes?.settings?.maxAllowedMb ?? (isLocalApi ? 2000 : 45);
  const minAllowed = setRes?.settings?.minAllowedMb ?? 5;

  const [partSizeMb, setPartSizeMb] = useState<number>(45);
  const [savingPartSize, setSavingPartSize] = useState<boolean>(false);
  const [clientConc, setClientConc] = useState<number>(4);
  const [telegramConc, setTelegramConc] = useState<number>(0);
  const [perBotConc, setPerBotConc] = useState<number>(2);
  const [dlConc, setDlConc] = useState<number>(3);
  const [cacheGb, setCacheGb] = useState<number>(10);
  const [savingPerf, setSavingPerf] = useState<boolean>(false);
  const [clearingCache, setClearingCache] = useState<boolean>(false);

  useEffect(() => {
    const s = setRes?.settings;
    if (!s) return;
    if (s.effectivePartSizeMb) setPartSizeMb(s.effectivePartSizeMb);
    else if (s.partSizeMb) setPartSizeMb(Math.min(s.partSizeMb, maxAllowed));
    if (s.uploadConcurrency) setClientConc(s.uploadConcurrency);
    if (s.telegramUploadConcurrency !== undefined) setTelegramConc(s.telegramUploadConcurrency);
    if (s.botMaxConcurrentUploads) setPerBotConc(s.botMaxConcurrentUploads);
    if (s.downloadConcurrency) setDlConc(s.downloadConcurrency);
    if (s.cacheLimitGb) setCacheGb(s.cacheLimitGb);
  }, [setRes, maxAllowed]);

  const updatePartSize = async (val: number) => {
    const clamped = Math.max(minAllowed, Math.min(maxAllowed, Math.round(val)));
    setPartSizeMb(clamped);
    setSavingPartSize(true);
    try {
      await api.patch('/api/settings', { partSizeMb: clamped });
      await refreshUploadConfig().catch(() => resetConfigCache());
      void qc.invalidateQueries({ queryKey: ['settings-part-size'] });
      void qc.invalidateQueries({ queryKey: ['config'] });
      toast.success(`Part splitting size set to ${clamped} MB`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSavingPartSize(false);
    }
  };

  const updatePerformance = async () => {
    const client = Math.max(1, Math.min(32, Math.round(clientConc) || 1));
    const telegram = Math.max(0, Math.min(64, Math.round(telegramConc) || 0));
    const perBot = Math.max(1, Math.min(8, Math.round(perBotConc) || 1));
    setClientConc(client); setTelegramConc(telegram); setPerBotConc(perBot);
    setSavingPerf(true);
    try {
      await api.patch('/api/settings', {
        uploadConcurrency: client,
        telegramUploadConcurrency: telegram,
        botMaxConcurrentUploads: perBot,
        downloadConcurrency: Math.max(1, Math.min(8, Math.round(dlConc) || 3)),
      });
      await refreshUploadConfig().catch(() => resetConfigCache());
      void qc.invalidateQueries({ queryKey: ['settings-part-size'] });
      void qc.invalidateQueries({ queryKey: ['config'] });
      toast.success('Upload performance updated');
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSavingPerf(false);
    }
  };

  // Transfer profiles: Eco / Balanced / Max set the four server-side
  // concurrency knobs at once. 0 = auto for telegramUploadConcurrency.
  const PROFILES = [
    { id: 'eco', label: 'Eco', desc: 'Gentle — 1 lane everywhere', vals: { uploadConcurrency: 1, telegramUploadConcurrency: 1, botMaxConcurrentUploads: 1, downloadConcurrency: 1 } },
    { id: 'balanced', label: 'Balanced', desc: 'Default mix', vals: { uploadConcurrency: 4, telegramUploadConcurrency: 0, botMaxConcurrentUploads: 2, downloadConcurrency: 3 } },
    { id: 'max', label: 'Max', desc: 'Fastest — needs fast bots', vals: { uploadConcurrency: 8, telegramUploadConcurrency: 0, botMaxConcurrentUploads: 4, downloadConcurrency: 5 } },
  ];
  const activeProfile = PROFILES.find((p) =>
    p.vals.uploadConcurrency === clientConc &&
    p.vals.telegramUploadConcurrency === telegramConc &&
    p.vals.botMaxConcurrentUploads === perBotConc &&
    p.vals.downloadConcurrency === dlConc
  );

  const applyProfile = async (p: (typeof PROFILES)[number]) => {
    setSavingPerf(true);
    try {
      await api.patch('/api/settings', p.vals);
      await refreshUploadConfig().catch(() => resetConfigCache());
      void qc.invalidateQueries({ queryKey: ['settings-part-size'] });
      void qc.invalidateQueries({ queryKey: ['config'] });
      toast.success(`Transfer profile: ${p.label}`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSavingPerf(false);
    }
  };

  const updateCacheLimit = async (gb: number) => {
    const clamped = Math.max(1, Math.min(500, Math.round(gb) || 1));
    setCacheGb(clamped);
    try {
      await api.patch('/api/settings', { cacheLimitGb: clamped });
      void qc.invalidateQueries({ queryKey: ['settings-part-size'] });
      void qc.invalidateQueries({ queryKey: ['system'] });
      toast.success(`Cache limit set to ${clamped} GB`);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const clearCache = async () => {
    setClearingCache(true);
    try {
      const res = await api.post<{ freedBytes?: number }>('/api/system/clear-cache');
      void qc.invalidateQueries({ queryKey: ['system'] });
      toast.success(`Cache cleared — ${fmtBytes(res.freedBytes ?? 0)} freed`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setClearingCache(false);
    }
  };

  if (!sys) return <Spinner />;
  const botStats = new Map((stats?.bots ?? []).map((b) => [b.botId, b]));

  const botApiText = sys.botApi?.reachable ? 'Bundled service running' : (isLocalApi ? 'Telegram Local Bot API' : 'Telegram Bot API');
  const channelText = sys.channel?.title ?? sys.channel?.id ?? 'Telegram Storage';
  const diskFreeText = sys.disk?.total ? `${fmtBytes(sys.disk.free)} free of ${fmtBytes(sys.disk.total)}` : (sys.disk?.free ? fmtBytes(sys.disk.free) : '—');
  const cacheText = `${fmtBytes(sys.cache?.usedBytes ?? 0)} in thumbnails & cache`;
  const queueText = sys.queue ? `${sys.queue.receivedParts ?? 0} received · ${sys.queue.uploadingParts ?? 0} uploading · ${sys.queue.failedParts ?? 0} failed` : 'Idle';
  const pendingDelText = String(sys.queue?.pendingDeletions ?? 0);
  const toolsText = sys.tools ? ['ffmpeg', 'ffprobe', 'pdftoppm'].filter((t) => sys.tools?.[t as keyof typeof sys.tools]).join(', ') || 'none' : 'none';
  const uptimeText = `${Math.floor((sys.uptimeSec ?? 60) / 60)}m`;
  const backupText = sys.lastBackup ? `${fmtDate(sys.lastBackup.createdAt)} · ${fmtBytes(sys.lastBackup.size)}` : 'None yet';

  const presets = isLocalApi
    ? [
        { mb: 50, label: '50 MB' },
        { mb: 100, label: '100 MB' },
        { mb: 250, label: '250 MB' },
        { mb: 500, label: '500 MB' },
        { mb: 1000, label: '1000 MB (1 GB)' },
        { mb: 2000, label: '2000 MB (2 GB)' },
      ]
    : [
        { mb: 10, label: '10 MB' },
        { mb: 20, label: '20 MB (Fast)' },
        { mb: 30, label: '30 MB' },
        { mb: 40, label: '40 MB' },
        { mb: 45, label: '45 MB' },
      ];

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-[13px]">
        <Info label="Bot API Engine" value={botApiText} />
        <Info label="Storage Channel" value={channelText} />
        <Info label="Disk free" value={diskFreeText} />
        <Info label="Thumbnails & Cache" value={cacheText} />
        <Info label="Queue" value={queueText} />
        <Info label="Pending deletions" value={pendingDelText} />
        <Info label="Tools" value={toolsText} />
        <Info label="Last backup" value={backupText} />
        <Info label="Uptime" value={uptimeText} />
      </div>

      {/* ── File Splitting & Part Size Controller ── */}
      <section className="surface border border-app rounded-2xl p-5 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h4 className="font-semibold text-sm text-text flex items-center gap-2">
              <span>File Splitting & Part Size</span>
              <span className="px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-accent/15 text-accent border border-accent/25">
                {partSizeMb} MB {partSizeMb >= 1000 ? `(${(partSizeMb / 1024).toFixed(2)} GB)` : ''}
              </span>
              <span className={clsx(
                'px-2 py-0.5 rounded-full text-[10.5px] font-medium border',
                isLocalApi ? 'bg-purple-500/10 text-purple-400 border-purple-500/20' : 'bg-sky-500/10 text-sky-400 border-sky-500/20'
              )}>
                {isLocalApi ? 'Local Bot API (up to 2 GB)' : 'Bot API'}
              </span>
            </h4>
            <p className="text-3 text-xs mt-1 leading-relaxed">
              Files are split into chunks of this size before they are stored. Set any custom chunk size between <strong>{minAllowed} MB</strong> and <strong>{maxAllowed} MB</strong>.
            </p>
          </div>
          {savingPartSize && <Spinner />}
        </div>

        {/* Quick Presets */}
        <div>
          <label className="text-3 text-[11px] font-medium uppercase tracking-wider block mb-2">Quick Presets</label>
          <div className="flex flex-wrap gap-2">
            {presets.map((preset) => (
              <button
                key={preset.mb}
                type="button"
                className={clsx(
                  'px-3 py-1.5 text-xs rounded-xl font-medium border transition-all cursor-pointer',
                  partSizeMb === preset.mb
                    ? 'bg-accent text-white border-accent shadow-xs font-semibold'
                    : 'bg-surface-2 text-2 border-app hover:border-accent/40 hover:text-text'
                )}
                onClick={() => void updatePartSize(preset.mb)}
              >
                {preset.label}
              </button>
            ))}
          </div>
        </div>

        {/* Slider + Direct Numeric Input */}
        <div className="pt-2">
          <label className="text-3 text-[11px] font-medium uppercase tracking-wider block mb-2">
            Custom Splitting Size ({minAllowed} MB – {maxAllowed} MB)
          </label>
          <div className="flex items-center gap-4">
            <input
              type="range"
              min={minAllowed}
              max={maxAllowed}
              step={isLocalApi ? 5 : 1}
              value={partSizeMb}
              onChange={(e) => setPartSizeMb(Number(e.target.value))}
              onMouseUp={(e) => void updatePartSize(Number((e.target as HTMLInputElement).value))}
              onTouchEnd={(e) => void updatePartSize(Number((e.target as HTMLInputElement).value))}
              className="flex-1 accent-sky-500 cursor-pointer h-2 bg-surface-2 rounded-lg"
            />
            <div className="flex items-center gap-1.5 shrink-0">
              <input
                type="number"
                min={minAllowed}
                max={maxAllowed}
                value={partSizeMb}
                onChange={(e) => setPartSizeMb(Number(e.target.value))}
                onBlur={(e) => void updatePartSize(Number(e.target.value))}
                onKeyDown={(e) => { if (e.key === 'Enter') void updatePartSize(Number((e.target as HTMLInputElement).value)); }}
                className="input !w-24 !text-center !py-1.5 text-xs font-semibold tabular-nums"
              />
              <span className="text-2 text-xs font-medium">MB</span>
              <button
                type="button"
                className="btn btn-primary !py-1.5 !px-3 text-xs ml-1"
                onClick={() => void updatePartSize(partSizeMb)}
              >
                Apply
              </button>
            </div>
          </div>
        </div>

        {/* Smart Single-Piece Note */}
        <div className="p-3 rounded-xl bg-surface-2 border border-app text-xs space-y-1.5">
          <div className="flex items-center gap-1.5 text-text font-medium">
            <span>⚡ Single-piece threshold:</span>
            <span className="text-accent font-semibold">{partSizeMb} MB</span>
          </div>
          <p className="text-3 text-[11.5px] leading-relaxed">
            • Files under <strong>{partSizeMb} MB</strong> upload directly in 1 piece with 0 splitting overhead.
            <br />
            • Files larger than <strong>{partSizeMb} MB</strong> are automatically split into <strong>{partSizeMb} MB</strong> chunks and recombined seamlessly on download.
            <br />
            <span className="text-sky-400 font-medium">• Bandwidth caps aren't offered: the bundled Bot API performs the actual network transfer, so pacing our side wouldn't truly limit throughput.</span>
          </p>
        </div>
      </section>

      {/* ── Upload Performance & Concurrency ── */}
      <section className="surface border border-app rounded-2xl p-5 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h4 className="font-semibold text-sm text-text flex items-center gap-2">
              <span>Upload Performance</span>
              {savingPerf && <Spinner />}
            </h4>
            <p className="text-3 text-xs mt-1 leading-relaxed">
              Tune how many slices this browser sends in parallel and how many parts the server stores at once.
              Defaults are safe; increase them only if your connection and bots keep up.
              Bandwidth caps aren't offered — the bundled Bot API performs the actual network transfer.
            </p>
          </div>
        </div>

        {/* Transfer profiles */}
        <div className="flex flex-wrap gap-2">
          {PROFILES.map((p) => (
            <button
              key={p.id}
              type="button"
              title={p.desc}
              className={clsx(
                'px-3 py-1.5 text-xs rounded-xl font-medium border transition-all cursor-pointer',
                activeProfile?.id === p.id
                  ? 'bg-accent text-white border-accent shadow-xs font-semibold'
                  : 'bg-surface-2 text-2 border-app hover:border-accent/40 hover:text-text'
              )}
              onClick={() => void applyProfile(p)}
            >
              {p.label}
            </button>
          ))}
          {!activeProfile && (
            <span className="px-3 py-1.5 text-xs rounded-xl font-semibold bg-surface-3 text-2 border border-dashed border-app">
              Custom
            </span>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Field label="Client slice concurrency (1–32)">
            <input
              className="input !py-1.5 text-xs font-semibold tabular-nums"
              type="number" min={1} max={32}
              value={clientConc}
              onChange={(e) => setClientConc(Number(e.target.value))}
            />
          </Field>
          <Field label="Telegram upload concurrency (0 = auto)">
            <input
              className="input !py-1.5 text-xs font-semibold tabular-nums"
              type="number" min={0} max={64}
              value={telegramConc}
              onChange={(e) => setTelegramConc(Number(e.target.value))}
            />
          </Field>
          <Field label="Per-bot concurrent uploads (1–8)">
            <input
              className="input !py-1.5 text-xs font-semibold tabular-nums"
              type="number" min={1} max={8}
              value={perBotConc}
              onChange={(e) => setPerBotConc(Number(e.target.value))}
            />
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-[11.5px] text-3">
          <span className="p-2.5 rounded-xl bg-surface-2 border border-app">
            HTTP slice size: <strong className="text-text">{setRes?.settings?.sliceSizeMb ?? 32} MB</strong> (server-controlled)
          </span>
          <span className="p-2.5 rounded-xl bg-surface-2 border border-app">
            Auto server slots: <strong className="text-text">healthy bots × per-bot limit</strong>
          </span>
          <button
            type="button"
            className="btn btn-primary !py-1.5 !px-3 text-xs ml-auto"
            disabled={savingPerf}
            onClick={() => void updatePerformance()}
          >
            Apply performance settings
          </button>
        </div>
      </section>
      {/* ── Stream Cache ── */}
      <section className="surface border border-app rounded-2xl p-5 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h4 className="font-semibold text-sm text-text">Stream Cache</h4>
            <p className="text-3 text-xs mt-1 leading-relaxed">
              Downloaded parts are kept on disk for fast re-streaming and evicted oldest-first once the limit is reached.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <div className="text-xs text-2">
            {fmtBytes(sys.cache?.usedBytes ?? 0)} used of {fmtBytes(sys.cache?.maxBytes ?? 0)}
            {sys.cache?.files != null && ` · ${sys.cache.files} file${sys.cache.files === 1 ? '' : 's'}`}
          </div>
          <div className="flex items-center gap-1.5">
            <input
              type="number" min={1} max={500}
              value={cacheGb}
              onChange={(e) => setCacheGb(Number(e.target.value))}
              onBlur={(e) => void updateCacheLimit(Number(e.target.value))}
              onKeyDown={(e) => { if (e.key === 'Enter') void updateCacheLimit(Number((e.target as HTMLInputElement).value)); }}
              className="input !w-20 !text-center !py-1.5 text-xs font-semibold tabular-nums"
            />
            <span className="text-2 text-xs font-medium">GB limit</span>
          </div>
          <button
            type="button"
            className="btn btn-secondary !py-1.5 !px-3 text-xs"
            disabled={clearingCache}
            onClick={() => void clearCache()}
          >
            {clearingCache ? 'Clearing…' : 'Clear cache'}
          </button>
        </div>
      </section>

      <div className="flex items-center justify-between">
        <h4 className="font-semibold text-sm text-text">Connected Telegram Storage Bots</h4>
        <button className="btn" onClick={() => void api.post<{ retried: number; parts?: number }>('/api/system/retry-failed').then((r) => { toast.success(`Queued ${r.parts ?? 0} part(s) from ${r.retried ?? 0} upload(s)`); void qc.invalidateQueries({ queryKey: ['uploads-interrupted'] }); void refetch(); })}>Retry failed uploads</button>
      </div>
      <table className="w-full text-[13px]">
        <thead><tr className="text-left text-3 text-xs border-b border-app">
          <th className="py-2 font-medium">Bot</th><th className="font-medium">ID</th><th className="font-medium">Healthy</th><th className="font-medium">In-flight</th><th className="font-medium">Parts / bytes</th><th className="font-medium">Last error</th>
        </tr></thead>
        <tbody>
          {(sys.bots ?? []).map((b) => {
            const s = botStats.get(b.botId);
            return (
              <tr key={b.botId} className="border-b border-app">
                <td className="py-2 font-medium">{b.username ? (b.username.startsWith('@') ? b.username : `@${b.username}`) : `@${b.botId}`}</td>
                <td className="text-2 font-mono text-xs">{b.botId}</td>
                <td><span className={b.healthy ? 'text-emerald-500' : 'text-[var(--danger)]'}>{b.healthy ? '● healthy' : '● unhealthy'}</span></td>
                <td className="text-2">{b.inFlight ?? 0}</td>
                <td className="text-2">{s ? `${s.partsUploaded} · ${fmtBytes(s.bytesUploaded)}` : '—'}</td>
                <td className="text-2 text-xs max-w-[200px] truncate">{b.lastError ?? '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
function Info({ label, value }: { label: string; value: string }) {
  return <div className="surface border border-app rounded-lg p-3"><div className="text-3 text-xs">{label}</div><div className="font-medium mt-0.5 break-words">{value}</div></div>;
}

function BackupsTab() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['backups'], queryFn: () => api.get<{ backups: Backup[] }>('/api/backups'), refetchInterval: 30_000 });
  const [busy, setBusy] = useState(false);
  return (
    <div className="space-y-6">
      <div className="surface border border-app rounded-2xl p-6 space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h3 className="font-semibold text-sm text-text">Database Backups</h3>
            <p className="text-3 text-xs mt-0.5">
              Local snapshots of file metadata, folder structure, chunk indexes, and settings. Bot tokens are omitted.
              Your file content remains permanently preserved in your private Telegram storage channel.
            </p>
          </div>
          <div className="flex gap-2">
            <button className="btn btn-primary" disabled={busy} onClick={async () => {
              setBusy(true);
              try { await api.post('/api/backups'); toast.success('Local backup created'); void qc.invalidateQueries({ queryKey: ['backups'] }); void qc.invalidateQueries({ queryKey: ['system'] }); }
              catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
            }}>{busy ? <Spinner /> : 'Back up now'}</button>
            <a className="btn" href="/api/backups/download">Download backup</a>
          </div>
        </div>
        <div className="space-y-2 pt-2">
          {(data?.backups ?? []).map((b) => (
            <div key={b.id} className="surface-2 border border-app rounded-xl p-3 text-[13px] flex items-center justify-between">
              <span className="font-medium text-text">{b.fileName}</span>
              <span className="text-2 text-xs">{fmtBytes(b.size)} · {fmtDate(b.createdAt)}</span>
            </div>
          ))}
          {(data?.backups ?? []).length === 0 && <div className="text-3 text-xs py-2">No backups yet — create one before moving or reinstalling the app.</div>}
        </div>
      </div>
    </div>
  );
}

function AboutTab() {
  const { data } = useQuery({ queryKey: ['config'], queryFn: () => api.get<{ version: string }>('/api/config') });
  const { data: sys } = useQuery({ queryKey: ['system'], queryFn: () => api.get<SystemInfo>('/api/system') });
  return (
    <div className="space-y-6">
      <div className="surface border border-app rounded-2xl p-6 space-y-4">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-xl bg-accent-soft flex items-center justify-center text-accent font-bold text-base">
            TD
          </div>
          <div>
            <h2 className="text-base font-semibold text-text">TeleDrive</h2>
            <div className="text-3 text-xs">Version {sys?.version ?? data?.version ?? '3.1.7'} · Standalone Windows Desktop Edition</div>
          </div>
        </div>
        <p className="text-2 text-xs leading-relaxed">
          An unlimited personal cloud file explorer backed by private Telegram channels.
          TeleDrive chunks and streams your files directly to Telegram using multi-bot parallel dispatch,
          with fast local indexing, instant thumbnail caching, and zero external subscriptions.
        </p>
      </div>
    </div>
  );
}
