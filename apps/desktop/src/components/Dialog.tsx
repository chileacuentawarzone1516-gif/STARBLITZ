import { useEffect, useRef, type ReactNode } from 'react';
import { create } from 'zustand';

interface DialogProps {
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  onClose: () => void;
  wide?: boolean;
  busy?: boolean;
}

/** Diálogo modal accesible: foco inicial, Escape para cerrar y foco atrapado. */
export function Dialog({ title, description, children, actions, onClose, wide, busy }: DialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const node = ref.current;
    const focusable = () => Array.from(node?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])') ?? []);
    (focusable().find((el) => el.dataset.autofocus !== undefined) ?? focusable()[0])?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) { e.stopPropagation(); onClose(); }
      if (e.key === 'Tab') {
        const items = focusable();
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      previous?.focus?.();
    };
  }, [onClose, busy]);

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="dlg-title" ref={ref}
        style={wide ? { width: 'min(820px, 100%)' } : undefined}>
        <h2 id="dlg-title">{title}</h2>
        {description && <p className="muted" style={{ marginBottom: 14 }}>{description}</p>}
        {children}
        {actions && <div className="dialog-actions">{actions}</div>}
      </div>
    </div>
  );
}

interface ConfirmRequest {
  title: string;
  message: string;
  confirm: string;
  danger?: boolean;
  resolve: (ok: boolean) => void;
}

const useConfirmStore = create<{ req: ConfirmRequest | null; set: (r: ConfirmRequest | null) => void }>((set) => ({
  req: null,
  set: (req) => set({ req }),
}));

/** Confirmación imperativa: `if (await confirmAction({...})) ...` */
export function confirmAction(opts: Omit<ConfirmRequest, 'resolve'>): Promise<boolean> {
  return new Promise((resolve) => useConfirmStore.getState().set({ ...opts, resolve }));
}

export function ConfirmHost() {
  const { req, set } = useConfirmStore();
  if (!req) return null;
  const close = (ok: boolean) => { req.resolve(ok); set(null); };
  return (
    <Dialog title={req.title} description={req.message} onClose={() => close(false)}
      actions={<>
        <button className="btn btn-ghost" onClick={() => close(false)}>Cancelar</button>
        <button className={`btn ${req.danger ? 'btn-danger' : 'btn-primary'}`} data-autofocus onClick={() => close(true)}>{req.confirm}</button>
      </>} />
  );
}
