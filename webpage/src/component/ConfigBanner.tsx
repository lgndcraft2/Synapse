import { isSupabaseConfigured } from '../lib/supabase';

export default function ConfigBanner() {
  if (isSupabaseConfigured) return null;

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
      ⚠️ Supabase Configuration Required: Please set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in your .env file.
    </div>
  );
}
