import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import { TEST_COVERAGE_ANALYZER_PROMPT } from '../prompts';

/**
 * Test Coverage Analyzer Agent
 * Evaluates test completeness and identifies untested code paths
 */
export const testCoverageAnalyzer: AgentDefinition = {
  description: 'Evaluates test completeness and identifies untested code paths',
  prompt: TEST_COVERAGE_ANALYZER_PROMPT,
  model: 'sonnet'
};
