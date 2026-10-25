import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import { REFACTORING_SUGGESTER_PROMPT } from '../prompts';

/**
 * Refactoring Suggester Agent
 * Recommends code improvements and refactoring opportunities
 */
export const refactoringSuggester: AgentDefinition = {
  description: 'Recommends code improvements and refactoring opportunities',
  prompt: REFACTORING_SUGGESTER_PROMPT,
  model: 'sonnet'
};
