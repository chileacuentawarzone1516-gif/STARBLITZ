import { useState } from 'react';
import { Segmented, TopBar } from '../components/ui';
import { Compare } from './models/Compare';
import { Explore } from './models/Explore';
import { Installed } from './models/Installed';
import { Recommended } from './models/Recommended';
import { useLLM } from './models/shared';
import { Vision } from './models/Vision';

type Tab = 'recommended' | 'explore' | 'installed' | 'vision' | 'compare';
const TABS: { id: Tab; label: string }[] = [
  { id: 'recommended', label: 'Para ti' }, { id: 'explore', label: 'Explorar' }, { id: 'installed', label: 'Instalados' },
  { id: 'vision', label: 'Visión' }, { id: 'compare', label: 'Comparar' },
];

export function Models() {
  const { data: llm, reload } = useLLM();
  const [tab, setTab] = useState<Tab>('recommended');
  return (
    <div className="m-screen">
      <TopBar title="Modelos" sub="Se descargan una vez; después, sin conexión" />
      <div className="m-tabs"><Segmented<Tab> label="Secciones" value={tab} options={TABS} onChange={setTab} /></div>
      {tab === 'vision' ? <Vision /> : !llm ? <div className="m-center"><span className="spinner" /></div> : (
        tab === 'recommended' ? <Recommended llm={llm} />
          : tab === 'explore' ? <Explore llm={llm} />
          : tab === 'installed' ? <Installed llm={llm} reload={reload} goTo={(t) => setTab(t as Tab)} />
          : <Compare llm={llm} goTo={(t) => setTab(t as Tab)} />
      )}
    </div>
  );
}
