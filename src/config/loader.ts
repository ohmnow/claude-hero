/**
 * Configuration Loader
 *
 * Loads and validates configuration from file or environment.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import {
  WorkflowPilotConfig,
  DEFAULT_CONFIG,
  MODE_PRESETS,
  OperatingMode,
} from './schema.js';

// Cache the loaded config
let cachedConfig: WorkflowPilotConfig | null = null;

/**
 * Find config files in priority order
 * Returns an array of paths to merge (later paths override earlier)
 *
 * Priority (lowest to highest):
 * 1. Built-in defaults
 * 2. User global config (~/.config/claude-hero/config.json)
 * 3. Project config (./config/claude-hero.json)
 * 4. Project root config (./.claude-hero.json) - NEW
 * 5. CLAUDE_HERO_CONFIG env var (highest priority)
 */
function findConfigPaths(): string[] {
  const paths: string[] = [];

  // 1. Built-in default (lowest priority)
  // Look for default.json relative to the module location or current working directory
  const possibleDefaults = [
    join(process.cwd(), 'config', 'default.json'),
  ];

  // Also check relative to this module's location (for installed packages)
  // __dirname equivalent for ESM: use fileURLToPath if available, or fallback to dirname
  try {
    // For CommonJS compatibility, use __dirname if available
    if (typeof __dirname !== 'undefined') {
      const packageRoot = join(__dirname, '..', '..', 'config', 'default.json');
      possibleDefaults.push(packageRoot);
    }
  } catch {
    // __dirname may not be available in all environments
  }

  for (const path of possibleDefaults) {
    if (existsSync(path)) {
      paths.push(path);
      break;
    }
  }

  // 2. User global config
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  const userConfig = join(homeDir, '.config', 'claude-hero', 'config.json');
  if (existsSync(userConfig)) {
    paths.push(userConfig);
  }

  // 3. Project config directory
  const projectConfig = join(process.cwd(), 'config', 'claude-hero.json');
  if (existsSync(projectConfig)) {
    paths.push(projectConfig);
  }

  // 4. Project root .claude-hero.json (NEW - user-specific project config)
  const projectRootConfig = join(process.cwd(), '.claude-hero.json');
  if (existsSync(projectRootConfig)) {
    paths.push(projectRootConfig);
  }

  // 5. Environment variable (highest priority)
  if (process.env.CLAUDE_HERO_CONFIG) {
    const envPath = process.env.CLAUDE_HERO_CONFIG;
    if (existsSync(envPath)) {
      paths.push(envPath);
    }
  }

  return paths;
}

/**
 * @deprecated Use findConfigPaths() instead
 */
function findConfigPath(): string | null {
  const paths = findConfigPaths();
  return paths.length > 0 ? paths[paths.length - 1] : null;
}

/**
 * Deep merge two config objects
 */
function deepMerge(
  base: WorkflowPilotConfig,
  override: Partial<WorkflowPilotConfig>
): WorkflowPilotConfig {
  const result = JSON.parse(JSON.stringify(base)) as WorkflowPilotConfig;

  // Merge top-level properties
  if (override.mode !== undefined) result.mode = override.mode;

  // Merge tiers
  if (override.tiers) {
    if (override.tiers.critical) result.tiers.critical = { ...result.tiers.critical, ...override.tiers.critical };
    if (override.tiers.warning) result.tiers.warning = { ...result.tiers.warning, ...override.tiers.warning };
    if (override.tiers.info) result.tiers.info = { ...result.tiers.info, ...override.tiers.info };
  }

  // Merge categories
  if (override.categories) {
    result.categories = { ...result.categories, ...override.categories };
  }

  // Merge frequency
  if (override.frequency) {
    result.frequency = { ...result.frequency, ...override.frequency };
  }

  // Merge ai
  if (override.ai) {
    result.ai = { ...result.ai, ...override.ai };
  }

  // Merge training
  if (override.training) {
    result.training = { ...result.training, ...override.training };
  }

  // Merge hooks
  if (override.hooks) {
    result.hooks = { ...result.hooks, ...override.hooks };
  }

  return result;
}

/**
 * Apply mode preset to config
 */
function applyModePreset(config: WorkflowPilotConfig): WorkflowPilotConfig {
  const preset = MODE_PRESETS[config.mode];
  if (!preset) {
    return config;
  }

  // Mode preset is the base, user config overrides it
  return deepMerge(deepMerge(DEFAULT_CONFIG, preset as Partial<WorkflowPilotConfig>), config);
}

/**
 * Validate configuration
 */
function validateConfig(config: unknown): config is Partial<WorkflowPilotConfig> {
  if (typeof config !== 'object' || config === null) {
    return false;
  }

  const c = config as Record<string, unknown>;

  // Validate mode if present
  if (c.mode !== undefined) {
    if (!['minimal', 'training', 'guidance', 'hero', 'orchestrator'].includes(c.mode as string)) {
      console.error(`[Claude Hero] Invalid mode: ${c.mode}. Using default.`);
      return false;
    }
    // Backwards compat: 'orchestrator' -> 'hero'
    if (c.mode === 'orchestrator') {
      c.mode = 'hero';
    }
  }

  return true;
}

/**
 * Load configuration
 *
 * Merges configs in priority order:
 * defaults -> user global -> project config -> project root -> env var
 *
 * @param forceReload - Skip cache and reload from file
 */
export function loadConfig(forceReload = false): WorkflowPilotConfig {
  // Return cached if available
  if (cachedConfig && !forceReload) {
    return cachedConfig;
  }

  // Start with defaults
  let mergedConfig: Partial<WorkflowPilotConfig> = {};

  // Load and merge all config files in priority order
  const configPaths = findConfigPaths();
  for (const configPath of configPaths) {
    try {
      const content = readFileSync(configPath, 'utf-8');
      const parsed = JSON.parse(content);

      if (validateConfig(parsed)) {
        mergedConfig = deepMerge(
          deepMerge(DEFAULT_CONFIG, mergedConfig),
          parsed
        );

        if (process.env.CLAUDE_HERO_DEBUG === '1') {
          console.error(`[Claude Hero] Loaded config from: ${configPath}`);
        }
      }
    } catch (error) {
      console.error(`[Claude Hero] Error loading config from ${configPath}:`, error);
    }
  }

  // Check for mode override via environment (highest priority)
  if (process.env.CLAUDE_HERO_MODE) {
    let envMode = process.env.CLAUDE_HERO_MODE as OperatingMode;
    // Backwards compat: 'orchestrator' -> 'hero'
    if (envMode === 'orchestrator') {
      envMode = 'hero';
    }
    if (['minimal', 'training', 'guidance', 'hero'].includes(envMode)) {
      mergedConfig.mode = envMode;
    }
  }

  // Final merge with defaults to ensure all fields present
  let finalConfig = deepMerge(DEFAULT_CONFIG, mergedConfig);

  // Apply mode preset
  finalConfig = applyModePreset(finalConfig);

  // Security: project-level config can NEVER disable critical security alerts.
  // A malicious .claude-hero.json in a cloned repo must not silence security warnings.
  finalConfig.tiers.critical.enabled = true;

  // Cache and return
  cachedConfig = finalConfig;
  return finalConfig;
}

/**
 * Get a specific config value
 */
export function getConfigValue<K extends keyof WorkflowPilotConfig>(
  key: K
): WorkflowPilotConfig[K] {
  const config = loadConfig();
  return config[key];
}

/**
 * Check if a specific tier is enabled
 */
export function isTierEnabled(tier: 'critical' | 'warning' | 'info'): boolean {
  const config = loadConfig();
  return config.tiers[tier]?.enabled ?? true;
}

/**
 * Check if a category is enabled
 */
export function isCategoryEnabled(
  category: 'testing' | 'git' | 'security' | 'claudeCode' | 'refactoring'
): boolean {
  const config = loadConfig();
  return config.categories[category] ?? true;
}

/**
 * Get the current operating mode
 */
export function getMode(): OperatingMode {
  const config = loadConfig();
  return config.mode;
}

/**
 * Check if we're in training mode
 */
export function isTrainingMode(): boolean {
  return getMode() === 'training';
}

/**
 * Check if we're in hero mode (10X pair programmer)
 */
export function isHeroMode(): boolean {
  return getMode() === 'hero';
}

/**
 * @deprecated Use isHeroMode() instead
 */
export function isOrchestratorMode(): boolean {
  return isHeroMode();
}

/**
 * Get cooldown for a rule
 */
export function getCooldownMinutes(ruleId: string): number {
  const config = loadConfig();

  // Check per-rule override first
  if (config.frequency.perRuleCooldowns?.[ruleId]) {
    return config.frequency.perRuleCooldowns[ruleId];
  }

  // Use info cooldown for info rules
  if (ruleId.startsWith('info-')) {
    return config.frequency.infoCooldownMinutes;
  }

  return config.frequency.defaultCooldownMinutes;
}

/**
 * Clear cached config (useful for testing)
 */
export function clearConfigCache(): void {
  cachedConfig = null;
}
