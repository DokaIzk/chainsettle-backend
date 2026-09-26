import { NotFoundException } from '@nestjs/common';
import { CommentVisibility } from '@prisma/client';
import { CommentsService } from './comments.service';

const BUYER = 'G' + 'B'.repeat(55);
const SUPPLIER = 'G' + 'S'.repeat(55);
const LOGISTICS = 'G' + 'L'.repeat(55);
const ARBITER = 'G' + 'A'.repeat(55);

const shipment = {
  id: 'SHIP-1',
  buyerAddress: BUYER,
  supplierAddress: SUPPLIER,
  logisticsAddress: LOGISTICS,
  arbiterAddress: ARBITER,
};

describe('CommentsService — threaded replies (#299)', () => {
  let service: CommentsService;
  let prisma: any;

  beforeEach(() => {
    prisma = {
      shipment: { findUnique: jest.fn().mockResolvedValue(shipment) },
      user: { findUnique: jest.fn().mockResolvedValue({ role: 'USER' }) },
      shipmentComment: {
        findFirst: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'reply-1', ...data })),
      },
      $transaction: jest.fn((ops: Promise<any>[]) => Promise.all(ops)),
    };
    const notifications = {
      notifyUser: jest.fn().mockResolvedValue(undefined),
      notifyUserWithForcedEmail: jest.fn().mockResolvedValue(undefined),
    };
    service = new CommentsService(prisma, notifications as any);
  });

  it('stores parentCommentId when replying to a live comment on the same shipment', async () => {
    prisma.shipmentComment.findFirst.mockResolvedValue({ id: 'parent-1' });

    const reply = await service.create('SHIP-1', 'user-1', BUYER, { body: 'agreed', parentCommentId: 'parent-1' });

    expect(prisma.shipmentComment.findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: 'parent-1', shipmentId: 'SHIP-1', deletedAt: null }),
    });
    expect(reply.parentCommentId).toBe('parent-1');
  });

  it('rejects a reply to a comment that does not exist on the shipment', async () => {
    prisma.shipmentComment.findFirst.mockResolvedValue(null);

    await expect(
      service.create('SHIP-1', 'user-1', BUYER, { body: 'hi', parentCommentId: 'missing' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.shipmentComment.create).not.toHaveBeenCalled();
  });

  it('creates a root comment when no parentCommentId is given', async () => {
    const comment = await service.create('SHIP-1', 'user-1', BUYER, { body: 'hello' });

    expect(prisma.shipmentComment.findFirst).not.toHaveBeenCalled();
    expect(comment.parentCommentId).toBeNull();
  });

  it('lists replies of a comment, oldest first', async () => {
    prisma.shipmentComment.findFirst.mockResolvedValue({ id: 'parent-1' });
    prisma.shipmentComment.findMany.mockResolvedValue([{ id: 'reply-1' }, { id: 'reply-2' }]);
    prisma.shipmentComment.count.mockResolvedValue(2);

    const result = await service.findReplies('SHIP-1', 'parent-1', BUYER);

    const args = prisma.shipmentComment.findMany.mock.calls[0][0];
    expect(args.where).toMatchObject({ shipmentId: 'SHIP-1', parentCommentId: 'parent-1', deletedAt: null });
    expect(args.orderBy).toEqual({ createdAt: 'asc' });
    expect(result.data.map((r: any) => r.id)).toEqual(['reply-1', 'reply-2']);
    expect(result.meta.total).toBe(2);
  });

  it('still lists replies when the parent comment is soft-deleted', async () => {
    prisma.shipmentComment.findFirst.mockResolvedValue({ id: 'parent-1', deletedAt: new Date() });
    prisma.shipmentComment.findMany.mockResolvedValue([{ id: 'reply-1' }]);
    prisma.shipmentComment.count.mockResolvedValue(1);

    const result = await service.findReplies('SHIP-1', 'parent-1', BUYER);

    // Parent lookup must not filter on deletedAt
    expect(prisma.shipmentComment.findFirst.mock.calls[0][0].where).not.toHaveProperty('deletedAt');
    expect(result.data).toHaveLength(1);
  });

  it('404s for replies of a comment the requester cannot see', async () => {
    prisma.shipmentComment.findFirst.mockResolvedValue(null);

    await expect(service.findReplies('SHIP-1', 'internal-1', BUYER)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('lists root comments only, with replyCount, and redacts deleted roots that still have replies', async () => {
    const deletedAt = new Date();
    prisma.shipmentComment.findMany.mockResolvedValue([
      { id: 'c1', body: 'live', attachmentCid: null, deletedAt: null, _count: { replies: 2 } },
      { id: 'c2', body: 'secret', attachmentCid: 'cid', deletedAt, _count: { replies: 1 } },
    ]);
    prisma.shipmentComment.count.mockResolvedValue(2);

    const result = await service.findAll('SHIP-1', BUYER);

    const where = prisma.shipmentComment.findMany.mock.calls[0][0].where;
    expect(where.parentCommentId).toBeNull();
    expect(where.OR).toEqual([
      { deletedAt: null },
      { replies: { some: { deletedAt: null, visibility: where.visibility } } },
    ]);
    expect(where.visibility.in).toEqual([CommentVisibility.ALL, CommentVisibility.BUYER_SUPPLIER]);

    expect(result.data[0]).toMatchObject({ id: 'c1', body: 'live', replyCount: 2, deleted: false });
    expect(result.data[0]).not.toHaveProperty('_count');
    expect(result.data[1]).toMatchObject({ id: 'c2', body: null, attachmentCid: null, replyCount: 1, deleted: true });
  });
});
