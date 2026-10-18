/** Sensitive/hostile free text is omitted, not silently treated as exact evidence. */
export function sanitizedCanaryArtifact(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > 4096 ||
        [...value].some((char) => {
          const code = char.codePointAt(0)!;
          return code <= 31 || code === 127 ||
            (code >= 0x202a && code <= 0x202e) ||
            (code >= 0x2066 && code <= 0x2069);
        }) ||
        /(?:gh[psuor]_[A-Za-z0-9_]{12,}|github_pat_|Bearer\s|-----BEGIN|(?:token|secret|password)\s*[=:])/i
          .test(value)
      ? { omitted: "unsafe_text" }
      : value;
  }
  if (
    value === null || typeof value === "number" || typeof value === "boolean"
  ) return value;
  if (Array.isArray(value)) return value.map(sanitizedCanaryArtifact);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map((
        [key, item],
      ) => [key, sanitizedCanaryArtifact(item)]),
    );
  }
  return null;
}
