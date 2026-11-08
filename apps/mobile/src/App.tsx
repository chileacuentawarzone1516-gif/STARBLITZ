import { FolderOpen, Layers, Settings as SettingsIcon, Sparkles } from 'lucide-react';
import { useEffect } from 'react';
import { ConfirmDialog, Toasts } from './components/ui';
import { initNative, tap } from './lib/platform';
import { navigate, useRoute } from './router';
import { MobileEditor } from './screens/Editor';
import { Home } from './screens/Home';
import { ImportSheet } from './screens/ImportSheet';
import { Models } from './screens/Models';
import { ProjectContext } from './screens/ProjectContext';
import { ProjectScreen } from './screens/ProjectScreen';
import { Reader } from './screens/Reader';
import { SettingsScreen } from './screens/Settings';
import { handleBack, useApp } from './state/app';

function BottomNav() {
  const { path } = useRoute();
  const openSheet = useApp((s) => s.openSheet);
  const go = (to: string) => () => { tap(); navigate(to); };
  return (
    <nav className="m-bottom-nav" aria-label="Navegación principal">
      <button className={path === '/' || path.startsWith('/p/') ? 'on' : ''} aria-current={path === '/' ? 'page' : undefined} onClick={go('/')}><FolderOpen /><span>Proyectos</span></button>
      <button className={path.startsWith('/models') ? 'on' : ''} aria-current={path.startsWith('/models') ? 'page' : undefined} onClick={go('/models')}><Layers /><span>Modelos</span></button>
      <button className="m-star" aria-label="Importar capítulo" onClick={() => { tap('medium'); openSheet('import'); }}><Sparkles /></button>
      <button className={path.startsWith('/settings') ? 'on' : ''} aria-current={path.startsWith('/settings') ? 'page' : undefined} onClick={go('/settings')}><SettingsIcon /><span>Ajustes</span></button>
    </nav>
  );
}

function Boot() {
  const boot = useApp((s) => s.boot);
  const error = useApp((s) => s.bootError);
  return (
    <div className="m-boot" role="status" aria-live="polite">
      <div className="m-boot-logo" aria-hidden><Sparkles /></div>
      <h1>STARBLITZ</h1>
      {boot === 'loading' ? <><span className="spinner" /><p className="muted">Preparando el motor en tu teléfono…</p></> : (
        <>
          <p className="text-warn">No se pudo iniciar el motor.</p>
          <p className="small muted">{error}</p>
          <button className="btn btn-primary" onClick={() => window.location.reload()}>Reintentar</button>
        </>
      )}
    </div>
  );
}

export function App() {
  const boot = useApp((s) => s.boot);
  const { parts } = useRoute();

  useEffect(() => {
    void initNative(handleBack);
    void useApp.getState().start();
  }, []);

  if (boot !== 'ready') return <Boot />;

  const [section, id, mode, n] = parts;
  let screen;
  let immersive = false;
  if (section === 'p' && id && mode === 'read') { screen = <Reader key={id} id={id} start={Number(n) || 0} />; immersive = true; }
  else if (section === 'p' && id && mode === 'edit') { screen = <MobileEditor key={`${id}-${n}`} id={id} start={Number(n) || 0} />; immersive = true; }
  else if (section === 'p' && id && mode === 'context') screen = <ProjectContext key={id} id={id} />;
  else if (section === 'p' && id) screen = <ProjectScreen key={id} id={id} />;
  else if (section === 'models') screen = <Models />;
  else if (section === 'settings') screen = <SettingsScreen />;
  else screen = <Home />;

  return (
    <div className={`m-app ${immersive ? 'immersive' : ''}`}>
      <main className="m-main">{screen}</main>
      {!immersive && <BottomNav />}
      <ImportSheet />
      <ConfirmDialog />
      <Toasts />
    </div>
  );
}
