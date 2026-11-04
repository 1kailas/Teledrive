import { useState } from 'react';
import { useNavigate } from 'react-router';
import { CloudUpload, Eye, EyeOff } from 'lucide-react';
import { api } from '../api';
import { Spinner } from '../components/ui';

export function LoginPage() {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const nav = useNavigate();
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      await api.post('/api/auth/login', { username, password });
      nav('/drive');
    } catch (err) {
      const e = err as { status?: number; message?: string };
      setError(e.status === 429 ? 'Too many attempts — try again later' : e.message ?? 'Login failed');
    } finally { setBusy(false); }
  };
  return (
    <div className="h-full flex items-center justify-center p-4" style={{ background: 'linear-gradient(135deg, var(--bg) 0%, var(--accent-soft) 55%, var(--bg) 100%)' }}>
      <div className="w-full max-w-4xl grid md:grid-cols-[1.15fr_1fr] rounded-2xl overflow-hidden shadow-overlay border border-app surface">
        <div className="hidden md:flex flex-col justify-center p-10 accent-bg">
          <CloudUpload size={44} className="accent mb-5" />
          <h1 className="text-2xl font-bold leading-tight">TeleDrive</h1>
          <p className="text-2 mt-2 max-w-xs text-[15px]">Your private drive — everything is stored on this device with resumable transfers.</p>
          <ul className="mt-6 space-y-2 text-sm text-2">
            <li>• Unlimited storage, powered by your bots</li>
            <li>• Photos, videos, documents — all searchable</li>
            <li>• Resumable uploads, ranged streaming</li>
            <li>• Share files and folders with anyone</li>
          </ul>
        </div>
        <form onSubmit={(e) => void submit(e)} className="p-8 md:p-10 flex flex-col justify-center">
          <div className="flex items-center gap-2 font-semibold text-lg mb-1 md:hidden">
            <CloudUpload size={22} className="accent" /> TeleDrive
          </div>
          <h2 className="font-semibold text-lg mb-1 hidden md:block">Welcome back</h2>
          <p className="text-2 text-sm mb-6">Sign in to your drive</p>
          <label className="text-3 text-xs font-medium">Username</label>
          <input className="input mt-1 mb-3" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
          <label className="text-3 text-xs font-medium">Password</label>
          <div className="relative mt-1">
            <input className="input !pr-10" type={show ? 'text' : 'password'} value={password}
              onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" autoFocus />
            <button type="button" className="icon-btn absolute right-1.5 top-1/2 -translate-y-1/2" onClick={() => setShow((v) => !v)} aria-label={show ? 'Hide password' : 'Show password'}>
              {show ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
          {error && <div className="text-[var(--danger)] text-sm mt-3">{error}</div>}
          <button className="btn btn-primary w-full justify-center mt-5 !py-2.5" disabled={busy || !password}>
            {busy ? <Spinner /> : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}
