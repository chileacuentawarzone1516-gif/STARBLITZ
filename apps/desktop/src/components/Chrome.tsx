import { AlertTriangle, Boxes, CheckCircle2, FolderOpen, Home, Info, PenTool, Settings, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { navigate, useRoute } from '../router';
import { useApp } from '../store';

export function LogoMark({ size = 28 }: { size?: number }) {
  return <img src="./mark.svg" width={size} height={size} alt="" draggable={false} />;
}

export function TitleBar({ children }: { children?: ReactNode }) {
  const connected = useApp((s) => s.connected);
  return (
    <header className="titlebar">
      <div className="titlebar-brand">
        <LogoMark size={22} />
        <span className="wordmark">STARBLITZ</span>
      </div>
      <div className="titlebar-center">{children}</div>
      <div className="titlebar-status" title={connected ? 'Motor local conectado' : 'Reconectando con el motor local…'}>
        <span className={`status-dot ${connected ? 'on' : ''}`} />
        <span className="small muted">{connected ? 'Motor local activo' : 'Reconectando…'}</span>
      </div>
    </header>
  );
}

const NAV = [
  { path: '/', label: 'Inicio', icon: Home, match: (p: string) => p === '/' },
  { path: '/projects', label: 'Proyectos', icon: FolderOpen, match: (p: string) => p.startsWith('/project') },
  { path: '/editor', label: 'Editor', icon: PenTool, match: (p: string) => p.startsWith('/editor') },
  { path: '/models', label: 'Modelos', icon: Boxes, match: (p: string) => p.startsWith('/models') },
  { path: '/settings', label: 'Configuración', icon: Settings, match: (p: string) => p.startsWith('/settings') },
  { path: '/about', label: 'Acerca de', icon: Info, match: (p: string) => p.startsWith('/about') },
];

export function NavRail() {
  const { path } = useRoute();
  return (
    <nav className="navrail" aria-label="Secciones">
      {NAV.map(({ path: to, label, icon: Icon, match }) => (
        <button key={to} className={`nav-item ${match(path) ? 'active' : ''}`} aria-current={match(path) ? 'page' : undefined}
          onClick={() => navigate(to)}>
          <Icon aria-hidden />
          <span>{label}</span>
        </button>
      ))}
    </nav>
  );
}

export function Toasts() {
  const { toasts, dismiss } = useApp();
  return (
    <div className="toast-stack" style={{ right: 20, bottom: 20 }} role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`}>
          {t.kind === 'error' ? <AlertTriangle color="#fb7185" /> : t.kind === 'ok' ? <CheckCircle2 color="#34d399" /> : <Info color="#38bdf8" />}
          <div style={{ flex: 1 }}>
            <strong style={{ display: 'block' }}>{t.title}</strong>
            {t.message && <span className="small muted">{t.message}</span>}
          </div>
          <button className="btn btn-ghost btn-icon btn-sm" aria-label="Cerrar aviso" onClick={() => dismiss(t.id)}><X /></button>
        </div>
      ))}
    </div>
  );
}

export function EmptyState({ icon, title, children, action }: { icon: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon}</div>
      <h3>{title}</h3>
      {children && <p className="muted">{children}</p>}
      {action}
    </div>
  );
}
