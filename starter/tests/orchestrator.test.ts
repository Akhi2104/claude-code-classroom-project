import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  fetch: vi.fn()
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: mocks.query
}));

vi.stubGlobal('fetch', mocks.fetch);

import { CodeReviewOrchestrator } from '../src/orchestrator';
import {
  CodeQualityResultSchema,
  TestCoverageResultSchema,
  RefactoringSuggestionSchema
} from '../src/types/analysis-results';
import { ReviewReportSchema } from '../src/types/report-types';

const validCodeQuality = {
  file: 'src/example.ts',
  issues: [],
  overallScore: 90,
  summary: 'No major code quality issues found.'
};

const validTestCoverage = {
  file: 'src/example.ts',
  hasTests: false,
  testFiles: [],
  untestedPaths: [],
  coverageEstimate: 0,
  summary: 'Coverage was not measured.'
};

const validRefactorings = {
  file: 'src/example.ts',
  suggestions: [],
  summary: 'No significant refactoring is required.'
};

const validFileAnalysis = {
  codeQuality: validCodeQuality,
  testCoverage: validTestCoverage,
  refactorings: validRefactorings
};

function makeSdkResult(result: unknown) {
  return (async function* () {
    yield {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: JSON.stringify(result)
    };
  })();
}

function mockGitHubResponses() {
  mocks.fetch.mockImplementation(async (input: string | URL) => {
    const url = String(input);

    if (url.includes('/pulls/123/files')) {
      return {
        ok: true,
        json: async () => [
          {
            filename: 'src/example.ts',
            status: 'modified',
            patch: '@@ -1 +1 @@\n-oldValue\n+newValue',
            additions: 1,
            deletions: 1
          }
        ]
      };
    }

    if (url.includes('/pulls/123')) {
      return {
        ok: true,
        json: async () => ({
          head: { sha: 'abc123' }
        })
      };
    }

    if (url.includes('raw.githubusercontent.com')) {
      return {
        ok: true,
        text: async () => 'export const value = "newValue";'
      };
    }

    return {
      ok: false,
      status: 404,
      text: async () => 'Not found'
    };
  });
}

describe('Analysis schemas', () => {
  it('accepts valid code quality results', () => {
    expect(
      CodeQualityResultSchema.safeParse(validCodeQuality).success
    ).toBe(true);
  });

  it('rejects an invalid severity and an out-of-range score', () => {
    expect(
      CodeQualityResultSchema.safeParse({
        ...validCodeQuality,
        overallScore: 120
      }).success
    ).toBe(false);

    expect(
      CodeQualityResultSchema.safeParse({
        ...validCodeQuality,
        issues: [
          {
            line: 1,
            severity: 'urgent',
            category: 'security',
            description: 'Example',
            suggestion: 'Fix it'
          }
        ]
      }).success
    ).toBe(false);
  });

  it('accepts valid test coverage results', () => {
    expect(
      TestCoverageResultSchema.safeParse(validTestCoverage).success
    ).toBe(true);
  });

  it('rejects coverage estimates outside 0–100', () => {
    expect(
      TestCoverageResultSchema.safeParse({
        ...validTestCoverage,
        coverageEstimate: 101
      }).success
    ).toBe(false);
  });

  it('accepts valid refactoring results', () => {
    expect(
      RefactoringSuggestionSchema.safeParse(validRefactorings).success
    ).toBe(true);
  });

  it('rejects unsupported refactoring types', () => {
    expect(
      RefactoringSuggestionSchema.safeParse({
        ...validRefactorings,
        suggestions: [
          {
            type: 'rewrite-everything',
            location: 'example',
            impact: 'high',
            description: 'Example',
            before: 'Old',
            after: 'New',
            benefits: 'Example benefit'
          }
        ]
      }).success
    ).toBe(false);
  });
});

describe('ReviewReportSchema', () => {
  it('accepts a valid aggregated report', () => {
    const report = {
      pullRequest: {
        owner: 'octocat',
        repo: 'Hello-World',
        number: 123
      },
      fileReviews: [
        {
          file: 'src/example.ts',
          codeQuality: validCodeQuality,
          testCoverage: validTestCoverage,
          refactorings: validRefactorings
        }
      ],
      summary: {
        totalFiles: 1,
        overallScore: 90,
        criticalIssues: 0,
        highPriorityTests: 0,
        refactoringOpportunities: 0
      },
      recommendations: [],
      metadata: {
        analyzedAt: new Date().toISOString(),
        duration: 100,
        agentVersions: {
          orchestrator: '1.2.0'
        }
      }
    };

    expect(ReviewReportSchema.safeParse(report).success).toBe(true);
  });

  it('rejects a report with an invalid nested analysis result', () => {
    const report = {
      pullRequest: {
        owner: 'octocat',
        repo: 'Hello-World',
        number: 123
      },
      fileReviews: [
        {
          file: 'src/example.ts',
          codeQuality: {
            ...validCodeQuality,
            overallScore: -1
          },
          testCoverage: validTestCoverage,
          refactorings: validRefactorings
        }
      ],
      summary: {
        totalFiles: 1,
        overallScore: 90,
        criticalIssues: 0,
        highPriorityTests: 0,
        refactoringOpportunities: 0
      },
      recommendations: [],
      metadata: {
        analyzedAt: new Date().toISOString(),
        duration: 100,
        agentVersions: {}
      }
    };

    expect(ReviewReportSchema.safeParse(report).success).toBe(false);
  });
});

describe('CodeReviewOrchestrator', () => {
  afterEach(() => {
    mocks.fetch.mockReset();
    mocks.query.mockReset();
    vi.unstubAllEnvs();
  });

  it('initializes with default options', () => {
    expect(() => new CodeReviewOrchestrator()).not.toThrow();
  });

  it('accepts custom rate limit configuration', () => {
    expect(
      () =>
        new CodeReviewOrchestrator({
          rateLimits: {
            maxConcurrent: 2
          } as never
        })
    ).not.toThrow();
  });

  it('rejects invalid pull request arguments before making requests', async () => {
    const orchestrator = new CodeReviewOrchestrator();

    await expect(
      orchestrator.reviewPullRequest('', 'Hello-World', 123)
    ).rejects.toThrow(/valid repository owner/i);

    await expect(
      orchestrator.reviewPullRequest('octocat', 'Hello-World', 0)
    ).rejects.toThrow(/valid repository owner/i);

    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('fetches a PR, runs analysis, and returns a Zod-validated report', async () => {
    mockGitHubResponses();
    mocks.query.mockImplementation(() => makeSdkResult(validFileAnalysis));

    const orchestrator = new CodeReviewOrchestrator();
    const report = await orchestrator.reviewPullRequest(
      'octocat',
      'Hello-World',
      123
    );

    expect(mocks.fetch).toHaveBeenCalled();
    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(report.pullRequest).toEqual({
      owner: 'octocat',
      repo: 'Hello-World',
      number: 123
    });
    expect(report.fileReviews).toHaveLength(1);
    expect(report.fileReviews[0].codeQuality.overallScore).toBe(90);
    expect(ReviewReportSchema.safeParse(report).success).toBe(true);
  });

  it('fails when the SDK returns no final result', async () => {
    mockGitHubResponses();
    mocks.query.mockImplementation(
      () =>
        (async function* () {
          yield {
            type: 'result',
            subtype: 'success',
            is_error: false,
            result: ''
          };
        })()
    );

    const orchestrator = new CodeReviewOrchestrator();

    await expect(
      orchestrator.reviewPullRequest('octocat', 'Hello-World', 123)
    ).rejects.toThrow(/No files were successfully reviewed/i);
  });

  it('fails when the analysis response does not match the schema', async () => {
    mockGitHubResponses();

    mocks.query.mockImplementation(() =>
      makeSdkResult({
        ...validFileAnalysis,
        codeQuality: {
          ...validCodeQuality,
          overallScore: 999
        }
      })
    );

    const orchestrator = new CodeReviewOrchestrator();

    await expect(
      orchestrator.reviewPullRequest('octocat', 'Hello-World', 123)
    ).rejects.toThrow();
  });
});
