/**
 * Resolves the backend API base URL for split frontend/backend deployments
 * (e.g., Vite SPA hosted on Vercel calling Express backend hosted on Railway).
 *
 * - Set `VITE_API_BASE_URL` in Vercel Environment Variables to the public Railway domain
 *   (e.g., `https://your-service.up.railway.app`).
 * - When unset (local dev, AI Studio preview, or single-origin Railway deploy),
 *   falls back to the current origin (same-origin `/api/*`).
 */
const configuredBase = (
  import.meta.env.VITE_API_BASE_URL ||
  import.meta.env.VITE_BACKEND_URL ||
  ''
)
  .trim()
  .replace(/\/+$/, '');

export function getApiBaseUrl(): string {
  if (configuredBase) return configuredBase;
  return typeof window !== 'undefined' ? window.location.origin : '';
}

export function apiUrl(path: string): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return configuredBase ? `${configuredBase}${normalizedPath}` : normalizedPath;
}
