import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

if (typeof window !== 'undefined') {
  // Catch and suppress HMR and benign WebSocket errors in sandbox to avoid console noise
  window.addEventListener('unhandledrejection', (event) => {
    if (
      event.reason && 
      (event.reason.message?.includes('WebSocket') || 
       event.reason.message?.includes('vite') ||
       event.reason.message?.includes('fetch') ||
       event.reason.toString().includes('WebSocket') ||
       event.reason.toString().includes('websocket') ||
       event.reason.toString().includes('fetch'))
    ) {
      event.preventDefault();
      event.stopPropagation();
    }
  });

  window.addEventListener('error', (event) => {
    if (
      event.message && 
      (event.message.includes('WebSocket') || 
       event.message.includes('vite') || 
       event.message.includes('hmr') ||
       event.message.includes('fetch') ||
       event.message.includes('websocket'))
    ) {
      event.preventDefault();
      event.stopPropagation();
    }
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

