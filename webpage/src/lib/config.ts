/**
 * Where the API lives. The one place the dashboard decides it.
 *
 * `npm run dev` talks to the local backend; a production build (Vercel) talks
 * to the live API. Nothing has to be configured for either. VITE_BACKEND_URL
 * still wins when set, for a staging backend or when the API moves hosts.
 */

const DEV_BACKEND_URL = 'http://localhost:8000';
const PROD_BACKEND_URL = 'https://api.usesynapse.cv';

export const BACKEND_URL = (
  import.meta.env.VITE_BACKEND_URL || (import.meta.env.PROD ? PROD_BACKEND_URL : DEV_BACKEND_URL)
).replace(/\/+$/, '');
