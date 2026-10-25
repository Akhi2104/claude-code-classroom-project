import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { CodeReviewOrchestrator } from './orchestrator';
import { ReportGenerator } from './utils/report-generator';
import { logger } from './utils/logger';

// Load environment variables
dotenv.config();

/**
 * Main entry point for the Claude Multi-Agent Code Review System
 * Usage: npm run dev <owner> <repo> <pr-number>
 */
async function main() {
  const [owner, repo, prStr] = process.argv.slice(2);

  // Validate command line arguments
  if (!owner || !repo || !prStr) {
    console.error('Error: Missing required arguments');
    console.error('Usage: npm run dev <owner> <repo> <pr-number>');
    console.error('Example: npm run dev facebook react 12345');
    process.exit(1);
  }

  // Convert prStr to number and validate it's a valid integer
  const prNumber = parseInt(prStr, 10);
  if (isNaN(prNumber) || prNumber <= 0) {
    console.error(`Error: Invalid PR number "${prStr}". Must be a positive integer.`);
    process.exit(1);
  }

  // Validate authentication (choose ONE method)
  const hasAnthropicKey = !!process.env.ANTHROPIC_API_KEY;
  const hasAwsKeys = !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);

  if (!hasAnthropicKey && !hasAwsKeys) {
    console.error('Error: No authentication configured');
    console.error('');
    console.error('You must configure ONE of the following:');
    console.error('');
    console.error('Option 1: Anthropic API Key');
    console.error('  Set: ANTHROPIC_API_KEY=sk-ant-your-key-here');
    console.error('');
    console.error('Option 2: AWS Bedrock');
    console.error('  Set: AWS_ACCESS_KEY_ID=your-key');
    console.error('  Set: AWS_SECRET_ACCESS_KEY=your-secret');
    console.error('  Set: AWS_REGION=us-west-2');
    process.exit(1);
  }

  // Log authentication method
  if (hasAwsKeys) {
    if (!process.env.AWS_REGION) {
      console.error('Error: AWS_REGION is required when using AWS Bedrock');
      process.exit(1);
    }
    console.log('🔐 Using AWS Bedrock authentication');
  } else {
    console.log('🔐 Using Anthropic API authentication');
  }

  // Validate ANTHROPIC_MODEL environment variable
  if (!process.env.ANTHROPIC_MODEL) {
    console.error('Error: ANTHROPIC_MODEL environment variable is required');
    console.error('');
    console.error('For AWS Bedrock: us.anthropic.claude-sonnet-4-5-20250929-v1:0');
    console.error('For Anthropic API: claude-sonnet-4-5-20250929');
    process.exit(1);
  }

  console.log(`📋 Reviewing PR #${prNumber} in ${owner}/${repo}`);
  console.log('');

  try {
    // Create orchestrator instance
    const orchestrator = new CodeReviewOrchestrator();

    // Call reviewPullRequest
    const report = await orchestrator.reviewPullRequest(owner, repo, prNumber);

    // Generate formatted reports using ReportGenerator
    const generator = new ReportGenerator();

    // Create reports directory if it doesn't exist
    const reportsDir = path.join(process.cwd(), 'reports');
    if (!fs.existsSync(reportsDir)) {
      fs.mkdirSync(reportsDir, { recursive: true });
    }

    // Generate and save reports
    const timestamp = new Date().toISOString().replace(/:/g, '-').split('.')[0];
    const baseFilename = `${owner}-${repo}-${prNumber}-${timestamp}`;

    // Markdown report
    const markdownReport = generator.generateMarkdownReport(report);
    const markdownPath = path.join(reportsDir, `${baseFilename}.md`);
    fs.writeFileSync(markdownPath, markdownReport, 'utf-8');
    console.log(`✅ Markdown report saved: ${markdownPath}`);

    // HTML report
    const htmlReport = generator.generateHTMLReport(report);
    const htmlPath = path.join(reportsDir, `${baseFilename}.html`);
    fs.writeFileSync(htmlPath, htmlReport, 'utf-8');
    console.log(`✅ HTML report saved: ${htmlPath}`);

    // JSON report
    const jsonReport = generator.generateJSONReport(report);
    const jsonPath = path.join(reportsDir, `${baseFilename}.json`);
    fs.writeFileSync(jsonPath, jsonReport, 'utf-8');
    console.log(`✅ JSON report saved: ${jsonPath}`);

    console.log('');
    console.log('🎉 Code review completed successfully!');
    console.log(`Overall Score: ${report.summary.overallScore}/100`);
    console.log(`Files Reviewed: ${report.summary.totalFiles}`);
    console.log(`Critical Issues: ${report.summary.criticalIssues}`);

  } catch (error) {
    logger.error('Code review failed', { error });
    console.error('Error:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main();
