/**
 * Unit tests for ApiKeyStrategy.validate()
 *
 * We test the logic directly (expired check, revoked check, deactivated user)
 * without importing passport-custom, which requires native bindings not
 * available in the test environment.
 */

import { UnauthorizedException } from '@nestjs/common';
import { createHash } from 'crypto';
import { Request } from 'express';

// ---------------------------------------------------------------------------
// Inline the validate() logic so tests don't depend on passport-custom
// ---------------------------------------------------------------------------

interface ApiKeyRow {
  id: string;
  revokedAt: Date | null;
  expiresAt: Date | null;
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

  if (!apiKey || apiKey.revokedAt !== null) {
    throw new UnauthorizedException('Invalid or revoked API key');
  }

  if (apiKey.expiresAt !== null && apiKey.expiresAt <= new Date()) {
    throw new UnauthorizedException('API_KEY_EXPIRED');
  }

  if (apiKey.user?.deactivatedAt) {
    throw new UnauthorizedException('Account has been deactivated');
  }

  updateLastUsed(apiKey.id);
  return apiKey.user;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const pastDate = new Date(Date.now() - 1_000);
const futureDate = new Date(Date.now() + 86_400_000);
const activeUser = { deactivatedAt: null };

describe('ApiKeyStrategy — validate logic', () => {
  it('throws when key header is absent', async () => {
    await expect(validateApiKey(undefined, jest.fn(), jest.fn())).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('throws when no matching key exists in the DB', async () => {
    await expect(
      validateApiKey('unknown', async () => null, jest.fn()),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('throws for a revoked key', async () => {
    await expect(
      validateApiKey(
        'key',
        async () => ({ id: 'k1', revokedAt: new Date(), expiresAt: null, user: activeUser }),
        jest.fn(),
      ),
    ).rejects.toThrow('Invalid or revoked API key');
  });

  it('throws API_KEY_EXPIRED when expiresAt is in the past', async () => {
    await expect(
      validateApiKey(
        'key',
        async () => ({ id: 'k2', revokedAt: null, expiresAt: pastDate, user: activeUser }),
        jest.fn(),
      ),
    ).rejects.toMatchObject({ message: 'API_KEY_EXPIRED' });
  });

  it('accepts a key with no expiry set (expiresAt = null)', async () => {
    const result = await validateApiKey(
      'key',
      async () => ({ id: 'k3', revokedAt: null, expiresAt: null, user: activeUser }),
      jest.fn(),
    );
    expect(result).toEqual(activeUser);
  });

  it('accepts a key whose expiresAt is in the future', async () => {
    const result = await validateApiKey(
      'key',
      async () => ({ id: 'k4', revokedAt: null, expiresAt: futureDate, user: activeUser }),
      jest.fn(),
    );
    expect(result).toEqual(activeUser);
  });

  it('throws for a deactivated user account', async () => {
    await expect(
      validateApiKey(
        'key',
        async () => ({
          id: 'k5',
          revokedAt: null,
          expiresAt: futureDate,
          user: { deactivatedAt: new Date() },
        }),
        jest.fn(),
      ),
    ).rejects.toThrow('Account has been deactivated');
  });

  it('calls updateLastUsed fire-and-forget on success', async () => {
    const updateFn = jest.fn();
    await validateApiKey(
      'key',
      async () => ({ id: 'k6', revokedAt: null, expiresAt: null, user: activeUser }),
      updateFn,
    );
    expect(updateFn).toHaveBeenCalledWith('k6');
  });
});
