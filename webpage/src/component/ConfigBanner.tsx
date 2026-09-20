import { isBackendConfigured } from '../lib/auth';

export default function ConfigBanner() {
  if (isBackendConfigured) return null;

  return (
    <div style={{
      backgroundColor: '#ba1a1a',
      color: 'white',
      padding: '12px 20px',
      textAlign: 'center',
      fontSize: '14px',
      fontWeight: '600',
      position: 'sticky',
      top: 0,
      zIndex: 1000,
      boxShadow: '0 2px 8px rgba(0,0,0,0.2)'
    }}>
      ⚠️ Backend not configured: set VITE_BACKEND_URL in your .env file. Sign-in and all data loading will fail without it.
    </div>
  );
}
