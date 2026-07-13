/**
 * TeleDrive — Login Page
 *
 * Renders the Telegram Login Widget iframe, and provides a local Dev Passcode
 * login method in case browser tracking policies block the widget entirely.
 */

import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Cloud, Loader2, KeyRound } from 'lucide-react';
import api from '../services/api';

interface LoginProps {
  onLogin: (token: string) => void;
}

export default function Login({ onLogin }: LoginProps) {
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [passcode, setPasscode] = useState('');

  const botUsername = import.meta.env.VITE_TELEGRAM_BOT_USERNAME || 'TeleDriveBot';
  const origin = window.location.origin;

  useEffect(() => {
    // Define the global callback for Telegram login widget success
    (window as any).onTelegramAuth = async (user: any) => {
      setLoading(true);
      setError('');
      try {
        const response = await api.post('/auth/telegram-login', user);
        if (response.data?.success && response.data?.data?.token) {
          onLogin(response.data.data.token);
        } else {
          setError(response.data?.error || 'Authentication failed');
          setLoading(false);
        }
      } catch (err: any) {
        setError(err.response?.data?.error || err.message || 'Authentication failed');
        setLoading(false);
      }
    };

    return () => {
      delete (window as any).onTelegramAuth;
    };
  }, [onLogin]);

  async function handlePasscodeSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!passcode) return;

    setLoading(true);
    setError('');
    try {
      const response = await api.post('/auth/dev-login', { password: passcode });
      if (response.data?.success && response.data?.data?.token) {
        onLogin(response.data.data.token);
      } else {
        setError(response.data?.error || 'Authentication failed');
        setLoading(false);
      }
    } catch (err: any) {
      setError(err.response?.data?.error || err.message || 'Authentication failed');
      setLoading(false);
    }
  }

  // Construct the Telegram Widget iframe source URL directly
  const iframeSrc = `https://oauth.telegram.org/embed/${botUsername}?origin=${encodeURIComponent(
    origin
  )}&size=large&radius=12&request_access=write`;

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-surface-50 via-primary-50/30 to-accent-500/5 dark:from-surface-950 dark:via-surface-900 dark:to-primary-900/10 p-4">
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-40 -right-40 w-80 h-80 bg-primary-500/10 rounded-full blur-3xl" />
        <div className="absolute -bottom-40 -left-40 w-80 h-80 bg-accent-500/10 rounded-full blur-3xl" />
      </div>

      <motion.div
        initial={{ opacity: 0, y: 20, scale: 0.95 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        className="w-full max-w-md bg-white dark:bg-surface-900 rounded-3xl shadow-xl border border-surface-200/50 dark:border-surface-800/50 overflow-hidden relative z-10"
      >
        <div className="p-8 sm:p-10 flex flex-col items-center">
          <div className="flex flex-col items-center mb-8">
            <div className="w-16 h-16 bg-gradient-to-br from-primary-500 to-accent-500 rounded-2xl flex items-center justify-center shadow-glow mb-6">
              <Cloud className="w-8 h-8 text-white" />
            </div>
            <h1 className="text-2xl font-bold text-surface-900 dark:text-white mb-2">
              Welcome to TeleDrive
            </h1>
            <p className="text-surface-500 dark:text-surface-400 text-center">
              Sign in with Telegram, or use your local developer passcode.
            </p>
          </div>

          {error && (
            <motion.div
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              className="p-3 bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 rounded-xl text-red-600 dark:text-red-400 text-sm w-full mb-6 text-center"
            >
              {error}
            </motion.div>
          )}

          {loading ? (
            <div className="flex flex-col items-center text-primary-500">
              <Loader2 className="w-8 h-8 animate-spin mb-4" />
              <p className="text-sm font-medium">Authenticating...</p>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-6 w-full">
              {/* Telegram Widget Container */}
              <div className="flex justify-center w-full min-h-[44px]">
                <iframe
                  src={iframeSrc}
                  width="180"
                  height="44"
                  className="border-none overflow-hidden"
                  scrolling="no"
                  title="Telegram Login Button"
                />
              </div>

              {/* Divider */}
              <div className="flex items-center w-full my-1">
                <hr className="w-full border-surface-200 dark:border-surface-800" />
                <span className="px-3 text-xs text-surface-400 dark:text-surface-500 font-medium whitespace-nowrap bg-white dark:bg-surface-900">
                  OR
                </span>
                <hr className="w-full border-surface-200 dark:border-surface-800" />
              </div>

              {/* Dev Passcode Login Form */}
              <form onSubmit={handlePasscodeSubmit} className="w-full flex flex-col gap-3">
                <div className="relative">
                  <KeyRound className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-surface-400 dark:text-surface-500" />
                  <input
                    type="password"
                    placeholder="Enter your JWT_SECRET passcode"
                    value={passcode}
                    onChange={(e) => setPasscode(e.target.value)}
                    className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-surface-200 dark:border-surface-800 text-sm bg-surface-50/50 dark:bg-surface-850/50 focus:outline-none focus:border-primary-500 dark:focus:border-primary-400"
                  />
                </div>
                <button type="submit" className="btn-primary w-full py-2.5">
                  Sign in with Passcode
                </button>
              </form>
            </div>
          )}
        </div>
      </motion.div>
    </div>
  );
}
