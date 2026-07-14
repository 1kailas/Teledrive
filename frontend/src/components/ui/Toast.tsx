/**
 * TeleDrive — Toast Notification Component
 *
 * Stackable toast notifications with auto-dismiss and smooth animations.
 */

import { motion, AnimatePresence } from 'framer-motion';
import { X, CheckCircle, AlertCircle, Info, AlertTriangle } from 'lucide-react';
import { useToastStore } from '../../stores';
import type { ToastType } from '../../types';

const iconMap: Record<ToastType, React.ElementType> = {
  success: CheckCircle,
  error: AlertCircle,
  info: Info,
  warning: AlertTriangle,
};

const colorMap: Record<ToastType, string> = {
  success: 'text-emerald-500',
  error: 'text-red-500',
  info: 'text-blue-500',
  warning: 'text-amber-500',
};

const bgMap: Record<ToastType, string> = {
  success: 'border-emerald-500/20 bg-emerald-500/5',
  error: 'border-red-500/20 bg-red-500/5',
  info: 'border-blue-500/20 bg-blue-500/5',
  warning: 'border-amber-500/20 bg-amber-500/5',
};

export default function ToastContainer() {
  const { toasts, removeToast } = useToastStore();

  return (
    <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 pointer-events-none max-w-sm">
      <AnimatePresence mode="popLayout">
        {toasts.map((toast) => {
          const Icon = iconMap[toast.type];
          return (
            <motion.div
              key={toast.id}
              layout
              initial={{ opacity: 0, y: 20, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, x: 80, scale: 0.95 }}
              transition={{ type: 'spring', damping: 25, stiffness: 300 }}
              className={`pointer-events-auto flex items-start gap-3 px-4 py-3 rounded-xl border backdrop-blur-xl shadow-lg ${bgMap[toast.type]} bg-white/90 dark:bg-surface-900/90`}
            >
              <Icon className={`w-5 h-5 shrink-0 mt-0.5 ${colorMap[toast.type]}`} />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-slate-800 dark:text-white">
                  {toast.title}
                </p>
                {toast.message && (
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 line-clamp-2">
                    {toast.message}
                  </p>
                )}
              </div>
              <button
                onClick={() => removeToast(toast.id)}
                className="shrink-0 p-0.5 rounded-lg hover:bg-surface-200 dark:hover:bg-surface-700 transition-colors"
              >
                <X className="w-3.5 h-3.5 text-slate-400" />
              </button>
              {/* Auto-dismiss progress bar */}
              {toast.duration && toast.duration > 0 && (
                <motion.div
                  className={`absolute bottom-0 left-0 h-0.5 rounded-full ${colorMap[toast.type].replace('text-', 'bg-')}`}
                  initial={{ width: '100%' }}
                  animate={{ width: '0%' }}
                  transition={{ duration: toast.duration / 1000, ease: 'linear' }}
                />
              )}
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
