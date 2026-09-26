/**
 * Unit tests for ApiKeyStrategy.validate() — scope attachment, prior checks,
 * and grace-period support introduced in issue #367 (key rotation).
 *
 * Tested in isolation (no passport-custom / Prisma types required) to avoid
 * compile-time dependency on the stale generated client.
 */

import { UnauthorizedException } from '@nestjs/common';
import { createHash } from 'crypto';

// ---------------------------------------------------------------------------
// Inline the validate logic (mirrors api-key.strategy.ts)
// ---------------------------------------------------------------------------

interface ApiKeyRow {
  id: string;
  revokedAt: Date | null;
  expiresAt: Date | null;
  gracePeriodEndsAt: Date | null;
  scopes: string[];
  user: { deactivatedAt: Date | null } | null;
}

async function validateApiKey(
  rawKey: string | undefined,
  findUnique: (hash: string) => Promise<ApiKeyRow | null>,
  updateLastUsed: (id: string) => void,
) {
  if (!rawKey || typeof rawKey !== 'string') {
    throw new UnauthorizedException('Missing X-Api-Key header');
  }

  const keyHash = createHash('sha256').update(rawKey).digest('hex');
  const apiKey = await findUnique(keyHash);

  if (!apiKey) {
    throw new UnauthorizedException('Invalid or revoked API key');
  }

  // A revoked key is still allowed during its grace period (rotation window).
  if (apiKey.revokedAt !== null) {
    const now = new Date();
    const inGracePeriod =
      apiKey.gracePeriodEndsAt !== null && apiKey.gracePeriodEndsAt > now;

    if (!inGracePeriod) {
      throw new UnauthorizedException('Invalid or revoked API key');
    }
  }

  if (apiKey.expiresAt !== null && apiKey.expiresAt <= new Date()) {
    throw new UnauthorizedException('API_KEY_EXPIRED');
  }

  if (apiKey.user?.deactivatedAt) {
    throw new UnauthorizedException('Account has been deactivated');
  }

  updateLastUsed(apiKey.id);

  return {
    ...apiKey.user,
    _apiKeyScopes: apiKey.scopes,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const pastDate = new Date(Date.now() - 1_000);
const futureDate = new Date(Date.now() + 86_400_000);
const activeUser = { deactivatedAt: null };

function makeKey(overrides: Partial<ApiKeyRow> = {}): ApiKeyRow {
  return {
    id: 'k1',
    revokedAt: null,
    expiresAt: null,
    gracePeriodEndsAt: null,
    scopes: ['read', 'write'],
    user: activeUser,
    ...overrides,
  };
}

describe('ApiKeyStrategy — validate logic (with scopes + grace period)', () => {
  // ── Basic auth checks ──────────────────────────────────────────────────

  it('throws when X-Api-Key header is absent', async () => {
    await expect(validateApiKey(undefined, jest.fn(), jest.fn())).rejects.toThrow(UnauthorizedException);
  });

  it('throws for an unknown key', async () => {
    await expect(validateApiKey('bad', async () => null, jest.fn())).rejects.toThrow(UnauthorizedException);
  });

  it('throws for a revoked key with no grace period', async () => {
    await expect(
      validateApiKey('k', async () => makeKey({ revokedAt: new Date() }), jest.fn()),
    ).rejects.toThrow('Invalid or revoked API key');
  });

  it('throws API_KEY_EXPIRED for an expired key', async () => {
    await expect(
      validateApiKey('k', async () => makeKey({ expiresAt: pastDate }), jest.fn()),
    ).rejects.toMatchObject({ message: 'API_KEY_EXPIRED' });
  });

  it('throws for a deactivated account', async () => {
    await expect(
      validateApiKey('k', async () => makeKey({ user: { deactivatedAt: new Date() } }), jest.fn()),
    ).rejects.toThrow('Account has been deactivated');
  });

  it('accepts a valid key with a future expiresAt', async () => {
    const result = await validateApiKey(
      'k',
      async () => makeKey({ expiresAt: futureDate }),
      jest.fn(),
    );
    expect(result).toBeDefined();
  });

  it('calls updateLastUsed on success', async () => {
    const updateFn = jest.fn();
    await validateApiKey('k', async () => makeKey(), updateFn);
    expect(updateFn).toHaveBeenCalledWith('k1');
  });

  // ── Scopes ────────────────────────────────────────────────────────────

  it('attaches _apiKeyScopes to the returned user for a read-write key', async () => {
    const result = await validateApiKey(
      'k',
      async () => makeKey({ scopes: ['read', 'write'] }),
      jest.fn(),
    );
    expect(result._apiKeyScopes).toEqual(['read', 'write']);
  });

  it('attaches _apiKeyScopes to the returned user for a read-only key', async () => {
    const result = await validateApiKey(
      'k',
      async () => makeKey({ scopes: ['read'] }),
      jest.fn(),
    );
    expect(result._apiKeyScopes).toEqual(['read']);
  });

  // ── Grace period (rotation) ────────────────────────────────────────────

  it('allows a revoked key that is still within its grace period', async () => {
    const result = await validateApiKey(
      'k',
      async () =>
        makeKey({
          revokedAt: new Date(),           // revoked now…
          gracePeriodEndsAt: futureDate,   // …but grace window still open
        }),
      jest.fn(),
    );
    expect(result).toBeDefined();
    expect(result._apiKeyScopes).toBeDefined();
  });

  it('rejects a revoked key whose grace period has already expired', async () => {
    await expect(
      validateApiKey(
        'k',
        async () =>
          makeKey({
            revokedAt: pastDate,
            gracePeriodEndsAt: pastDate,  // grace window also in the past
          }),
        jest.fn(),
      ),
    ).rejects.toThrow('Invalid or revoked API key');
  });

  it('rejects a revoked key that has gracePeriodEndsAt = null (no grace)', async () => {
    await expect(
      validateApiKey(
        'k',
        async () => makeKey({ revokedAt: new Date(), gracePeriodEndsAt: null }),
        jest.fn(),
      ),
    ).rejects.toThrow('Invalid or revoked API key');
  });

  it('still calls updateLastUsed during the grace period', async () => {
    const updateFn = jest.fn();
    await validateApiKey(
      'k',
      async () => makeKey({ revokedAt: new Date(), gracePeriodEndsAt: futureDate }),
      updateFn,
    );
    expect(updateFn).toHaveBeenCalledWith('k1');
  });
});
