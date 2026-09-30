import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import { AppConfigService } from '../../config/app-config.service';

@ApiTags('status')
@Controller('status')
export class StatusController {
  constructor(private readonly appConfig: AppConfigService) {}

  @Get()
  @Public()
  @ApiOperation({ summary: 'Get public system status including maintenance mode banner state' })
  async getStatus() {
    const maintenance = await this.appConfig.getValue<{ enabled: boolean; message?: string; until?: string | null }>('maintenance');
    return {
      status: maintenance?.enabled ? 'maintenance' : 'operational',
      maintenance: {
        enabled: maintenance?.enabled ?? false,
        message: maintenance?.message ?? '',
        until: maintenance?.until ?? null,
      },
      timestamp: new Date().toISOString(),
    };
  }
}
