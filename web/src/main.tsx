import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { colors } from '@shared/ui/theme';
import { App } from './App';
import './styles.css';

// The shared palette becomes CSS variables, so styles.css and the mobile app stay one theme.
for (const [name, value] of Object.entries(colors)) {
  document.documentElement.style.setProperty(`--${name}`, value);
}

// The shared backend client calls the API by its full URL. Until the server
// answers CORS, dev builds send those calls through Vite's /api proxy.
if (import.meta.env.DEV) {
  const direct = window.fetch.bind(window);
  window.fetch = (input, init) =>
    direct(typeof input === 'string' && input.startsWith(__BACKEND_URL__) ? `/api${input.slice(__BACKEND_URL__.length)}` : input, init);
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
