export function ensureRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(message);
  }
  return value as Record<string, unknown>;
}

export function normalizeQuery(value: string): string[] {
  return value
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

export function includesInsensitive(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

export function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

function isSensitiveKey(key: string): boolean {
  return /(token|secret|password|jwt|api[_-]?key|access[_-]?token|private[_-]?key|authorization|cookie|credential|auth_token|key$)/i.test(
    key,
  );
}

export function redactSensitiveData<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveData(item)) as T;
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(input)) {
    if (isSensitiveKey(key)) {
      output[key] = "[REDACTED]";
      continue;
    }
    output[key] = redactSensitiveData(item);
  }
  return output as T;
}

export interface SearchMatch {
  path: string;
  key: string;
  valuePreview: string;
}

export interface SearchConfigOptions {
  keyQuery: string;
  valueQuery?: string | null;
  caseSensitive?: boolean;
  maxResults?: number;
}

export function searchObject(
  root: unknown,
  options: SearchConfigOptions,
): SearchMatch[] {
  const keyQuery = options.caseSensitive
    ? options.keyQuery
    : options.keyQuery.toLowerCase();
  const valueQuery = options.valueQuery
    ? options.caseSensitive
      ? options.valueQuery
      : options.valueQuery.toLowerCase()
    : null;
  const maxResults = options.maxResults ?? 30;
  const results: SearchMatch[] = [];

  const visit = (value: unknown, path: string[]) => {
    if (results.length >= maxResults) {
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, [...path, String(index)]));
      return;
    }
    if (value && typeof value === "object") {
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        const keyTarget = options.caseSensitive ? key : key.toLowerCase();
        let matched = keyTarget.includes(keyQuery);
        const previewSource =
          item === null || ["string", "number", "boolean"].includes(typeof item)
            ? String(item)
            : "";
        if (matched && valueQuery) {
          const previewTarget = options.caseSensitive
            ? previewSource
            : previewSource.toLowerCase();
          matched = previewTarget.includes(valueQuery);
        }
        if (matched) {
          results.push({
            path: [...path, key].join("."),
            key,
            valuePreview: truncate(previewSource, 180),
          });
          if (results.length >= maxResults) {
            return;
          }
        }
        visit(item, [...path, key]);
      }
    }
  };

  visit(root, []);
  return results;
}
