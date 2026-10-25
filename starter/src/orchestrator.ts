
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { ReviewReport } from './types/report-types';
import {
  CodeQualityResult,
  TestCoverageResult,
  RefactoringSuggestion,
  CodeQualityResultSchema,
  TestCoverageResultSchema,
  RefactoringSuggestionSchema
} from './types/analysis-results';
import { ReviewReportSchema } from './types/report-types';
import {
  codeQualityAnalyzer,
  testCoverageAnalyzer,
  refactoringSuggester
} from './agents';
import { buildOrchestratorPrompt } from './prompts';
import { mcpServersConfig } from './config/mcp.config';
import {
  RateLimiter,
  RateLimiterConfig,
  DEFAULT_RATE_LIMITS
} from './utils/rate-limiter';
import { withRetry, withTimeout } from './utils/error-handler';
import {
  logger,
  logReviewStart,
  logReviewComplete,
  logAgentStart,
  logAgentComplete
} from './utils/logger';

interface ChangedFile {
  filename: string;
  status: string;
  patch?: string;
  additions?: number;
  deletions?: number;
}

interface FileAnalysis {
  file: string;
  codeQuality: CodeQualityResult;
  testCoverage: TestCoverageResult;
  refactorings: RefactoringSuggestion;
}

interface RawFileAnalysis {
  codeQuality: unknown;
  testCoverage: unknown;
  refactorings: unknown;
}

export interface OrchestratorOptions {
  rateLimits?: Partial<RateLimiterConfig>;
}

export class CodeReviewOrchestrator {
  private readonly rateLimiter: RateLimiter;

  constructor(options: OrchestratorOptions = {}) {
    this.rateLimiter = new RateLimiter(
      options.rateLimits || DEFAULT_RATE_LIMITS
    );
  }

  async reviewPullRequest(
    owner: string,
    repo: string,
    prNumber: number
  ): Promise<ReviewReport> {
    if (
      !owner.trim() ||
      !repo.trim() ||
      !Number.isInteger(prNumber) ||
      prNumber <= 0
    ) {
      throw new Error(
        'A valid repository owner, repository name, and PR number are required.'
      );
    }

    const startTime = Date.now();
    logReviewStart(owner, repo, prNumber);

    const { files: changedFiles, headSha } =
      await this.fetchPullRequestFiles(owner, repo, prNumber);

    const selectedFiles = changedFiles
      .filter((file) => !this.shouldSkipFile(file.filename))
      .slice(0, 10);

    if (selectedFiles.length === 0) {
      throw new Error(
        `No reviewable changed files found for ${owner}/${repo} PR #${prNumber}.`
      );
    }

    logger.info(
      `Retrieved ${changedFiles.length} changed files; reviewing ${selectedFiles.length}`
    );

    // Each file gets one orchestration query. The orchestrator must delegate
    // the three specialized analyses through Task subagents.
    const results = await Promise.allSettled(
      selectedFiles.map(async (changedFile): Promise<FileAnalysis> => {
        const file = changedFile.filename;
        const content = await this.fetchFileReviewContent(
          owner,
          repo,
          headSha,
          changedFile
        );

        if (!content.trim()) {
          throw new Error(`No code or diff available for ${file}`);
        }

        return this.analyzeFile(owner, repo, prNumber, file, content);
      })
    );

    const fileReviews: FileAnalysis[] = [];
    let failedFiles = 0;

    for (const result of results) {
      if (result.status === 'fulfilled') {
        fileReviews.push(result.value);
      } else {
        failedFiles++;
        logger.error('File review failed', {
          error:
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason)
        });
      }
    }

    if (fileReviews.length === 0) {
      throw new Error(
        `No files were successfully reviewed for ${owner}/${repo} PR #${prNumber}. ` +
        `${failedFiles} file review(s) failed. Check the logs.`
      );
    }

    const summary = {
      totalFiles: fileReviews.length,
      overallScore: Math.round(
        fileReviews.reduce(
          (sum, review) => sum + review.codeQuality.overallScore,
          0
        ) / fileReviews.length
      ),
      criticalIssues: fileReviews.reduce(
        (sum, review) =>
          sum +
          review.codeQuality.issues.filter(
            (issue) => issue.severity === 'critical'
          ).length,
        0
      ),
      highPriorityTests: fileReviews.reduce(
        (sum, review) =>
          sum +
          review.testCoverage.untestedPaths.filter(
            (path) =>
              path.priority === 'critical' || path.priority === 'high'
          ).length,
        0
      ),
      refactoringOpportunities: fileReviews.reduce(
        (sum, review) => sum + review.refactorings.suggestions.length,
        0
      )
    };

    const duration = Date.now() - startTime;
    const recommendations = this.generateRecommendations(fileReviews);

    logReviewComplete(
      owner,
      repo,
      prNumber,
      summary.overallScore,
      duration
    );

    const report: ReviewReport = {
      pullRequest: { owner, repo, number: prNumber },
      fileReviews,
      summary,
      recommendations,
      metadata: {
        analyzedAt: new Date().toISOString(),
        duration,
        agentVersions: {
          orchestrator: '1.2.0',
          codeQuality: '1.2.0',
          testCoverage: '1.2.0',
          refactoring: '1.2.0'
        }
      }
    };

    return ReviewReportSchema.parse(report);
  }

  private async analyzeFile(
    owner: string,
    repo: string,
    prNumber: number,
    file: string,
    content: string
  ): Promise<FileAnalysis> {
    logAgentStart('orchestrator', file);
    const startTime = Date.now();

    const result = await withRetry(async () => {
      await this.rateLimiter.acquire(5000);

      try {
        return await withTimeout(
          () => this.sendQuery(owner, repo, prNumber, file, content),
          180000,
          `Multi-agent analysis timed out for ${file}`
        );
      } finally {
        this.rateLimiter.release(5000);
      }
    });

    const parsed = this.extractJson(result) as RawFileAnalysis;

    const codeQuality = CodeQualityResultSchema.parse({
      ...(parsed.codeQuality as Record<string, unknown>),
      file
    });

    const testCoverage = TestCoverageResultSchema.parse({
      ...(parsed.testCoverage as Record<string, unknown>),
      file
    });

    const refactorings = RefactoringSuggestionSchema.parse({
      ...(parsed.refactorings as Record<string, unknown>),
      file
    });

    logAgentComplete('orchestrator', file, Date.now() - startTime);

    return { file, codeQuality, testCoverage, refactorings };
  }

  private async sendQuery(
    owner: string,
    repo: string,
    prNumber: number,
    file: string,
    content: string
  ): Promise<string> {
    const basePrompt = buildOrchestratorPrompt(owner, repo, prNumber);

    const prompt = `${basePrompt}

## Current file to review

The pull request metadata and changed-file content have already been retrieved.
Review ONLY the supplied file content below. Do not fetch the PR again.

File: ${file}

<file_review_input>
${content.slice(0, 18000)}
</file_review_input>

## Required delegation

You MUST invoke each of these three registered subagents using the Task tool:
1. code-quality-analyzer
2. test-coverage-analyzer
3. refactoring-suggester

Give each subagent the file path and relevant supplied code/diff. Run the three independent analyses in parallel when possible. Do not fabricate a subagent result or claim an agent ran unless you actually invoked it.

Combine their results into one JSON object with exactly these top-level keys:
{
  "codeQuality": {
    "file": "${file}",
    "issues": [],
    "overallScore": 85,
    "summary": "Evidence-based summary"
  },
  "testCoverage": {
    "file": "${file}",
    "hasTests": false,
    "testFiles": [],
    "untestedPaths": [],
    "coverageEstimate": 0,
    "summary": "Evidence and limitations"
  },
  "refactorings": {
    "file": "${file}",
    "suggestions": [],
    "summary": "Evidence-based summary"
  }
}

Every nested result must follow its specialist's required schema. Do not add Markdown fences, comments, or text outside the JSON object.`;

    const q = query({
      prompt,
      options: {
        model:
          process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5-20250929',
        cwd: process.cwd(),
        settingSources: ['project'],
        tools: { type: 'preset', preset: 'claude_code' },
        allowedTools: [
          'Task',
          'Skill',
          'Read',
          'Grep',
          'Glob',
          'mcp__github__*',
          'mcp__eslint__*'
        ],
        permissionMode: 'dontAsk',
        mcpServers: {
          github: mcpServersConfig.github,
          eslint: mcpServersConfig.eslint
        },
        agents: {
          'code-quality-analyzer': codeQualityAnalyzer,
          'test-coverage-analyzer': testCoverageAnalyzer,
          'refactoring-suggester': refactoringSuggester
        },
        maxTurns: 20
      }
    });

    let finalResult = '';
    let hadError = false;

    for await (const message of q) {
      if (message.type === 'result') {
        if (message.is_error) {
          hadError = true;
          logger.error('Claude Agent SDK execution failed', {
            subtype: message.subtype,
            detail:
              'errors' in message
                ? message.errors
                : 'result' in message
                  ? message.result
                  : 'Unknown SDK error'
          });
        } else if ('result' in message) {
          finalResult = message.result;
        }
      }
    }

    if (hadError) {
      throw new Error(`Claude Agent SDK failed while reviewing ${file}`);
    }

    if (!finalResult.trim()) {
      throw new Error(
        `Claude Agent SDK returned no final result for ${file}`
      );
    }

    return finalResult;
  }

  private async githubRequest<T>(url: string): Promise<T> {
    const token = process.env.GITHUB_TOKEN;

    const response = await fetch(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'claude-multiagent-code-review',
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      }
    });

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 400);
      throw new Error(
        `GitHub API request failed (${response.status}): ${detail}`
      );
    }

    return response.json() as Promise<T>;
  }

  private async fetchPullRequestFiles(
    owner: string,
    repo: string,
    prNumber: number
  ): Promise<{ headSha: string; files: ChangedFile[] }> {
    const base =
      `https://api.github.com/repos/${encodeURIComponent(owner)}/` +
      `${encodeURIComponent(repo)}/pulls/${prNumber}`;

    const pr = await this.githubRequest<{ head: { sha: string } }>(base);

    const files = await this.githubRequest<ChangedFile[]>(
      `${base}/files?per_page=100`
    );

    if (!Array.isArray(files)) {
      throw new Error(
        'GitHub API returned an invalid pull-request files response.'
      );
    }

    return { headSha: pr.head.sha, files };
  }

  private shouldSkipFile(filename: string): boolean {
    return (
      /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock)$/i.test(
        filename
      ) ||
      /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|woff2?|ttf|map)$/i.test(
        filename
      ) ||
      /(^|\/)(dist|build|coverage|node_modules)\//i.test(filename)
    );
  }

  private async fetchFileReviewContent(
    owner: string,
    repo: string,
    headSha: string,
    file: ChangedFile
  ): Promise<string> {
    const patch = file.patch
      ? `PATCH / DIFF:\n${file.patch}`
      : 'Patch unavailable from GitHub API.';

    let source = '';

    if (file.status !== 'removed') {
      const rawUrl =
        `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/` +
        `${encodeURIComponent(repo)}/${headSha}/` +
        file.filename.split('/').map(encodeURIComponent).join('/');

      try {
        const token = process.env.GITHUB_TOKEN;
        const response = await fetch(rawUrl, {
          headers: {
            'User-Agent': 'claude-multiagent-code-review',
            ...(token ? { Authorization: `Bearer ${token}` } : {})
          }
        });

        if (response.ok) {
          source = (await response.text()).slice(0, 20000);
        }
      } catch (error) {
        logger.warn('Could not fetch full source; using available diff', {
          file: file.filename,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    return [
      `File: ${file.filename}`,
      `Status: ${file.status}`,
      `Additions: ${file.additions ?? 'unknown'}`,
      `Deletions: ${file.deletions ?? 'unknown'}`,
      '',
      patch,
      '',
      'FULL FILE CONTENT AT PR HEAD (when available):',
      source || '[Full file unavailable; use the diff above.]'
    ].join('\n');
  }

  private extractJson(response: string): unknown {
    const cleaned = response
      .replace(/```(?:json)?\s*/gi, '')
      .replace(/```/g, '')
      .trim();

    try {
      return JSON.parse(cleaned);
    } catch {
      const start = cleaned.indexOf('{');
      const end = cleaned.lastIndexOf('}');

      if (start < 0 || end <= start) {
        throw new Error(
          'Orchestrator response did not contain a valid JSON object.'
        );
      }

      return JSON.parse(cleaned.slice(start, end + 1));
    }
  }

  private generateRecommendations(
    fileReviews: ReviewReport['fileReviews']
  ): ReviewReport['recommendations'] {
    const recommendations: ReviewReport['recommendations'] = [];

    const criticalIssues = fileReviews.flatMap((review) =>
      review.codeQuality.issues
        .filter((issue) => issue.severity === 'critical')
        .map(() => review.file)
    );

    if (criticalIssues.length > 0) {
      recommendations.push({
        priority: 'critical',
        category: 'Critical Issues',
        description: `Review and address ${criticalIssues.length} critical issue(s).`,
        files: [...new Set(criticalIssues)]
      });
    }

    const highPriorityTests = fileReviews.flatMap((review) =>
      review.testCoverage.untestedPaths
        .filter(
          (path) => path.priority === 'critical' || path.priority === 'high'
        )
        .map(() => review.file)
    );

    if (highPriorityTests.length > 0) {
      recommendations.push({
        priority: 'high',
        category: 'Test Coverage',
        description: `Add tests for ${highPriorityTests.length} high-priority untested path(s).`,
        files: [...new Set(highPriorityTests)]
      });
    }

    const highImpactRefactors = fileReviews.flatMap((review) =>
      review.refactorings.suggestions
        .filter((suggestion) => suggestion.impact === 'high')
        .map(() => review.file)
    );

    if (highImpactRefactors.length > 0) {
      recommendations.push({
        priority: 'medium',
        category: 'Refactoring',
        description: `Evaluate ${highImpactRefactors.length} high-impact refactoring suggestion(s).`,
        files: [...new Set(highImpactRefactors)]
      });
    }

    return recommendations.slice(0, 10);
  }
}
