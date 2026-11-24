const REDACTED = "[REDACTED_SECRET]";
const SECRET_SUFFIXES = ["apikey", "secret", "token", "password", "passwd", "credential", "credentials", "privatekey"];

function secretKey(key: string): boolean {
  const words = key
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[_.\-\d]+/)
    .filter(Boolean);
  return words.some((word, i) =>
    word === "auth" || word === "authorization" ||
    SECRET_SUFFIXES.some((suffix) => word.endsWith(suffix)) ||
    ((word === "api" || word === "private") && words[i + 1] === "key"),
  );
}

function redactPrivateBlocks(text: string): string {
  const tags = /<private(?=\s|>)[^>]*>|<\/private\s*>/gi;
  let output = "";
  let cursor = 0;
  let depth = 0;
  for (const match of text.matchAll(tags)) {
    const closing = /^<\//.test(match[0]);
    if (depth === 0) {
      if (closing) continue;
      output += text.slice(cursor, match.index);
      depth = 1;
    } else if (closing) {
      if (--depth === 0) {
        output += REDACTED;
        cursor = match.index + match[0].length;
      }
    } else {
      depth++;
    }
  }
  return depth ? output + REDACTED : output + text.slice(cursor);
}

export function redactText(text: string): string {
  let safe = redactPrivateBlocks(text)
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g, REDACTED)
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@:"'<>]*:[^\s/?#@"'<>]+@/gi, `$1${REDACTED}@`)
    .replace(/\bBearer\s+[A-Za-z0-9._~+\-/=]+/gi, `Bearer ${REDACTED}`);
  safe = safe.replace(
    /(?<![\w.-])(["']?)([\w.-]+)\1(\s*[:=]\s*)(Bearer\s+\[REDACTED_SECRET\]|\[REDACTED_SECRET\]|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;{}\[\]&<>"']+)/g,
    (match, quote: string, key: string, separator: string, value: string) => {
      if (!secretKey(key)) return match;
      const valueQuote = /^["']/.test(value) ? value[0] : "";
      return `${quote}${key}${quote}${separator}${valueQuote}${REDACTED}${valueQuote}`;
    },
  );
  return safe
    .replace(/(?<![\p{L}\p{N}\p{M}_])(?:sk-proj-|sk-ant-|sk-|pk-|rk-|ak-)[A-Za-z0-9_-]{20,}/gu, REDACTED)
    .replace(/(?:gh[pus]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,}|xoxb-[A-Za-z0-9-]+|AKIA[0-9A-Z]{16}|AIza[A-Za-z0-9_-]{35}|npm_[A-Za-z0-9]{36}|glpat-[A-Za-z0-9_-]{20,}|dop_v1_[A-Za-z0-9]{64})/g, REDACTED)
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, REDACTED);
}

export function redactRecord<T>(value: T): T {
  if (typeof value === "string") return redactText(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactRecord(item)) as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        secretKey(key) && item != null && item !== "" ? REDACTED : redactRecord(item),
      ]),
    ) as T;
  }
  return value;
}

export function sliceCapture(value: unknown, max: number): string {
  if (value == null) return "";
  try {
    const safe = typeof value === "string"
      ? redactText(value)
      : JSON.stringify(redactRecord(value));
    const end = safe.length > max && /[\uD800-\uDBFF]/.test(safe[max - 1] ?? "")
      ? max - 1
      : max;
    return safe.slice(0, end);
  } catch {
    return "";
  }
}
