import { Body, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { AppConfigService } from '../../config/app-config.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Roles(UserRole.ADMIN)
@Controller('admin/config')
export class AdminConfigController {
  constructor(private readonly appConfig: AppConfigService) {}

  @Get()
  @ApiOperation({ summary: '[Admin] List all registered AppConfig settings and values' })
  @ApiResponse({ status: 200, description: 'List of registered config keys with current values' })
  @ApiResponse({ status: 403, description: 'Admin access required' })
  getAll() {
    return this.appConfig.getAllConfig();
  }

  @Patch(':key')
  @ApiOperation({ summary: '[Admin] Update runtime AppConfig value for a registered key' })
  @ApiResponse({ status: 200, description: 'Config updated successfully' })
  @ApiResponse({ status: 400, description: 'Invalid value or unregistered key' })
  @ApiResponse({ status: 403, description: 'Admin access required' })
  updateKey(
    @Param('key') key: string,
    @Body() body: any,
    @CurrentUser() user: any,
  ) {
    return this.appConfig.updateValue(key, body, user.stellarAddress, user.id);
  }
}
