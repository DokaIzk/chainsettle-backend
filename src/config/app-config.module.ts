import { Module, Global } from '@nestjs/common';
import { AppConfigService } from './app-config.service';
import { AdminConfigController } from './admin-config.controller';
import { AuditLogsModule } from '../modules/audit-logs/audit-logs.module';

@Global()
@Module({
  imports: [AuditLogsModule],
  controllers: [AdminConfigController],
  providers: [AppConfigService],
  exports: [AppConfigService],
})
export class AppConfigModule {}
