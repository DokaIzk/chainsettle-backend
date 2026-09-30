import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { AdminHealthController, HealthController } from './health.controller';
import { StatusController } from './status.controller';

@Module({
  imports: [TerminusModule],
  controllers: [HealthController, AdminHealthController, StatusController],
})
export class HealthModule {}
