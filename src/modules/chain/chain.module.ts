import { Module } from '@nestjs/common';
import { ChainController } from './chain.controller';
import { RedisModule } from '../../common/redis/redis.module';
import { PrismaModule } from '../../common/prisma/prisma.module';

@Module({
  imports: [RedisModule, PrismaModule],
  controllers: [ChainController],
})
export class ChainModule {}
