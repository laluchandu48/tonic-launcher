import { useEffect } from 'react';

/** Right-hand panel used for the create flows, as in the Tonic dashboard. */
export default function Drawer({ title, open, onClose, children, footer }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="drawer-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={title}>
        <header className="drawer-head"><h2>{title}</h2></header>
        <div className="drawer-body">{children}</div>
        <footer className="drawer-foot">{footer}</footer>
      </aside>
    </div>
  );
}
