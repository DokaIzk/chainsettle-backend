import { NotFoundException } from '@nestjs/common';
import { ShipmentTemplatesService } from './shipment-templates.service';

describe('ShipmentTemplatesService — soft delete (#306)', () => {
  let service: ShipmentTemplatesService;
  let prisma: any;

  beforeEach(() => {
    prisma = {
      shipmentTemplate: {
        findFirst: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        update: jest.fn().mockResolvedValue({}),
        delete: jest.fn(),
      },
      recurringSchedule: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      $transaction: jest.fn((ops: any[]) => Promise.all(ops)),
    };
    service = new ShipmentTemplatesService(prisma, { record: jest.fn() } as any);
  });

  it('sets deletedAt instead of removing the row', async () => {
    prisma.shipmentTemplate.findFirst.mockResolvedValue({ id: 't1', ownerId: 'owner-1' });

    await expect(service.delete('t1', 'owner-1')).resolves.toEqual({ success: true });

    expect(prisma.shipmentTemplate.delete).not.toHaveBeenCalled();
    expect(prisma.shipmentTemplate.update).toHaveBeenCalledWith({
      where: { id: 't1' },
      data: { deletedAt: expect.any(Date) },
    });
  });

  it('deactivates recurring schedules that depend on the deleted template (#389)', async () => {
    prisma.shipmentTemplate.findFirst.mockResolvedValue({ id: 't1', ownerId: 'owner-1' });

    await service.delete('t1', 'owner-1');

    expect(prisma.recurringSchedule.updateMany).toHaveBeenCalledWith({
      where: { templateId: 't1', active: true },
      data: { active: false },
    });
  });

  it('treats a soft-deleted template as not found', async () => {
    prisma.shipmentTemplate.findFirst.mockResolvedValue(null);

    await expect(service.findOne('t1')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.shipmentTemplate.findFirst).toHaveBeenCalledWith({ where: { id: 't1', deletedAt: null } });
  });

  it('excludes soft-deleted templates from list queries', async () => {
    await service.findAll('owner-1');
    await service.findMine('owner-1');

    for (const [args] of prisma.shipmentTemplate.findMany.mock.calls) {
      expect(args.where.deletedAt).toBeNull();
    }
    for (const [args] of prisma.shipmentTemplate.count.mock.calls) {
      expect(args.where.deletedAt).toBeNull();
    }
  });
});
