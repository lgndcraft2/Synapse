/**
 * The cognitive-profile field catalogue.
 *
 * Values must match `ProfileUpdate` in backend/app/schemas/schemas.py exactly —
 * they are `Literal[...]` constrained there, and several contain spaces
 * ("bullet points"), so they are sent verbatim. The user-facing copy is lifted
 * from the extension onboarding so the web and the extension describe the same
 * settings in the same words.
 */

export type ProfileType = 'load-reducer' | 'comprehension-gap' | 'hyperfocus';
export type PreferredFormat =
  | 'bullet points'
  | 'short paragraphs'
  | 'numbered steps'
  | 'plain flowing prose';
export type ChunkSize = 'short' | 'medium' | 'long';
export type NestingDepth = 1 | 2 | 3;

/** The eight fields `PATCH /api/v1/profile` accepts. Nothing else is editable. */
export interface ProfileFields {
  profile_type: ProfileType;
  preferred_format: PreferredFormat;
  chunk_size: ChunkSize;
  needs_examples_first: boolean;
  simplify_vocab: boolean;
  max_nesting_depth: NestingDepth;
  use_headers: boolean;
  notes: string;
}

/** Matches the row the backend creates on first sign-in (auth.py). */
export const PROFILE_DEFAULTS: ProfileFields = {
  profile_type: 'load-reducer',
  preferred_format: 'bullet points',
  chunk_size: 'short',
  needs_examples_first: true,
  simplify_vocab: false,
  max_nesting_depth: 2,
  use_headers: true,
  notes: '',
};

/** Backend enforces max_length=1000 on notes. */
export const NOTES_MAX = 1000;

export const READING_TYPES: {
  value: ProfileType;
  icon: string;
  title: string;
  description: string;
}[] = [
  {
    value: 'load-reducer',
    icon: 'bolt',
    title: 'I struggle to stay focused while reading',
    description:
      'I lose the thread, get distracted, or need to re-read things. Dense pages are exhausting.',
  },
  {
    value: 'comprehension-gap',
    icon: 'search',
    title: 'I can read fine, but meaning gets lost',
    description:
      "I finish a paragraph and don't know what it was really saying. I miss subtext and implied meaning.",
  },
  {
    value: 'hyperfocus',
    icon: 'menu_book',
    title: 'I read a lot — I just need better structure',
    description:
      'I can hyperfocus on reading, but I need help organizing, retaining, and navigating information.',
  },
];

/** Short names for the three types, as used by the dashboard and popup. */
export const PROFILE_TYPE_LABELS: Record<ProfileType, string> = {
  'load-reducer': 'Load Reducer',
  'comprehension-gap': 'Comprehension Gap',
  hyperfocus: 'Hyperfocus Reader',
};

export const FORMATS: { value: PreferredFormat; label: string; hint: string }[] = [
  { value: 'bullet points', label: 'Bullet points & lists', hint: 'Short, scannable items' },
  { value: 'short paragraphs', label: 'Short paragraphs', hint: 'Brief, focused prose' },
  { value: 'numbered steps', label: 'Numbered steps', hint: 'Clear sequential order' },
  { value: 'plain flowing prose', label: 'Plain prose', hint: 'Natural, flowing text' },
];

export const CHUNK_SIZES: { value: ChunkSize; label: string }[] = [
  { value: 'short', label: 'Short' },
  { value: 'medium', label: 'Medium' },
  { value: 'long', label: 'Long' },
];

export const NESTING_DEPTHS: { value: NestingDepth; label: string; hint: string }[] = [
  { value: 1, label: '1', hint: 'Flat only' },
  { value: 2, label: '2', hint: 'One level of sub-points' },
  { value: 3, label: '3', hint: 'Full nesting' },
];

/** The three boolean refinements, with the onboarding's explanations. */
export const TOGGLES: {
  key: 'needs_examples_first' | 'simplify_vocab' | 'use_headers';
  title: string;
  description: string;
}[] = [
  {
    key: 'needs_examples_first',
    title: 'Examples first',
    description: 'Lead with a concrete example before the explanation, rather than after it.',
  },
  {
    key: 'simplify_vocab',
    title: 'Simplify vocabulary',
    description: "Swap jargon for plainer words where it won't lose the meaning.",
  },
  {
    key: 'use_headers',
    title: 'Section headers',
    description: 'Break longer passages up with clear headers instead of a headerless flow.',
  },
];

/** Human labels for the history diff, keyed by the backend's field names. */
export const FIELD_LABELS: Record<string, string> = {
  profile_type: 'Reading type',
  preferred_format: 'Preferred format',
  chunk_size: 'Chunk size',
  needs_examples_first: 'Examples first',
  simplify_vocab: 'Simplify vocabulary',
  max_nesting_depth: 'Nesting depth',
  use_headers: 'Section headers',
  notes: 'Personal notes',
};

/** Render any profile value for display in the history diff. */
export function formatFieldValue(field: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return 'empty';
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  if (field === 'profile_type') {
    return PROFILE_TYPE_LABELS[value as ProfileType] || String(value);
  }
  if (field === 'notes') {
    const text = String(value);
    return text.length > 60 ? `${text.slice(0, 60)}…` : text;
  }
  return String(value);
}

/** Pick only the eight editable fields off a full ProfileOut payload. */
export function toFields(profile: Record<string, any> | null): ProfileFields {
  if (!profile) return { ...PROFILE_DEFAULTS };
  return {
    profile_type: profile.profile_type ?? PROFILE_DEFAULTS.profile_type,
    preferred_format: profile.preferred_format ?? PROFILE_DEFAULTS.preferred_format,
    chunk_size: profile.chunk_size ?? PROFILE_DEFAULTS.chunk_size,
    needs_examples_first: profile.needs_examples_first ?? PROFILE_DEFAULTS.needs_examples_first,
    simplify_vocab: profile.simplify_vocab ?? PROFILE_DEFAULTS.simplify_vocab,
    max_nesting_depth: profile.max_nesting_depth ?? PROFILE_DEFAULTS.max_nesting_depth,
    use_headers: profile.use_headers ?? PROFILE_DEFAULTS.use_headers,
    notes: profile.notes ?? PROFILE_DEFAULTS.notes,
  };
}

/** The keys whose values differ between two field sets. */
export function changedKeys(a: ProfileFields, b: ProfileFields): (keyof ProfileFields)[] {
  return (Object.keys(a) as (keyof ProfileFields)[]).filter((k) => a[k] !== b[k]);
}
