
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

export interface OrchestratorOptions {
  rateLimits?: Partial<RateLimiterConfig>;
}

export class CodeReviewOrchestrator {
  private rateLimiter: RateLimiter;

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
    if (!owner.trim() || !repo.trim() || !Number.isInteger(prNumber) || prNumber <= 0) {
      throw new Error('A valid repository owner, repository name, and PR number are required.');
    }

    const startTime = Date.now();
    logReviewStart(owner, repo, prNumber);

    // Fetch PR metadata and changed files directly from GitHub REST API. This avoids
    // requiring Claude to request interactive permission for GitHub MCP tools.
    const { files: changedFiles, headSha } = await this.fetchPullRequestFiles(owner, repo, prNumber);
    const selectedFiles = changedFiles.filter((item) => !this.shouldSkipFile(item.filename)).slice(0, 10);

    if (selectedFiles.length === 0) {
      throw new Error(`No reviewable changed files found for ${owner}/${repo} PR #${prNumber}.`);
    }

    logger.info(`Retrieved ${changedFiles.length} changed files from PR #${prNumber}; reviewing ${selectedFiles.length}`);

    const results = await Promise.allSettled(
      selectedFiles.map(async (changedFile) => {
        const file = changedFile.filename;
        const fileContent = await this.fetchFileReviewContent(owner, repo, headSha, changedFile);
        if (!fileContent.trim()) {
          throw new Error(`GitHub returned no code or diff for ${file}`);
        }

        const [codeQuality, testCoverage, refactorings] = await Promise.all([
          this.analyzeCodeQuality(file, fileContent),
          this.analyzeTestCoverage(file, fileContent),
          this.suggestRefactorings(file, fileContent)
        ]);

        return { file, codeQuality, testCoverage, refactorings };
      })
    );

    const fileReviews = results
      .filter(
        (result): result is PromiseFulfilledResult<{
          file: string;
          codeQuality: CodeQualityResult;
          testCoverage: TestCoverageResult;
          refactorings: RefactoringSuggestion;
        }> => result.status === 'fulfilled'
      )
      .map((result) => result.value);

    const failedFiles = results
      .filter(
        (result): result is PromiseRejectedResult => result.status === 'rejected'
      );

    for (const failure of failedFiles) {
      logger.error('File review failed', {
        error: failure.reason instanceof Error
          ? failure.reason.message
          : String(failure.reason)
      });
    }

    if (fileReviews.length === 0) {
      throw new Error(
        `No files were successfully reviewed for ${owner}/${repo} PR #${prNumber}. ` +
        `${failedFiles.length} file review(s) failed. Check the logs; no empty report was generated.`
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
          sum + review.codeQuality.issues.filter(
            (issue) => issue.severity === 'critical'
          ).length,
        0
      ),
      highPriorityTests: fileReviews.reduce(
        (sum, review) =>
          sum + review.testCoverage.untestedPaths.filter(
            (path) => path.priority === 'critical' || path.priority === 'high'
          ).length,
        0
      ),
      refactoringOpportunities: fileReviews.reduce(
        (sum, review) => sum + review.refactorings.suggestions.length,
        0
      )
    };

    const recommendations = this.generateRecommendations(fileReviews);
    const duration = Date.now() - startTime;

    logReviewComplete(owner, repo, prNumber, summary.overallScore, duration);

    const report: ReviewReport = {
      pullRequest: { owner, repo, number: prNumber },
      fileReviews,
      summary,
      recommendations,
      metadata: {
        analyzedAt: new Date().toISOString(),
        duration,
        agentVersions: {
          orchestrator: '1.1.0',
          codeQuality: '1.1.0',
          testCoverage: '1.1.0',
          refactoring: '1.1.0'
        }
      }
    };

    return ReviewReportSchema.parse(report);
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
      throw new Error(`GitHub API request failed (${response.status}) for ${url}: ${detail}`);
    }
    return response.json() as Promise<T>;
  }

  private async fetchPullRequestFiles(owner: string, repo: string, prNumber: number): Promise<{
    headSha: string;
    files: Array<{ filename: string; status: string; patch?: string; additions?: number; deletions?: number }>;
  }> {
    const base = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${prNumber}`;
    const pr = await this.githubRequest<{ head: { sha: string } }>(base);
    const files = await this.githubRequest<Array<{ filename: string; status: string; patch?: string; additions?: number; deletions?: number }>>(`${base}/files?per_page=100`);
    if (!Array.isArray(files)) throw new Error('GitHub API returned an invalid pull-request files response.');
    return { headSha: pr.head.sha, files };
  }

  private shouldSkipFile(filename: string): boolean {
    return /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock)$/i.test(filename) ||
      /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|woff2?|ttf|map)$/i.test(filename) ||
      /(^|\/)(dist|build|coverage|node_modules)\//i.test(filename);
  }

  private async fetchFileReviewContent(
    owner: string,
    repo: string,
    headSha: string,
    file: { filename: string; status: string; patch?: string; additions?: number; deletions?: number }
  ): Promise<string> {
    const patch = file.patch ? `PATCH / DIFF:\n${file.patch}` : 'Patch unavailable from GitHub API.';
    let source = '';

    if (file.status !== 'removed') {
      const rawUrl = `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${headSha}/${file.filename.split('/').map(encodeURIComponent).join('/')}`;
      try {
        const token = process.env.GITHUB_TOKEN;
        const response = await fetch(rawUrl, {
          headers: token ? { Authorization: `Bearer ${token}`, 'User-Agent': 'claude-multiagent-code-review' } : { 'User-Agent': 'claude-multiagent-code-review' }
        });
        if (response.ok) source = (await response.text()).slice(0, 20000);
      } catch (error) {
        logger.warn('Could not fetch full file content; reviewing available diff', {
          file: file.filename,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    return `File: ${file.filename}\nStatus: ${file.status}\nAdditions: ${file.additions ?? 'unknown'}\nDeletions: ${file.deletions ?? 'unknown'}\n\n${patch}\n\nFULL FILE CONTENT AT PR HEAD (when available):\n${source || '[Full file content unavailable; use the actual diff above.]'}`;
  }

  private parseFilePaths(response: string): string[] {
    const cleaned = response
      .replace(/```(?:json)?/gi, '')
      .replace(/```/g, '')
      .trim();

    // Prefer a complete JSON array.
    const start = cleaned.indexOf('[');
    const end = cleaned.lastIndexOf(']');

    if (start !== -1 && end > start) {
      try {
        const parsed: unknown = JSON.parse(cleaned.slice(start, end + 1));

        if (
          Array.isArray(parsed) &&
          parsed.every((item) => typeof item === 'string')
        ) {
          return [...new Set(
            parsed
              .map((item: string) => item.trim())
              .filter((item: string) =>
                item.length > 0 &&
                !item.startsWith('/') &&
                !item.split('/').includes('..')
              )
          )];
        }
      } catch {
        // Fall through to the conservative quoted-path extraction below.
      }
    }

    const matches = cleaned.matchAll(
      /["']([^"' \n]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|java|go|rb|php|cs|vue|svelte))["']/gi
    );

    return [...new Set(
      Array.from(matches, (match) => match[1])
        .filter((file): file is string =>
          file !== undefined &&
          file.length > 0 &&
          !file.startsWith('/') &&
          !file.split('/').includes('..')
        )
    )];
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

      if (start === -1 || end <= start) {
        throw new Error('Agent response did not contain a valid JSON object');
      }

      return JSON.parse(cleaned.slice(start, end + 1));
    }
  }

  private async sendQuery(prompt: string): Promise<string> {
    const q = query({
      prompt,
      options: {
        model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5-20250929',
        // This analysis needs no external tools; disabling tools prevents permission prompts.
        tools: [],
        permissionMode: 'dontAsk',
        agents: {
          'code-quality-analyzer': codeQualityAnalyzer,
          'test-coverage-analyzer': testCoverageAnalyzer,
          'refactoring-suggester': refactoringSuggester
        }
      }
    });

    const assistantTexts: string[] = [];
    let finalResultText = '';
    let messageCount = 0;
    const messageTypes: string[] = [];

    for await (const msg of q) {
      messageCount++;
      const record = msg as unknown as Record<string, unknown>;
      const type = typeof record.type === 'string' ? record.type : 'unknown';
      messageTypes.push(type);

      // Assistant messages contain text blocks in message.content.
      const message = record.message;
      if (typeof message === 'object' && message !== null) {
        const content = (message as Record<string, unknown>).content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (typeof block === 'object' && block !== null) {
              const item = block as Record<string, unknown>;
              if (item.type === 'text' && typeof item.text === 'string') {
                assistantTexts.push(item.text);
              }
            }
          }
        }
      }

      // The SDK's final result event may carry the final text separately.
      if (type === 'result' && typeof record.result === 'string') {
        finalResultText = record.result;
      }

      // Preserve useful diagnostics for SDK errors without logging credentials.
      if (type === 'result' && record.is_error === true) {
        const detail = typeof record.result === 'string'
          ? record.result
          : typeof record.subtype === 'string'
            ? record.subtype
            : 'Unknown Claude Agent SDK error';
        logger.error('Claude Agent SDK returned an error result', { detail });
      }
    }

    const assistantResponse = assistantTexts.join('\n').trim();
    const response = assistantResponse || finalResultText.trim();

    logger.info('Query completed', {
      totalMessages: messageCount,
      messageTypes: [...new Set(messageTypes)],
      textMessages: assistantTexts.length,
      resultTextAvailable: Boolean(finalResultText.trim()),
      totalLength: response.length
    });

    if (!response) {
      throw new Error(
        `Claude Agent SDK returned no text (message types: ${[...new Set(messageTypes)].join(', ') || 'none'}). ` +
        'Check the SDK result event and model/agent errors in the logs.'
      );
    }

    return response;
  }

  private async analyzeCodeQuality(
    file: string,
    content: string
  ): Promise<CodeQualityResult> {
    logAgentStart('code-quality-analyzer', file);
    const startTime = Date.now();

    const result = await withRetry(async () => {
      await this.rateLimiter.acquire(5000);
      try {
        return await withTimeout(
          () => this.sendQuery(
            `You are acting as the code-quality-analyzer. Analyze the actual code and diff below.

Return valid JSON matching this schema:
{
  "file": "string",
  "issues": [{
    "line": 1,
    "severity": "critical|high|medium|low|info",
    "category": "security|performance|maintainability|style|bug-risk|best-practice",
    "description": "Evidence-based finding",
    "suggestion": "Actionable fix"
  }],
  "overallScore": 85,
  "summary": "Evidence-based summary"
}

Use an empty issues array when no actionable issues are found. Never invent findings or line numbers.

File: ${file}

${content.substring(0, 10000)}`,
          ),
          120000,
          'Code quality analysis timed out'
        );
      } finally {
        this.rateLimiter.release(5000);
      }
    });

    logAgentComplete('code-quality-analyzer', file, Date.now() - startTime);
    return this.parseCodeQualityResult(file, result);
  }

  private async analyzeTestCoverage(
    file: string,
    content: string
  ): Promise<TestCoverageResult> {
    logAgentStart('test-coverage-analyzer', file);
    const startTime = Date.now();

    const result = await withRetry(async () => {
      await this.rateLimiter.acquire(5000);
      try {
        return await withTimeout(
          () => this.sendQuery(
            `You are acting as the test-coverage-analyzer. Analyze test coverage gaps for the code below. Do not claim measured coverage unless coverage data is supplied.

Return valid JSON matching this schema:
{
  "file": "string",
  "hasTests": false,
  "testFiles": [],
  "untestedPaths": [{
    "type": "function|class|branch|edge-case",
    "location": "Known function or location",
    "priority": "critical|high|medium|low",
    "reasoning": "Why this path needs a test",
    "suggestedTest": "Specific test scenario"
  }],
  "coverageEstimate": 0,
  "summary": "Explain what evidence was available"
}

Use only test files actually identified. Use 0 for coverageEstimate when no measured coverage is available and explain that it is not a measured percentage.

File: ${file}

${content.substring(0, 10000)}`,
          ),
          120000,
          'Test coverage analysis timed out'
        );
      } finally {
        this.rateLimiter.release(5000);
      }
    });

    logAgentComplete('test-coverage-analyzer', file, Date.now() - startTime);
    return this.parseTestCoverageResult(file, result);
  }

  private async suggestRefactorings(
    file: string,
    content: string
  ): Promise<RefactoringSuggestion> {
    logAgentStart('refactoring-suggester', file);
    const startTime = Date.now();

    const result = await withRetry(async () => {
      await this.rateLimiter.acquire(5000);
      try {
        return await withTimeout(
          () => this.sendQuery(
            `You are acting as the refactoring-suggester. Suggest practical refactorings supported by the actual code below.

Return valid JSON matching this schema:
{
  "file": "string",
  "suggestions": [{
    "type": "extract-function|rename|modernize|simplify|pattern-improvement",
    "location": "Known function or location",
    "impact": "low|medium|high",
    "description": "Current problem",
    "before": "Existing pattern",
    "after": "Suggested pattern",
    "benefits": "Expected benefit"
  }],
  "summary": "Evidence-based summary"
}

Use an empty suggestions array when no meaningful refactoring is warranted. Do not invent source lines or code.

File: ${file}

${content.substring(0, 10000)}`,
          ),
          120000,
          'Refactoring analysis timed out'
        );
      } finally {
        this.rateLimiter.release(5000);
      }
    });

    logAgentComplete('refactoring-suggester', file, Date.now() - startTime);
    return this.parseRefactoringResult(file, result);
  }

  private parseCodeQualityResult(
    file: string,
    response: string
  ): CodeQualityResult {
    const parsed = this.extractJson(response);

    return CodeQualityResultSchema.parse({
      ...(parsed as Record<string, unknown>),
      file
    });
  }

  private parseTestCoverageResult(
    file: string,
    response: string
  ): TestCoverageResult {
    const parsed = this.extractJson(response);

    return TestCoverageResultSchema.parse({
      ...(parsed as Record<string, unknown>),
      file
    });
  }

  private parseRefactoringResult(
    file: string,
    response: string
  ): RefactoringSuggestion {
    const parsed = this.extractJson(response);

    return RefactoringSuggestionSchema.parse({
      ...(parsed as Record<string, unknown>),
      file
    });
  }

  private generateRecommendations(fileReviews: ReviewReport['fileReviews']): ReviewReport['recommendations'] {
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
        .filter((path) => path.priority === 'critical' || path.priority === 'high')
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
