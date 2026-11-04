import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type ShareDTO } from '../api';
import { fmtDate } from '../utils';
import { Link2, Copy, Check } from 'lucide-react';
import { useState } from 'react';
import { toast, useDialog } from '../store';
import { EmptyState } from '../components/ui';

export function SharesPage() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['shares'], queryFn: () => api.get<{ shares: ShareDTO[] }>('/api/shares') });
  const [copied, setCopied] = useState('');
  const revoke = (id: string) => useDialog.getState().open({
    kind: 'confirm', title: 'Revoke share', body: 'The link will stop working immediately.', danger: true,
    onOk: () => void api.del(`/api/shares/${id}`).then(() => qc.invalidateQueries({ queryKey: ['shares'] })),
  });
  const shares = data?.shares ?? [];
  return (
    <div className="h-full overflow-auto">
      <div className="px-4 py-3 font-semibold text-[15px]">Shared links</div>
      {shares.length === 0 ? (
        <EmptyState icon={Link2} title="No shared links" body="Share a file or folder to create a public link." />
      ) : (
        <div className="px-4">
          <table className="w-full text-[13px]">
            <thead><tr className="text-left text-3 text-xs border-b border-app">
              <th className="py-2 font-medium">Item</th><th className="font-medium">Type</th><th className="font-medium">Created</th>
              <th className="font-medium">Expires</th><th className="font-medium">Views</th><th className="font-medium">Downloads</th>
              <th className="font-medium">Password</th><th className="font-medium">Status</th><th />
            </tr></thead>
            <tbody>
              {shares.map((s) => (
                <tr key={s.id} className="border-b border-app">
                  <td className="py-2.5 font-medium max-w-[220px] truncate">{s.itemName}</td>
                  <td className="text-2 capitalize">{s.itemType}</td>
                  <td className="text-2">{fmtDate(s.createdAt)}</td>
                  <td className="text-2">{s.expiresAt ? fmtDate(s.expiresAt) : 'Never'}</td>
                  <td className="text-2">{s.viewCount}</td>
                  <td className="text-2">{s.downloadCount}{s.maxDownloads ? `/${s.maxDownloads}` : ''}</td>
                  <td className="text-2">{s.requiresPassword ? 'Yes' : 'No'}</td>
                  <td><StatusBadge status={s.status} /></td>
                  <td className="text-right whitespace-nowrap">
                    <button className="btn !py-1 !px-2 text-xs mr-1.5" onClick={() => { void navigator.clipboard.writeText(`${location.origin}/s/${s.token}`); setCopied(s.id); setTimeout(() => setCopied(''), 1200); }}>
                      {copied === s.id ? <Check size={12} /> : <Copy size={12} />} Copy
                    </button>
                    {s.status === 'active' && <button className="btn btn-danger !py-1 !px-2 text-xs" onClick={() => revoke(s.id)}>Revoke</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {void toast}
    </div>
  );
}
function StatusBadge({ status }: { status: string }) {
  const c = { active: 'bg-emerald-500/15 text-emerald-500', expired: 'bg-amber-500/15 text-amber-500', exhausted: 'bg-amber-500/15 text-amber-500', revoked: 'bg-red-500/15 text-[var(--danger)]' }[status] ?? 'surface-2 text-2';
  return <span className={`px-2 py-0.5 rounded-full text-[11px] font-medium capitalize ${c}`}>{status}</span>;
}
