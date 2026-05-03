/**
 * Input Guard — validates and sanitizes user messages before they reach the LLM.
 *
 * Does NOT aggressively block messages. Instead, flags suspicious patterns
 * and lets the hardened system prompt handle prompt injection attempts.
 * Only blocks messages that are purely injection attempts with no real content.
 */

export interface InputValidationResult {
  safe: boolean;
  sanitized: string;
  warnings: string[];
  blocked: boolean;
  reason?: string;
}

const DEFAULT_MAX_LENGTH = 2000;

// Injection patterns — case-insensitive, fuzzy matching
const INJECTION_PATTERNS: { pattern: RegExp; label: string }[] = [
  // Instruction override attempts
  { pattern: /ignore\s+(all\s+)?(previous|prior|above|your)\s+instructions/i, label: "instruction_override" },
  { pattern: /forget\s+(all\s+)?(your\s+)?instructions/i, label: "instruction_override" },
  { pattern: /disregard\s+(all\s+)?(previous|prior|above|your)\s+(instructions|rules|guidelines)/i, label: "instruction_override" },

  // Prompt extraction attempts
  { pattern: /reveal\s+(your\s+)?(system\s+)?prompt/i, label: "prompt_extraction" },
  { pattern: /show\s+(me\s+)?(your\s+)?(system\s+)?prompt/i, label: "prompt_extraction" },
  { pattern: /what\s+are\s+your\s+instructions/i, label: "prompt_extraction" },
  { pattern: /repeat\s+(your\s+)?(system\s+)?(prompt|instructions|rules)/i, label: "prompt_extraction" },
  { pattern: /print\s+(your\s+)?(system\s+)?(prompt|instructions)/i, label: "prompt_extraction" },
  { pattern: /output\s+(your\s+)?(system\s+)?(prompt|instructions)\s+(verbatim|exactly|word\s*for\s*word)/i, label: "prompt_extraction" },

  // Role hijacking
  { pattern: /you\s+are\s+now\s+/i, label: "role_hijack" },
  { pattern: /act\s+as\s+(a\s+|an\s+)?(?!if|though)/i, label: "role_hijack" },
  { pattern: /pretend\s+(you\s+are|to\s+be)/i, label: "role_hijack" },
  { pattern: /from\s+now\s+on\s+(you|your|ignore)/i, label: "role_hijack" },
  { pattern: /new\s+persona/i, label: "role_hijack" },
  { pattern: /switch\s+to\s+.{0,20}\s+mode/i, label: "role_hijack" },
  { pattern: /jailbreak/i, label: "role_hijack" },
  { pattern: /DAN\s+mode/i, label: "role_hijack" },
];

// HTML/script injection patterns to strip (XSS vectors)
const DANGEROUS_HTML_PATTERNS: RegExp[] = [
  /<script[\s>]/gi,
  /<\/script>/gi,
  /<img[^>]+onerror\s*=/gi,
  /<img[^>]+onload\s*=/gi,
  /<iframe[\s>]/gi,
  /<\/iframe>/gi,
  /<object[\s>]/gi,
  /<embed[\s>]/gi,
  /<link[^>]+rel\s*=\s*["']?import/gi,
  /on\w+\s*=\s*["'][^"']*["']/gi,
  /javascript\s*:/gi,
  /data\s*:\s*text\/html/gi,
];
// Regex matching zero-width and invisible Unicode characters
// U+200B-U+200F, U+2028-U+202F, U+2060-U+206F, U+FEFF
const ZERO_WIDTH_REGEX = new RegExp("[\u200B-\u200F\u2028-\u202F\u2060-\u206F\uFEFF]", "g");
const ZERO_WIDTH_CLUSTER_REGEX = new RegExp("[\u200B-\u200F\u2028-\u202F\u2060-\u206F\uFEFF]{3,}", "g");

/**
 * Validates and sanitizes user input before it reaches the LLM.
 */
export function validateInput(message: string, maxLength?: number): InputValidationResult {
  const limit = maxLength ?? DEFAULT_MAX_LENGTH;
  const warnings: string[] = [];

  // Empty message
  if (!message || message.trim().length === 0) {
    return { safe: true, sanitized: "", warnings: [], blocked: false };
  }

  // Length check — truncate if over limit
  let sanitized = message;
  if (sanitized.length > limit) {
    sanitized = sanitized.slice(0, limit);
    warnings.push("message_truncated");
  }

  // Check for base64 encoded strings (potential obfuscation)
  const base64Regex = /[A-Za-z0-9+/]{50,}={0,2}/g;
  const base64Matches = sanitized.match(base64Regex);
  if (base64Matches && base64Matches.length > 0) {
    warnings.push("base64_content_detected");
  }

  // Check for excessive unicode obfuscation (homoglyphs, zero-width chars, etc.)
  if (ZERO_WIDTH_CLUSTER_REGEX.test(sanitized)) {
    warnings.push("unicode_obfuscation");
    // Strip zero-width characters
    sanitized = sanitized.replace(ZERO_WIDTH_REGEX, "");
  }

  // Check for excessive special characters (more than 40% non-alphanumeric non-space)
  const alphaNumSpace = sanitized.replace(/[a-zA-Z0-9\s]/g, "");
  if (sanitized.length > 20 && alphaNumSpace.length / sanitized.length > 0.4) {
    warnings.push("excessive_special_chars");
  }

  // Check injection patterns
  let injectionCount = 0;
  for (const { pattern, label } of INJECTION_PATTERNS) {
    if (pattern.test(sanitized)) {
      if (!warnings.includes(label)) {
        warnings.push(label);
      }
      injectionCount++;
    }
  }

  // Strip dangerous HTML (XSS vectors in the widget)
  let hadDangerousHtml = false;
  for (const pattern of DANGEROUS_HTML_PATTERNS) {
    if (pattern.test(sanitized)) {
      hadDangerousHtml = true;
      sanitized = sanitized.replace(pattern, "");
    }
  }
  if (hadDangerousHtml) {
    warnings.push("dangerous_html_stripped");
  }

  // Determine if the message should be blocked entirely.
  // Only block if the message is PURELY an injection attempt with no legitimate content.
  const strippedContent = sanitized
    .replace(/ignore\s+(all\s+)?(previous|prior|above|your)\s+instructions/gi, "")
    .replace(/forget\s+(all\s+)?(your\s+)?instructions/gi, "")
    .replace(/reveal\s+(your\s+)?(system\s+)?prompt/gi, "")
    .replace(/show\s+(me\s+)?(your\s+)?(system\s+)?prompt/gi, "")
    .replace(/what\s+are\s+your\s+instructions/gi, "")
    .replace(/you\s+are\s+now\s+.*/gi, "")
    .replace(/pretend\s+(you\s+are|to\s+be)\s+.*/gi, "")
    .replace(/act\s+as\s+(a\s+|an\s+)?\w+/gi, "")
    .trim();

  // If after removing injection patterns there's almost nothing left, block it
  const blocked = injectionCount > 0 && strippedContent.length < 10;

  return {
    safe: warnings.length === 0,
    sanitized: sanitized.trim(),
    warnings,
    blocked,
    reason: blocked ? "Message appears to be solely a prompt injection attempt" : undefined,
  };
}
