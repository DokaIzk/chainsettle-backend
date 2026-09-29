import { IsOptional, IsString, IsEmail, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsISO31661Alpha2 } from '../../../common/validators/is-iso-3166-1-alpha2.validator';

export class UpdateProfileDto {
  @ApiPropertyOptional({ example: 'John Doe', description: 'User display name' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({ example: 'john@example.com', description: 'User email address' })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({
    example: 'Acme Logistics Ltd',
    description: 'Legal entity or trading name of the organisation (max 200 characters)',
    maxLength: 200,
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  organizationName?: string;

  @ApiPropertyOptional({
    example: 'US',
    description: 'ISO 3166-1 alpha-2 country code of the organisation jurisdiction (e.g. "US", "DE")',
  })
  @IsOptional()
  @IsISO31661Alpha2()
  countryCode?: string;
}
