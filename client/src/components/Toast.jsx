import { createContext, useCallback, useContext, useMemo, useState } from 'react';

const ToastContext = createContext(null);

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const push = useCallback((message, tone = 'info', ttl = 5200) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((all) => [...all, { id, message, tone }]);
    setTimeout(() => setToasts((all) => all.filter((t) => t.id !== id)), ttl);
  }, []);

  const value = useMemo(() => ({
    success: (m) => push(m, 'success'),
    error: (m) => push(m, 'error', 8000),
    info: (m) => push(m, 'info'),
  }), [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.tone}`}>{t.message}</div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
