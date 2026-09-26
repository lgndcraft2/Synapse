import { useState } from 'react';

export const AVATAR_OPTIONS = [
  ['aurora', 'Aurora', '#b8d9ff', '#2458a6', '#f7b2d8'],
  ['bay', 'Bay', '#b8eee5', '#006b62', '#75b7ff'],
  ['cinder', 'Cinder', '#e1d6ff', '#5d3c99', '#ec9b72'],
  ['dune', 'Dune', '#f5ddb0', '#9b5f1a', '#e78961'],
  ['ember', 'Ember', '#ffd6ca', '#ae3c2a', '#f3b943'],
  ['fern', 'Fern', '#cfe8bd', '#367247', '#78b996'],
  ['glacier', 'Glacier', '#c6ebf5', '#19738d', '#7f9be0'],
  ['harbor', 'Harbor', '#d5e1f5', '#365d9d', '#e3a8bd'],
  ['indigo', 'Indigo', '#d9d2ff', '#4d45a2', '#8fbcdd'],
  ['juniper', 'Juniper', '#c9e6da', '#12664f', '#e5bc6f'],
  ['koi', 'Koi', '#ffe0b6', '#b34c2e', '#7caec9'],
  ['lilac', 'Lilac', '#ead7f3', '#79578d', '#e3a5c7'],
  ['moss', 'Moss', '#dce6b6', '#5e742b', '#8cb77a'],
  ['nova', 'Nova', '#d7d8fb', '#5451a7', '#f2b1a9'],
  ['ochre', 'Ochre', '#f6dca8', '#9a641b', '#d67e59'],
] as const;

type AvatarOption = (typeof AVATAR_OPTIONS)[number];

export function builtInAvatarId(avatarUrl?: string | null): string | null {
  if (!avatarUrl?.startsWith('avatar:')) return null;
  const id = avatarUrl.slice('avatar:'.length);
  return AVATAR_OPTIONS.some(([candidate]) => candidate === id) ? id : null;
}

function initialsFor(name?: string | null, email?: string | null): string {
  if (name?.trim()) {
    return name
      .trim()
      .split(/\s+/)
      .map((part) => part[0])
      .join('')
      .slice(0, 2)
      .toUpperCase();
  }
  return email?.[0]?.toUpperCase() || '·';
}

function Illustration({ option }: { option: AvatarOption }) {
  const [, label, background, primary, accent] = option;
  return (
    <svg viewBox="0 0 64 64" role="img" aria-label={`${label} avatar`} focusable="false">
      <rect width="64" height="64" rx="32" fill={background} />
      <circle cx="24" cy="25" r="13" fill={primary} opacity="0.92" />
      <path d="M13 56c3-12 12-18 22-18s19 6 22 18" fill={primary} opacity="0.92" />
      <circle cx="43" cy="18" r="9" fill={accent} />
      <path d="M38 42c5-3 10-3 15 0" fill="none" stroke={accent} strokeWidth="5" strokeLinecap="round" />
    </svg>
  );
}

interface AvatarProps {
  avatarUrl?: string | null;
  name?: string | null;
  email?: string | null;
  size?: number;
  className?: string;
}

/** Render either an approved built-in avatar, Google's verified photo, or initials. */
export function Avatar({ avatarUrl, name, email, size = 40, className = '' }: AvatarProps) {
  const [imageFailed, setImageFailed] = useState(false);
  const selected = builtInAvatarId(avatarUrl);
  const option = AVATAR_OPTIONS.find(([id]) => id === selected);
  const sharedStyle = { width: size, height: size };

  if (option) {
    return (
      <span className={`avatar ${className}`.trim()} style={sharedStyle} aria-hidden="true">
        <Illustration option={option} />
      </span>
    );
  }

  if (avatarUrl && !imageFailed) {
    return (
      <span className={`avatar ${className}`.trim()} style={sharedStyle} aria-hidden="true">
        <img src={avatarUrl} alt="" referrerPolicy="no-referrer" onError={() => setImageFailed(true)} />
      </span>
    );
  }

  return (
    <span
      className={`avatar avatar-initials ${className}`.trim()}
      style={{ ...sharedStyle, fontSize: Math.max(12, Math.round(size * 0.32)) }}
      aria-hidden="true"
    >
      {initialsFor(name, email)}
    </span>
  );
}
