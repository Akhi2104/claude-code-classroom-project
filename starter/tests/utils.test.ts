import { describe, expect, it, vi } from 'vitest';
import {
  ErrorCodes,
  ReviewError,
  formatError,
  isReviewError,
  withRetry,
  withTimeout
} from '../src/utils/error-handler';
import { RateLimiter, withRateLimit } from '../src/utils/rate-limiter';

describe('Error handling utilities', () => {
  it('retries an operation until it succeeds', async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValueOnce('success');

    await expect(withRetry(operation, 2, 0)).resolves.toBe('success');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('wraps exhausted retries in ReviewError', async () => {
    await expect(
      withRetry(async () => {
        throw new Error('failed');
      }, 1, 0)
    ).rejects.toMatchObject({
      code: ErrorCodes.RETRY_EXHAUSTED
    });
  });

  it('identifies and formats ReviewError instances', () => {
    const error = new ReviewError('Timed out', ErrorCodes.AGENT_TIMEOUT);

    expect(isReviewError(error)).toBe(true);
    expect(formatError(error)).toBe('[AGENT_TIMEOUT] Timed out');
  });

  it('rejects an operation that exceeds its timeout', async () => {
    await expect(
      withTimeout(
        () => new Promise<string>((resolve) => setTimeout(() => resolve('late'), 50)),
        5
      )
    ).rejects.toMatchObject({
      code: ErrorCodes.AGENT_TIMEOUT
    });
  });
});

describe('Rate limiter utilities', () => {
  it('tracks requests and token usage', async () => {
    const limiter = new RateLimiter({
      maxRequestsPerMinute: 2,
      maxTokensPerMinute: 100,
      maxConcurrent: 2
    });

    await limiter.acquire(30);

    expect(limiter.getStatus()).toMatchObject({
      activeRequests: 1,
      requestsInWindow: 1,
      tokensInWindow: 30,
      availableRequests: 1,
      availableTokens: 70
    });

    limiter.release();
  });

  it('runs an operation through the rate limiter', async () => {
    const limiter = new RateLimiter({
      maxRequestsPerMinute: 2,
      maxTokensPerMinute: 100,
      maxConcurrent: 1
    });
    const operation = vi.fn().mockResolvedValue('done');

    await expect(withRateLimit(limiter, operation, 10)).resolves.toBe('done');
    expect(operation).toHaveBeenCalledOnce();
    expect(limiter.getStatus().activeRequests).toBe(0);
  });
});
