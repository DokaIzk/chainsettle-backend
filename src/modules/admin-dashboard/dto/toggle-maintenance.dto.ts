import { IsBoolean, IsOptional, IsString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ToggleMaintenanceDto {
  @ApiProperty({ description: 'Whether maintenance mode is enabled' })
  @IsBoolean()
  enabled: boolean;

  @ApiPropertyOptional({ description: 'Maintenance banner message' })
  @IsOptional()
  @IsString()
  message?: string;

  @ApiPropertyOptional({ description: 'Estimated end time (ISO-8601 string)' })
  @IsOptional()
  @IsString()
  until?: string;
}
