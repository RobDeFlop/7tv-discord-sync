/** Discord emoji names: 2-32 chars of [A-Za-z0-9_]. */
export const MAX_NAME_LENGTH = 32;

export function sanitizeName(raw: string): string {
  let name = raw.replace(/[^A-Za-z0-9_]/g, "_").slice(0, MAX_NAME_LENGTH);
  while (name.length < 2) name += "_";
  return name;
}

/**
 * Returns a name not in `taken` (case-insensitive): the sanitised name itself,
 * or with a `_2`, `_3`, ... suffix that still fits in 32 chars.
 */
export function uniqueName(raw: string, taken: Iterable<string>): { name: string; suffixed: boolean } {
  const used = new Set([...taken].map((n) => n.toLowerCase()));
  const base = sanitizeName(raw);
  if (!used.has(base.toLowerCase())) return { name: base, suffixed: false };
  for (let n = 2; ; n++) {
    const suffix = `_${n}`;
    const name = base.slice(0, MAX_NAME_LENGTH - suffix.length) + suffix;
    if (!used.has(name.toLowerCase())) return { name, suffixed: true };
  }
}
