/**
 * Intent Matcher
 *
 * Fuzzy matching engine for detecting user intent regardless of exact phrasing.
 * Uses word combinations to detect security-sensitive operations.
 *
 * Balanced approach: requires action + target combination to trigger.
 */

// Action words that indicate doing something with version control or files
const GIT_ACTION_WORDS = [
  'git',
  'add',
  'commit',
  'stage',
  'push',
  'include',
  'track',
  'upload',
  'save',
  'check in',
  'checkin',
  'check-in',
  'put',
  'store',
  'submit',
  'publish',
];

// Sensitive file/content targets
const SENSITIVE_TARGETS = [
  // Environment files
  '.env',
  'env file',
  'environment',
  'dotenv',
  // Credentials
  'secret',
  'secrets',
  'credential',
  'credentials',
  'password',
  'passwords',
  'api key',
  'apikey',
  'api-key',
  'token',
  'tokens',
  'auth key',        // More specific than just "auth" to avoid "author", "authorization"
  'auth token',
  'authentication',
  // Keys and certificates
  'private key',
  'privatekey',
  'private-key',
  '.pem',
  '.key',
  '.p12',
  '.pfx',
  'certificate',
  'cert',
  // Config files that often contain secrets
  'config.json',
  'settings.json',
  'credentials.json',
  '.npmrc',
  '.pypirc',
  // AWS
  'aws_access',
  'aws_secret',
  'aws credentials',
  // Database
  'database url',
  'db password',
  'connection string',
];

// Safe template file suffixes that should NOT be blocked
const SAFE_TEMPLATE_SUFFIXES = [
  '.example',
  '.sample',
  '.template',
  '.dist',
  '.default',
];

// Dangerous/destructive action words
const DESTRUCTIVE_ACTIONS = [
  'force push',
  'force-push',
  '--force',
  'push -f',      // git push -f
  'push  -f',     // with extra space
  'reset --hard',
  'reset hard',
  'clean -f',
  'clean -fd',
  'delete all',
  'remove all',
  'rm -rf',
  'drop database',
  'drop table',
  'truncate',
  'wipe',         // Now safe: word boundary matching prevents "swipe" matching
];


// Words that indicate code content (for detecting secrets in code)
const CODE_CONTENT_INDICATORS = [
  'hardcode',
  'hard-code',
  'hard code',
  'inline',
  'embed',
  'write',
  'put in',
  'add to',
  'set to',
  'equals',
  '=',
];

export type IntentType =
  | 'committing-secrets'      // Adding sensitive files to git
  | 'hardcoding-secrets'      // Writing secrets directly in code
  | 'destructive-operation'   // Force push, reset hard, etc.
  | 'exposing-credentials';   // Discussing credentials in a risky context

export interface IntentMatch {
  type: IntentType;
  confidence: number;  // 0-1, higher = more certain
  matchedAction: string;
  matchedTarget: string;
  reasoning: string;
}

/**
 * Normalize text for matching
 * - Lowercase
 * - Normalize whitespace
 * - Keep special characters for file extensions
 */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract the relevant part of a git command for security checking
 * - For `git commit -m "message"`, ignore the message content
 * - For `git add file`, check the file
 * - Returns the command with commit messages stripped
 */
function extractGitCommandArgs(command: string): string {
  // Safety: limit input length to prevent regex DoS on extremely long strings
  const MAX_COMMAND_LENGTH = 2000;
  const safeCommand = command.length > MAX_COMMAND_LENGTH
    ? command.slice(0, MAX_COMMAND_LENGTH)
    : command;

  const normalized = normalize(safeCommand);

  // If it's a git commit with -m (including combined flags like -am, -sm, etc.)
  // Match: git commit -m, -am, -sm, --message, etc.
  const hasMessageFlag = /-m\s|--message\s|-[a-z]*m[a-z]*\s/.test(normalized);

  if (normalized.includes('git commit') && hasMessageFlag) {
    try {
      // Remove everything after -m flag (the message)
      // Handle both quoted and unquoted messages
      return normalized
        .replace(/-m\s*"[^"]*"/g, '')       // -m "message"
        .replace(/-m\s*'[^']*'/g, '')       // -m 'message'
        .replace(/-m\s*\$\([^)]*\)/g, '')   // -m $(heredoc)
        .replace(/-[a-z]*m\s*"[^"]*"/g, '') // -am "message", -sm "message"
        .replace(/-[a-z]*m\s*'[^']*'/g, '') // -am 'message'
        .replace(/--message\s*"[^"]*"/g, '')// --message "message"
        .replace(/--message\s*'[^']*'/g, '')// --message 'message'
        .replace(/-m\s*[^\s-]+/g, '')       // -m message (unquoted, single word)
        .replace(/-[a-z]*m\s*[^\s-]+/g, '') // -am message (unquoted)
        .replace(/--message\s*[^\s-]+/g, ''); // --message msg (unquoted)
    } catch {
      // If regex fails for any reason, return normalized string
      // This ensures the security check still runs on the raw command
      return normalized;
    }
  }

  return normalized;
}

/**
 * Check if text contains a word/phrase
 *
 * Uses word boundary matching for pure alphanumeric words to avoid false positives
 * e.g., "token" should not match "tokenize", "secret" should not match "secretary"
 *
 * Uses substring matching for patterns with special chars (.env, --force, api-key)
 * which are specific enough to not have false positive issues
 */
function containsWord(text: string, word: string): boolean {
  const normalizedText = normalize(text);
  const normalizedWord = normalize(word);

  // Pure alphanumeric words: use word boundary matching to avoid false positives
  if (/^[a-z0-9]+$/i.test(normalizedWord)) {
    const regex = new RegExp(`\\b${escapeRegex(normalizedWord)}\\b`, 'i');
    return regex.test(normalizedText);
  }

  // Patterns with special chars (.env, --force, api-key): use substring matching
  return normalizedText.includes(normalizedWord);
}

/**
 * Escape special regex characters
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Find the first matching word from a list
 */
function findMatchingWord(text: string, words: string[]): string | null {
  for (const word of words) {
    if (containsWord(text, word)) {
      return word;
    }
  }
  return null;
}


/**
 * Check if text contains a safe template file pattern
 * e.g., .env.example, .env.sample, config.template.json
 */
function containsSafeTemplateFile(text: string): boolean {
  const normalizedText = normalize(text);
  return SAFE_TEMPLATE_SUFFIXES.some(suffix => normalizedText.includes(suffix));
}

/**
 * Check if text matches an intent pattern
 *
 * Balanced approach:
 * - Requires BOTH action word AND target word
 * - Returns confidence based on specificity of match
 */
export function matchIntent(text: string, context?: {
  isCommand?: boolean;      // Is this a bash command?
  isCodeContent?: boolean;  // Is this code being written?
  hasGitContext?: boolean;  // Is there recent git activity?
}): IntentMatch | null {
  const normalizedText = normalize(text);

  // For commands, extract just the relevant args (ignore commit messages)
  const textForSecretCheck = context?.isCommand
    ? extractGitCommandArgs(text)
    : normalizedText;

  // 1. Check for destructive operations (these are action-only, no target needed)
  const destructiveAction = findMatchingWord(normalizedText, DESTRUCTIVE_ACTIONS);
  if (destructiveAction) {
    return {
      type: 'destructive-operation',
      confidence: 0.9,
      matchedAction: destructiveAction,
      matchedTarget: '',
      reasoning: `Detected destructive action: "${destructiveAction}"`,
    };
  }

  // 2. Check for committing secrets (action + sensitive target)
  // Use textForSecretCheck which strips commit message content for commands
  const gitAction = findMatchingWord(textForSecretCheck, GIT_ACTION_WORDS);
  const sensitiveTarget = findMatchingWord(textForSecretCheck, SENSITIVE_TARGETS);

  // Skip if this is a safe template file (e.g., .env.example)
  if (gitAction && sensitiveTarget && containsSafeTemplateFile(textForSecretCheck)) {
    // Template files are safe to commit
    return null;
  }

  if (gitAction && sensitiveTarget) {
    // High confidence if both are present
    let confidence = 0.8;

    // Boost confidence for specific file extensions
    if (sensitiveTarget.startsWith('.')) {
      confidence = 0.95;
    }

    // Boost confidence if it's actually a command
    if (context?.isCommand) {
      confidence = Math.min(confidence + 0.1, 1.0);
    }

    return {
      type: 'committing-secrets',
      confidence,
      matchedAction: gitAction,
      matchedTarget: sensitiveTarget,
      reasoning: `Detected attempt to ${gitAction} ${sensitiveTarget} - this may expose secrets`,
    };
  }

  // 3. Check for hardcoding secrets in code
  if (context?.isCodeContent) {
    const codeAction = findMatchingWord(normalizedText, CODE_CONTENT_INDICATORS);
    if (codeAction && sensitiveTarget) {
      return {
        type: 'hardcoding-secrets',
        confidence: 0.75,
        matchedAction: codeAction,
        matchedTarget: sensitiveTarget,
        reasoning: `Detected hardcoding of ${sensitiveTarget} - use environment variables instead`,
      };
    }
  }

  // 4. If only sensitive target is mentioned (lower confidence)
  if (sensitiveTarget && context?.hasGitContext) {
    return {
      type: 'exposing-credentials',
      confidence: 0.5,
      matchedAction: 'discussing',
      matchedTarget: sensitiveTarget,
      reasoning: `Discussing ${sensitiveTarget} in git context - ensure these aren't committed`,
    };
  }

  return null;
}

/**
 * Check multiple text sources for intent
 * Useful for checking both user prompt and tool command
 */
export function matchIntentMultiple(texts: Array<{
  text: string;
  context?: {
    isCommand?: boolean;
    isCodeContent?: boolean;
    hasGitContext?: boolean;
  };
}>): IntentMatch | null {
  let bestMatch: IntentMatch | null = null;

  for (const { text, context } of texts) {
    const match = matchIntent(text, context);
    if (match && (!bestMatch || match.confidence > bestMatch.confidence)) {
      bestMatch = match;
    }
  }

  return bestMatch;
}

/**
 * Quick check if text mentions anything sensitive (for pre-filtering)
 */
export function hasSensitiveMention(text: string): boolean {
  return findMatchingWord(text, SENSITIVE_TARGETS) !== null;
}

/**
 * Quick check if text mentions git actions (for pre-filtering)
 */
export function hasGitAction(text: string): boolean {
  return findMatchingWord(text, GIT_ACTION_WORDS) !== null;
}
