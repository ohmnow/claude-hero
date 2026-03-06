/**
 * Orchestrator Hook Handlers
 *
 * Provides orchestrator-specific handling for each hook event:
 * - UserPromptSubmit: Detect phase, inject context, provide proactive guidance
 * - PreToolUse: Block work on blocked features, enforce sprint boundaries
 * - PostToolUse: Detect feature completion, update status, trigger phase transitions
 */

import {
  getOrchestratorContext,
  initializeOrchestrator,
  getPhaseGuidance,
  getStatusSummary,
  OrchestratorContext,
} from './index.js';
import {
  DevelopmentPhase,
  canTransitionTo,
  getRecommendedNextPhase,
} from './phases.js';
import {
  transitionPhase,
  setCurrentFeature,
  updateState,
} from './state.js';
import {
  calculateEffectiveStatus,
  getReadyFeatures,
  getParallelizableFeatures,
  Feature,
} from './feature-schema.js';
import {
  getGitHubHookContext,
  getGitHubSetupPrompt,
} from './github-hooks.js';

/**
 * Result from orchestrator hook processing
 */
export interface OrchestratorHookResult {
  /** Context to inject into Claude's prompt */
  contextInjection?: string;

  /** Message to display to user */
  userMessage?: string;

  /** Whether to block the action */
  block?: boolean;

  /** Block reason if blocking */
  blockReason?: string;

  /** Status summary for display */
  statusSummary?: string;
}

/**
 * Handle UserPromptSubmit for orchestrator mode
 */
export async function handleUserPromptSubmit(
  prompt: string,
  projectDir: string = process.cwd()
): Promise<OrchestratorHookResult> {
  const context = getOrchestratorContext(projectDir);

  if (!context.enabled) {
    return {};
  }

  // New project - needs onboarding
  if (context.needsOnboarding) {
    return handleOnboarding(prompt, projectDir);
  }

  // Existing project - provide phase-appropriate guidance
  const result = await handlePhaseGuidance(prompt, context, projectDir);

  // Add GitHub context if available
  const githubContext = await getGitHubHookContext(projectDir);
  if (githubContext.contextInjection && result.contextInjection) {
    result.contextInjection += '\n' + githubContext.contextInjection;
  } else if (githubContext.contextInjection) {
    result.contextInjection = githubContext.contextInjection;
  }

  return result;
}

/**
 * Handle onboarding for new orchestrator projects
 */
function handleOnboarding(
  prompt: string,
  projectDir: string
): OrchestratorHookResult {
  // Initialize state for the new project
  initializeOrchestrator(projectDir);

  // Get the freshly initialized context
  const context = getOrchestratorContext(projectDir);

  const contextInjection = `
## Orchestrator Mode Active

You are now in **Orchestrator Mode** - acting as a 10X pair programmer to guide this project from idea to production.

### Current Phase: Onboarding

The user is starting a new project. Your job is to:
1. Understand what they want to build
2. Ask clarifying questions about features and requirements
3. When ready, create a feature_list.json with:
   - Features broken into sprints
   - Blocking dependencies identified
   - Acceptance criteria for each feature

### Key Principles
- **Blocking dependencies**: Some features must pass before dependent features can start
- **Sprint-based**: Group features into sprints for focused development
- **Verification required**: Each feature needs tests and acceptance criteria before marking complete

### Conversation Guide
- Ask about the core functionality they need
- Identify which features are foundational (blocking)
- Clarify any technical requirements or constraints
- When ready, generate a comprehensive feature_list.json

User's initial request: "${prompt.replace(/["\\`$]/g, (c) => '\\' + c).slice(0, 2000)}"
`;

  return {
    contextInjection,
    statusSummary: getStatusSummary(context),
    userMessage: getPhaseGuidance('onboarding'),
  };
}

/**
 * Handle phase-specific guidance
 */
async function handlePhaseGuidance(
  prompt: string,
  context: OrchestratorContext,
  projectDir: string
): Promise<OrchestratorHookResult> {
  if (!context.state) {
    return {};
  }

  const { currentPhase, currentSprint, currentFeatureId } = context.state;

  // Build context based on phase
  let contextInjection = `
## Orchestrator Mode Active

**Phase:** ${currentPhase} | **Sprint:** ${currentSprint}`;

  if (context.sprintProgress) {
    contextInjection += ` | **Progress:** ${context.sprintProgress.verified}/${context.sprintProgress.total} verified`;
  }

  contextInjection += '\n';

  // Phase-specific context
  switch (currentPhase) {
    case 'setup':
      contextInjection += `
### Setup Phase
- Initialize git repository if needed
- Set up project structure
- Install dependencies
- Make initial commit

**GitHub Integration Available**: Ask if the user wants to create a GitHub repository for professional workflow tracking.

When complete, transition to 'planning' phase.
`;
      break;

    case 'planning':
      contextInjection += `
### Planning Phase
${context.featureList ? 'Feature list exists. Review and refine as needed.' : 'Create feature_list.json with features, sprints, and dependencies.'}

Key elements for feature_list.json:
- Group features by sprint
- Mark blocking dependencies
- Add acceptance criteria for verification

**GitHub**: After creating the feature list, offer to create GitHub issues for each feature.
`;
      break;

    case 'development':
      contextInjection += buildDevelopmentContext(context);
      break;

    case 'verification':
      contextInjection += `
### Verification Phase
- Run all tests
- Verify acceptance criteria for each feature
- Mark features as 'verified' when passing
- Update feature_list.json with results
`;
      break;

    case 'production':
      contextInjection += `
### Production Readiness Phase
Run these checks before deployment:
- **Security**: No hardcoded secrets, dependency audit, HTTPS
- **Testing**: All tests pass, adequate coverage
- **Performance**: Bundle size, image optimization
- **UX**: Error handling, loading states, mobile responsive
`;
      break;

    case 'shipped':
      contextInjection += `
### Shipped!
Deployment complete. Ready to start next development cycle.
`;
      break;
  }

  return {
    contextInjection,
    statusSummary: getStatusSummary(context),
  };
}

/**
 * Build development phase context with feature status
 */
function buildDevelopmentContext(context: OrchestratorContext): string {
  if (!context.featureList || !context.state) {
    return `
### Development Phase
No feature list found. Create feature_list.json to track progress.
`;
  }

  const { features } = context.featureList;
  const currentSprint = context.state.currentSprint;

  // Get sprint features with effective status
  const sprintFeatures = features
    .filter(f => f.sprint === currentSprint)
    .map(f => ({
      ...f,
      effectiveStatus: calculateEffectiveStatus(f, features),
    }));

  const ready = sprintFeatures.filter(f => f.effectiveStatus === 'ready');
  const blocked = sprintFeatures.filter(f => f.effectiveStatus === 'blocked');
  const inProgress = sprintFeatures.filter(f => f.effectiveStatus === 'in_progress');
  const verified = sprintFeatures.filter(f => f.effectiveStatus === 'verified');

  let contextStr = `
### Development Phase - Sprint ${currentSprint}

**Status:**
- Ready: ${ready.length}
- In Progress: ${inProgress.length}
- Blocked: ${blocked.length}
- Verified: ${verified.length}

`;

  // Current feature focus
  const currentFeatureId = context.state.currentFeatureId;
  if (currentFeatureId) {
    const current = features.find(f => f.id === currentFeatureId);
    if (current) {
      contextStr += `**Current Focus:** ${current.name} (${current.id})\n\n`;
    }
  }

  // Ready features
  if (ready.length > 0) {
    contextStr += '**Ready to work on:**\n';
    for (const f of ready.slice(0, 3)) {
      contextStr += `- ${f.name} (${f.id})${f.blocking ? ' [BLOCKING]' : ''}\n`;
    }
    contextStr += '\n';
  }

  // Blocked features
  if (blocked.length > 0) {
    contextStr += '**Blocked (waiting on dependencies):**\n';
    for (const f of blocked.slice(0, 3)) {
      const deps = f.dependsOn.join(', ');
      contextStr += `- ${f.name} → needs: ${deps}\n`;
    }
    contextStr += '\n';
  }

  // Parallelizable work
  const parallelizable = getParallelizableFeatures(context.featureList, currentSprint);
  if (parallelizable.length > 1) {
    contextStr += `**Parallel work available:** ${parallelizable.length} non-blocking features can be worked on simultaneously using subagents.\n`;
  }

  return contextStr;
}

/**
 * Handle PreToolUse for orchestrator mode
 * Can block actions on blocked features
 */
export function handlePreToolUse(
  toolName: string,
  toolInput: Record<string, unknown>,
  projectDir: string = process.cwd()
): OrchestratorHookResult {
  const context = getOrchestratorContext(projectDir);

  if (!context.enabled || !context.state || !context.featureList) {
    return {};
  }

  // Only check during development phase
  if (context.state.currentPhase !== 'development') {
    return {};
  }

  // Check if working on a blocked feature
  const { currentFeatureId } = context.state;
  if (!currentFeatureId) {
    return {};
  }

  const currentFeature = context.featureList.features.find(
    f => f.id === currentFeatureId
  );

  if (!currentFeature) {
    return {};
  }

  const effectiveStatus = calculateEffectiveStatus(
    currentFeature,
    context.featureList.features
  );

  if (effectiveStatus === 'blocked') {
    const blockedBy = currentFeature.dependsOn
      .filter(depId => {
        const dep = context.featureList!.features.find(f => f.id === depId);
        // Include if: dependency doesn't exist (missing), OR is blocking and not passed
        return !dep || (dep.blocking && !dep.passes);
      })
      .join(', ');

    return {
      block: true,
      blockReason: `Feature "${currentFeature.name}" is blocked by: ${blockedBy}. Complete blocking dependencies first.`,
    };
  }

  return {};
}

/**
 * Handle PostToolUse for orchestrator mode
 * Detect completion, update status
 */
export function handlePostToolUse(
  toolName: string,
  toolInput: Record<string, unknown>,
  toolOutput: string,
  projectDir: string = process.cwd()
): OrchestratorHookResult {
  const context = getOrchestratorContext(projectDir);

  if (!context.enabled || !context.state) {
    return {};
  }

  // Check for phase transitions based on tool use
  const result: OrchestratorHookResult = {
    statusSummary: getStatusSummary(context),
  };

  // Detect file creation that might indicate phase progress
  if (toolName === 'Write' || toolName === 'Edit') {
    const filePath = toolInput.file_path as string;

    // Feature list created/updated
    if (filePath?.includes('feature_list.json')) {
      if (context.state.currentPhase === 'planning') {
        result.userMessage = 'Feature list updated. Ready to start development when you are.';
      }
    }
  }

  // Detect test runs
  if (toolName === 'Bash') {
    const command = toolInput.command as string;

    if (command?.match(/npm\s+test|jest|vitest|pytest/)) {
      if (context.state.currentPhase === 'verification') {
        result.contextInjection = `
Test run detected. After reviewing results:
- Mark passing features as 'verified' in feature_list.json
- Update feature status with passes: true
`;
      }
    }
  }

  return result;
}

/**
 * Trigger a phase transition
 */
export function triggerPhaseTransition(
  newPhase: DevelopmentPhase,
  projectDir: string = process.cwd()
): OrchestratorHookResult {
  const context = getOrchestratorContext(projectDir);

  if (!context.enabled || !context.state) {
    return { block: true, blockReason: 'Orchestrator not initialized' };
  }

  const { currentPhase } = context.state;

  if (!canTransitionTo(currentPhase, newPhase)) {
    return {
      block: true,
      blockReason: `Cannot transition from ${currentPhase} to ${newPhase}`,
    };
  }

  transitionPhase(newPhase, projectDir);

  return {
    userMessage: `Transitioned to ${newPhase} phase`,
    contextInjection: `Phase changed to: ${newPhase}\n${getPhaseGuidance(newPhase)}`,
    statusSummary: getStatusSummary(getOrchestratorContext(projectDir)),
  };
}
