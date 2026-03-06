/**
 * Cooldown State Management
 *
 * Tracks when rules/suggestions were last triggered to prevent alert fatigue.
 * State is persisted to disk for cross-invocation consistency.
 *
 * Note: Uses file locking to prevent race conditions between concurrent hook invocations.
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import { getCooldownMinutes } from '../config/loader.js';
import { classifyFile, FileType, hasCodeFiles } from '../utils/file-classifier.js';

function getStateDir(): string {
  const dir = process.env.XDG_RUNTIME_DIR
    ? join(process.env.XDG_RUNTIME_DIR, 'claude-hero')
    : join(process.env.HOME || '/tmp', '.cache', 'claude-hero');
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    // Directory may already exist
  }
  return dir;
}

const stateDir = getStateDir();
const STATE_FILE = join(stateDir, 'state.json');
const LOCK_FILE = join(stateDir, 'state.lock');
const LOCK_TIMEOUT_MS = 5000; // Max time to wait for lock
const LOCK_STALE_MS = 10000; // Consider lock stale after this time

/**
 * Record of a file change in the session
 */
interface FileChange {
  path: string;
  type: FileType;
  timestamp: number;
}

interface CooldownState {
  /** Rule ID -> last triggered timestamp (ms) */
  lastTriggered: Record<string, number>;
  /** Session start time */
  sessionStarted?: number;
  /** Total suggestions shown this session */
  suggestionsShown: number;
  /** Files changed this session */
  fileChanges?: FileChange[];
}

// In-memory cache - only valid within a single process invocation
let stateCache: CooldownState | null = null;

/**
 * Acquire a simple file-based lock
 * Returns true if lock acquired, false if timed out
 */
function acquireLock(): boolean {
  const startTime = Date.now();

  while (Date.now() - startTime < LOCK_TIMEOUT_MS) {
    try {
      // Check for stale lock
      if (existsSync(LOCK_FILE)) {
        const lockStat = readFileSync(LOCK_FILE, 'utf-8');
        const lockTime = parseInt(lockStat, 10);
        if (!isNaN(lockTime) && Date.now() - lockTime > LOCK_STALE_MS) {
          // Lock is stale, remove it
          try {
            unlinkSync(LOCK_FILE);
          } catch {
            // Another process may have removed it
          }
        }
      }

      // Try to create lock file (atomic on most filesystems)
      writeFileSync(LOCK_FILE, String(Date.now()), { flag: 'wx' });
      return true;
    } catch {
      // Lock exists, wait and retry with non-blocking sleep
      const delay = Math.floor(10 + Math.random() * 20);
      try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
      } catch {
        // Fallback for environments without SharedArrayBuffer
        const waitUntil = Date.now() + delay;
        while (Date.now() < waitUntil) { /* spin */ }
      }
    }
  }

  return false;
}

/**
 * Release the file lock
 */
function releaseLock(): void {
  try {
    if (existsSync(LOCK_FILE)) {
      unlinkSync(LOCK_FILE);
    }
  } catch {
    // Ignore errors during cleanup
  }
}

/**
 * Load state from disk (always reads fresh to avoid stale cache issues)
 */
function loadState(): CooldownState {
  // Always read from disk to get latest state from other processes
  if (existsSync(STATE_FILE)) {
    try {
      const content = readFileSync(STATE_FILE, 'utf-8');
      const parsed = JSON.parse(content) as CooldownState;
      stateCache = parsed;
      return parsed;
    } catch {
      // Corrupted state, start fresh
    }
  }

  const newState: CooldownState = {
    lastTriggered: {},
    sessionStarted: Date.now(),
    suggestionsShown: 0,
  };
  stateCache = newState;

  return newState;
}

/**
 * Save state to disk
 */
function saveState(): void {
  if (!stateCache) return;

  try {
    writeFileSync(STATE_FILE, JSON.stringify(stateCache, null, 2), { mode: 0o600 });
  } catch (error) {
    if (process.env.CLAUDE_HERO_DEBUG === '1') {
      console.error('[Claude Hero] Failed to save state:', error);
    }
  }
}

/**
 * Check if a rule should trigger based on cooldown
 *
 * @param ruleId - The rule identifier
 * @returns true if the rule can trigger, false if still in cooldown
 */
export function canTrigger(ruleId: string): boolean {
  const currentState = loadState();
  const lastTriggered = currentState.lastTriggered[ruleId];

  if (!lastTriggered) {
    return true;
  }

  const cooldownMs = getCooldownMinutes(ruleId) * 60 * 1000;
  const elapsed = Date.now() - lastTriggered;

  return elapsed >= cooldownMs;
}

/**
 * Record that a rule was triggered
 *
 * @param ruleId - The rule identifier
 */
export function recordTrigger(ruleId: string): void {
  if (!acquireLock()) {
    if (process.env.CLAUDE_HERO_DEBUG === '1') {
      console.error('[Claude Hero] Failed to acquire lock for recordTrigger');
    }
    return;
  }

  try {
    const currentState = loadState();
    currentState.lastTriggered[ruleId] = Date.now();
    currentState.suggestionsShown++;
    saveState();
  } finally {
    releaseLock();
  }
}

/**
 * Check cooldown and record trigger atomically.
 * Returns true if rule triggered (was not in cooldown).
 * Acquires lock first to prevent TOCTOU race conditions.
 */
export function tryTrigger(ruleId: string): boolean {
  if (!acquireLock()) {
    // Can't get lock — allow trigger to avoid blocking the user
    return true;
  }
  try {
    const currentState = loadState();
    const lastTriggered = currentState.lastTriggered[ruleId];
    if (lastTriggered) {
      const cooldownMs = getCooldownMinutes(ruleId) * 60 * 1000;
      if (Date.now() - lastTriggered < cooldownMs) {
        return false; // Still in cooldown
      }
    }
    // Can trigger — record it
    currentState.lastTriggered[ruleId] = Date.now();
    currentState.suggestionsShown++;
    saveState();
    return true;
  } finally {
    releaseLock();
  }
}

/**
 * Get time remaining in cooldown for a rule (in minutes)
 * Returns 0 if not in cooldown
 */
export function getCooldownRemaining(ruleId: string): number {
  const currentState = loadState();
  const lastTriggered = currentState.lastTriggered[ruleId];

  if (!lastTriggered) {
    return 0;
  }

  const cooldownMs = getCooldownMinutes(ruleId) * 60 * 1000;
  const elapsed = Date.now() - lastTriggered;
  const remaining = cooldownMs - elapsed;

  return remaining > 0 ? Math.ceil(remaining / 60000) : 0;
}

/**
 * Get session duration in minutes
 */
export function getSessionDurationMinutes(): number {
  const currentState = loadState();
  if (!currentState.sessionStarted) {
    return 0;
  }

  return Math.floor((Date.now() - currentState.sessionStarted) / 60000);
}

/**
 * Get total suggestions shown this session
 */
export function getTotalSuggestionsShown(): number {
  return loadState().suggestionsShown;
}

/**
 * Reset all cooldowns (useful for testing or mode changes)
 */
export function resetCooldowns(): void {
  if (!acquireLock()) {
    if (process.env.CLAUDE_HERO_DEBUG === '1') {
      console.error('[Claude Hero] Failed to acquire lock for resetCooldowns');
    }
    return;
  }

  try {
    stateCache = {
      lastTriggered: {},
      sessionStarted: Date.now(),
      suggestionsShown: 0,
    };
    saveState();
  } finally {
    releaseLock();
  }
}

/**
 * Reset cooldown for a specific rule
 */
export function resetRuleCooldown(ruleId: string): void {
  if (!acquireLock()) {
    if (process.env.CLAUDE_HERO_DEBUG === '1') {
      console.error('[Claude Hero] Failed to acquire lock for resetRuleCooldown');
    }
    return;
  }

  try {
    const currentState = loadState();
    delete currentState.lastTriggered[ruleId];
    saveState();
  } finally {
    releaseLock();
  }
}

/**
 * Record a file change in the session
 *
 * @param filePath - Path to the file that was changed
 */
export function recordFileChange(filePath: string): void {
  if (!acquireLock()) {
    if (process.env.CLAUDE_HERO_DEBUG === '1') {
      console.error('[Claude Hero] Failed to acquire lock for recordFileChange');
    }
    return;
  }

  try {
    const currentState = loadState();

    if (!currentState.fileChanges) {
      currentState.fileChanges = [];
    }

    // Classify the file
    const classification = classifyFile(filePath);

    // Add to changes (avoid duplicates by checking path)
    const existingIndex = currentState.fileChanges.findIndex(fc => fc.path === filePath);
    if (existingIndex >= 0) {
      // Update timestamp for existing file
      currentState.fileChanges[existingIndex].timestamp = Date.now();
    } else {
      // Limit file changes to prevent unbounded growth (keep last 500)
      if (currentState.fileChanges.length >= 500) {
        currentState.fileChanges = currentState.fileChanges.slice(-400);
      }
      currentState.fileChanges.push({
        path: filePath,
        type: classification.type,
        timestamp: Date.now(),
      });
    }

    saveState();
  } finally {
    releaseLock();
  }
}

/**
 * Get all file changes in the current session
 */
export function getSessionFileChanges(): FileChange[] {
  const currentState = loadState();
  return currentState.fileChanges || [];
}

/**
 * Check if any code files have been changed this session
 * Used for smart test reminder filtering
 */
export function hasCodeChangesThisSession(): boolean {
  const changes = getSessionFileChanges();
  return changes.some(fc => fc.type === 'code' || fc.type === 'test');
}

/**
 * Get file changes by type
 */
export function getFileChangesByType(type: FileType): FileChange[] {
  const changes = getSessionFileChanges();
  return changes.filter(fc => fc.type === type);
}

/**
 * Get count of each file type changed
 */
export function getFileChangeStats(): Record<FileType, number> {
  const changes = getSessionFileChanges();
  const stats: Record<FileType, number> = {
    code: 0,
    test: 0,
    config: 0,
    docs: 0,
    style: 0,
    build: 0,
    other: 0,
  };

  for (const change of changes) {
    stats[change.type]++;
  }

  return stats;
}

/**
 * Clear file changes (called when tests are run)
 */
export function clearFileChanges(): void {
  if (!acquireLock()) {
    if (process.env.CLAUDE_HERO_DEBUG === '1') {
      console.error('[Claude Hero] Failed to acquire lock for clearFileChanges');
    }
    return;
  }

  try {
    const currentState = loadState();
    currentState.fileChanges = [];
    saveState();
  } finally {
    releaseLock();
  }
}
