import { EngineClient } from '@starblitz/shared';
import { useEffect, useState } from 'react';
import { resolveConnection } from './bridge';
import { NavRail, TitleBar, Toasts } from './components/Chrome';
import { ConfirmHost } from './components/Dialog';
import { ImportFlowHost } from './components/ImportFlow';
import { EditorView } from './editor/EditorView';
import { useRoute } from './router';
import { useApp } from './store';
import { About } from './views/About';
import { ModelsView } from './views/Models';
import { Home } from './views/Home';
import { Projects } from './views/Projects';
import { ProjectView } from './views/ProjectView';
import { SettingsView } from './views/Settings';

function Routes() {
  const { parts } = useRoute();
  const [section, a, b] = parts;
  switch (section) {
    case undefined: return <Home />;
    case 'projects': return <Projects />;
    case 'project': return a ? <ProjectView key={a} id={a} /> : <Projects />;
    case 'editor': return <EditorView key={a ?? 'none'} projectId={a} pageId={b} />;
    case 'models': return <ModelsView tab={a} />;
    case 'settings': return a === 'models' ? <ModelsView /> : <SettingsView tab={a} />;
    case 'about': return <About />;
    default: return <Home />;
  }
}

export function App() {
  const [fatal, setFatal] = useState('');
  const client = useApp((s) => s.client);

  useEffect(() => {
    let unsubscribe = () => {};
    resolveConnection().then((conn) => {
      const c = new EngineClient(conn);
      const st = useApp.getState();
      st.setClient(c);
      st.refreshSystem();
      st.refreshProjects();
      c.jobs().then((jobs) => jobs.forEach((j) => st.upsertJob(j))).catch(() => undefined);
      unsubscribe = c.subscribe({
        job: (job) => useApp.getState().upsertJob(job),
        page: (e) => useApp.getState().applyPageEvent(e),
        run: (e) => useApp.getState().applyRunEvent(e),
        connection: (ok) => {
          useApp.getState().setConnected(ok);
          if (ok) {
            useApp.getState().refreshSystem();
            c.jobs().then((jobs) => jobs.forEach((j) => useApp.getState().upsertJob(j))).catch(() => undefined);
          }
        },
      });
    }).catch((e) => setFatal((e as Error).message));
    return () => unsubscribe();
  }, []);

  if (fatal) {
    return (
      <div className="fatal">
        <img src="./mark.svg" width={72} height={72} alt="" />
        <h2>No se pudo conectar con el motor</h2>
        <p className="muted">{fatal}</p>
      </div>
    );
  }

  return (
    <div className="app">
      <TitleBar />
      <div className="app-body">
        <NavRail />
        <main className="content" id="main">{client ? <Routes /> : <div className="page center"><div className="spinner" /></div>}</main>
      </div>
      <Toasts />
      <ImportFlowHost />
      <ConfirmHost />
    </div>
  );
}
