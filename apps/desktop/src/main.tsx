import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../../shared/src/styles/tokens.css';
import './styles/app.css';
import { App } from './App';
import { bridge } from './bridge';
import { flushPending } from './editor/useEditor';

// Al cerrar la ventana se guardan las ediciones que aún esperaban su escritura diferida.
bridge?.onFlushBeforeClose?.(flushPending);

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
