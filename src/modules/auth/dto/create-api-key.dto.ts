import { IsString, IsNotEmpty, MaxLength, IsOptional, IsDateString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsFutureDate } from '../../../common/validators/is-future-date.validator';
import { IsAtMostOneYearAhead } from '../../../common/validators/is-at-most-one-year-ahead.validator';

export class CreateApiKeyDto {
  @ApiProperty({
    example: 'CI Pipeline',
    description: 'A human-readable label for this API key',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  name: string;

  @ApiPropertyOptional({
    example: '2027-09-25T00:00:00.000Z',
    description:
      'Optional expiry date (ISO 8601). Must be in the future and at most 1 year from now. Omit for a non-expiring key.',
  })
  @IsOptional()
  @IsDateString()
  @IsFutureDate()
  @IsAtMostOneYearAhead()
  expiresAt?: string;
}
