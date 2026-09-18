import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './ui.css';

const container = document.getElementById('root');
if (!container) throw new Error('missing #root');
createRoot(container).render(<App />);
