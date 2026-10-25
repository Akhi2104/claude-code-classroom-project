import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import { CODE_QUALITY_ANALYZER_PROMPT } from '../prompts';

/**
 * Code Quality Analyzer Agent
 * Analyzes code for quality issues, security vulnerabilities, and best practice violations
 */
export const codeQualityAnalyzer: AgentDefinition = {
  description: 'Analyzes code quality, identifies issues, security vulnerabilities, and best practice violations',
  prompt: CODE_QUALITY_ANALYZER_PROMPT,
  model: 'sonnet'
};
