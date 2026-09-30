import { AppConfigService } from './app-config.service';

describe('AppConfigService & MaintenanceGuard (#424, #425)', () => {
  let service: AppConfigService;
  let prisma: any;
  let redis: any;
  let auditLog: any;

  beforeEach(() => {
    prisma = {
      appConfig: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockImplementation(({ create }) => Promise.resolve({ key: create.key, value: create.value })),
      },
    };

    redis = {
      getJson: jest.fn().mockResolvedValue(null),
      setJson: jest.fn().mockResolvedValue(undefined),
      del: jest.fn().mockResolvedValue(undefined),
    };

    auditLog = {
      record: jest.fn().mockResolvedValue(undefined),
    };

    service = new AppConfigService(prisma, redis, auditLog);
  });

  it('lists registered config keys with defaults', () => {
    const keys = service.listRegisteredKeys();
    expect(keys.some((k) => k.key === 'ipfs_upload_limits')).toBe(true);
    expect(keys.some((k) => k.key === 'maintenance')).toBe(true);
  });

  it('validates config updates against Joi schema and audits changes', async () => {
    const update = {
      enabled: true,
      message: 'Maintenance in progress',
      until: new Date(Date.now() + 3600000).toISOString(),
    };

    const res = await service.updateValue('maintenance', update, 'GADMIN...', 'admin-1');
    expect(res).toEqual(update);
    expect(prisma.appConfig.upsert).toHaveBeenCalled();
    expect(redis.del).toHaveBeenCalledWith('app_config:maintenance');
    expect(auditLog.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'APP_CONFIG_UPDATED',
        resourceId: 'maintenance',
      }),
    );
  });

  it('rejects invalid schema values', async () => {
    const invalidUpdate = {
      enabled: 'not-a-boolean',
    };

    await expect(service.updateValue('maintenance', invalidUpdate, 'GADMIN...')).rejects.toThrow();
  });
});
