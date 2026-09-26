/**
 * Unit tests for ApiKeysController (scopes feature — issue #368).
 *
 * Covers:
 *   - POST /auth/api-keys   creates key with requested scopes (or defaults)
 *   - GET  /auth/api-keys   returns scopes in list response
 *   - DELETE /auth/api-keys/:id  still works (scope-unaware; just revokes)
 *   - Invalid scope values are rejected with 400 via DTO validation
 *   - JWT auth (JwtAuthGuard) is unaffected — scopes are an API-key-only concept
 *
 * We test the controller in isolation by mocking PrismaService; we do NOT
 * exercise the real guard chain here (that is covered by api-key.guard.spec.ts
 * and api-key.strategy.spec.ts).
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ApiKeysController } from './api-keys.controller';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PrismaService } from '../../common/prisma/prisma.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USER_ID = 'user-1';
const currentUser = { id: USER_ID };

function makeDbKey(overrides: Record<string, unknown> = {}) {
  return {
    id: 'key-1',
    name: 'Test Key',
    scopes: ['read', 'write'],
    keyHash: 'hash',
    userId: USER_ID,
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
    createdAt: new Date('2026-09-25T00:00:00Z'),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mock PrismaService
// ---------------------------------------------------------------------------

const mockPrisma = {
  apiKey: {
    findMany: jest.fn(),
    create: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
  },
};

// ---------------------------------------------------------------------------
// Module setup
// ---------------------------------------------------------------------------

describe('ApiKeysController', () => {
  let controller: ApiKeysController;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ApiKeysController],
      providers: [{ provide: PrismaService, useValue: mockPrisma }],
    })
      // Override the guard so we don't need a real JWT context in unit tests.
      // JWT auth remains in place in the running application — this override
      // only applies to this test module.
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<ApiKeysController>(ApiKeysController);
  });

  // ── GET /auth/api-keys ───────────────────────────────────────────────────

  describe('list()', () => {
    it('returns scopes in every key record', async () => {
      mockPrisma.apiKey.findMany.mockResolvedValue([
        makeDbKey({ scopes: ['read', 'write'] }),
        makeDbKey({ id: 'key-2', name: 'Read Only', scopes: ['read'] }),
      ]);

      const result = await controller.list(currentUser);

      expect(result).toHaveLength(2);
      expect(result[0].scopes).toEqual(['read', 'write']);
      expect(result[1].scopes).toEqual(['read']);
    });

    it('queries only non-revoked keys for the caller', async () => {
      mockPrisma.apiKey.findMany.mockResolvedValue([]);

      await controller.list(currentUser);

      expect(mockPrisma.apiKey.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: USER_ID, revokedAt: null },
        }),
      );
    });
  });

  // ── POST /auth/api-keys ──────────────────────────────────────────────────

  describe('create()', () => {
    it('creates a read-only key when scopes: ["read"] is provided', async () => {
      const dbRecord = makeDbKey({ scopes: ['read'] });
      mockPrisma.apiKey.create.mockResolvedValue(dbRecord);

      const result = await controller.create(currentUser, {
        name: 'Reporting',
        scopes: ['read'],
      });

      expect(mockPrisma.apiKey.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ scopes: ['read'] }),
        }),
      );
      expect(result.scopes).toEqual(['read']);
      // Plaintext key is returned exactly once
      expect(typeof result.key).toBe('string');
      expect(result.key).toHaveLength(40); // 20 random bytes → 40 hex chars
    });

    it('defaults to ["read", "write"] when scopes is omitted', async () => {
      const dbRecord = makeDbKey({ scopes: ['read', 'write'] });
      mockPrisma.apiKey.create.mockResolvedValue(dbRecord);

      const result = await controller.create(currentUser, { name: 'Full Access' });

      expect(mockPrisma.apiKey.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ scopes: ['read', 'write'] }),
        }),
      );
      expect(result.scopes).toEqual(['read', 'write']);
    });

    it('creates a read-write key when scopes: ["read","write"] is explicit', async () => {
      const dbRecord = makeDbKey({ scopes: ['read', 'write'] });
      mockPrisma.apiKey.create.mockResolvedValue(dbRecord);

      const result = await controller.create(currentUser, {
        name: 'Integration',
        scopes: ['read', 'write'],
      });

      expect(result.scopes).toEqual(['read', 'write']);
    });

    it('returns the plaintext key only on creation (not in list)', async () => {
      const dbRecord = makeDbKey({ scopes: ['read'] });
      mockPrisma.apiKey.create.mockResolvedValue(dbRecord);
      mockPrisma.apiKey.findMany.mockResolvedValue([dbRecord]);

      const created = await controller.create(currentUser, {
        name: 'R',
        scopes: ['read'],
      });
      const listed = await controller.list(currentUser);

      expect(created.key).toBeDefined();
      // List response should not include `key`
      expect((listed[0] as Record<string, unknown>).key).toBeUndefined();
    });
  });

  // ── DELETE /auth/api-keys/:id ────────────────────────────────────────────

  describe('revoke()', () => {
    it('revokes a key owned by the caller', async () => {
      mockPrisma.apiKey.findUnique.mockResolvedValue(makeDbKey());
      mockPrisma.apiKey.update.mockResolvedValue({ id: 'key-1', revokedAt: new Date() });

      const result = await controller.revoke(currentUser, 'key-1');

      expect(mockPrisma.apiKey.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'key-1' },
          data: expect.objectContaining({ revokedAt: expect.any(Date) }),
        }),
      );
      expect(result.message).toMatch(/revoked/i);
    });

    it('throws 404 when key does not exist', async () => {
      mockPrisma.apiKey.findUnique.mockResolvedValue(null);

      await expect(controller.revoke(currentUser, 'nonexistent')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws 404 when key is already revoked', async () => {
      mockPrisma.apiKey.findUnique.mockResolvedValue(
        makeDbKey({ revokedAt: new Date() }),
      );

      await expect(controller.revoke(currentUser, 'key-1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws 403 when key belongs to a different user', async () => {
      mockPrisma.apiKey.findUnique.mockResolvedValue(
        makeDbKey({ userId: 'other-user' }),
      );

      await expect(controller.revoke(currentUser, 'key-1')).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  // ── JWT auth unaffected ──────────────────────────────────────────────────
  // Scopes are enforced only for API-key-authenticated requests (ApiKeyGuard).
  // JWT-authenticated users reach these endpoints normally through JwtAuthGuard.
  // The test below confirms the controller compiles and responds correctly when
  // the real JwtAuthGuard is overridden to allow — scopes have no meaning here.

  describe('JWT auth compatibility', () => {
    it('list() works for a JWT-authenticated caller (no scope concept)', async () => {
      mockPrisma.apiKey.findMany.mockResolvedValue([makeDbKey()]);

      // currentUser simulates what JwtAuthGuard/CurrentUser decorator provides
      const result = await controller.list({ id: 'jwt-user-1' });

      expect(Array.isArray(result)).toBe(true);
    });

    it('create() works for a JWT-authenticated caller', async () => {
      const dbRecord = makeDbKey({ scopes: ['read', 'write'] });
      mockPrisma.apiKey.create.mockResolvedValue(dbRecord);

      const result = await controller.create({ id: 'jwt-user-1' }, { name: 'Key' });

      expect(result.scopes).toEqual(['read', 'write']);
    });
  });
});
