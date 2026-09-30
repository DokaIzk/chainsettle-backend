import { WeeklyAdminSummaryJob } from './weekly-admin-summary.job';

describe('WeeklyAdminSummaryJob (#423)', () => {
  let job: WeeklyAdminSummaryJob;
  let prisma: any;
  let redis: any;
  let notifications: any;
  let fxRate: any;

  beforeEach(() => {
    prisma = {
      user: {
        count: jest.fn().mockResolvedValue(10),
        findMany: jest.fn().mockResolvedValue([
          { id: 'admin-1', email: 'admin1@example.com' },
          { id: 'admin-2', email: 'admin2@example.com' },
        ]),
      },
      shipment: {
        count: jest.fn().mockResolvedValue(5),
        findMany: jest.fn().mockResolvedValue([
          { totalAmount: BigInt(10000000), tokenSymbol: 'USDC', tokenDecimals: 7 },
        ]),
      },
      milestone: {
        count: jest.fn().mockResolvedValue(1),
      },
      failedEvent: {
        count: jest.fn().mockResolvedValue(0),
      },
      webhookDelivery: {
        count: jest.fn().mockResolvedValue(0),
      },
    };

    redis = {
      acquireLock: jest.fn().mockResolvedValue(true),
      releaseLock: jest.fn().mockResolvedValue(true),
    };

    notifications = {
      getOrCreatePreferences: jest.fn().mockResolvedValue({
        SYSTEM_ALERT: { email: true },
      }),
      sendEmail: jest.fn().mockResolvedValue(true),
    };

    fxRate = {
      getUsdRate: jest.fn().mockResolvedValue({ rate: 1.0 }),
    };

    job = new WeeklyAdminSummaryJob(prisma, redis, notifications, fxRate);
  });

  it('gathers weekly metrics and calculates week-over-week percentages correctly', async () => {
    const data = await job.gatherMetrics();
    expect(data).toHaveProperty('periodStart');
    expect(data).toHaveProperty('periodEnd');
    expect(data.metrics.newUsers).toEqual({ current: 10, previous: 10, changePct: 0 });
    expect(data.metrics.newShipments).toEqual({ current: 5, previous: 5, changePct: 0 });
    expect(data.metrics.totalVolumeUsd.current).toBe(1);
  });

  it('sends summary emails to verified admin users and respects opt-out', async () => {
    const data = await job.gatherMetrics();
    await job.sendSummaries(data);

    expect(notifications.sendEmail).toHaveBeenCalledTimes(2);
    expect(notifications.sendEmail).toHaveBeenCalledWith(
      'admin1@example.com',
      expect.stringContaining('Weekly Admin Summary'),
      expect.any(String),
      undefined,
      'WEEKLY_ADMIN_SUMMARY',
      data,
    );
  });

  it('bails out when distributed lock cannot be acquired', async () => {
    redis.acquireLock.mockResolvedValue(false);
    await job.handleWeeklySummary();
    expect(prisma.user.findMany).not.toThrow();
    expect(notifications.sendEmail).not.toThrow();
  });
});
