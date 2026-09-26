import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
} from '@nestjs/swagger';
import { randomBytes, createHash } from 'crypto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CreateApiKeyDto, API_KEY_SCOPES } from './dto/create-api-key.dto';
import { ApiKeyResponseDto } from './dto/api-key-response.dto';

@ApiTags('Auth')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('auth/api-keys')
export class ApiKeysController {
  constructor(private readonly prisma: PrismaService) {}

  // ----------------------------------------------------------
  // GET /auth/api-keys
  // Lists all active (non-revoked) keys belonging to the caller
  // ----------------------------------------------------------
  @Get()
  @ApiOperation({ summary: 'List your API keys' })
  @ApiResponse({
    status: 200,
    description: 'Returns all non-revoked API keys for the caller, including scopes and expiry.',
    type: [ApiKeyResponseDto],
  })
  async list(@CurrentUser() user: { id: string }) {
    const keys = await this.prisma.apiKey.findMany({
      where: { userId: user.id, revokedAt: null },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        scopes: true,
        lastUsedAt: true,
        expiresAt: true,
        createdAt: true,
      },
    });

    return keys;
  }

  // ----------------------------------------------------------
  // POST /auth/api-keys
  // Generates a new API key — plaintext returned only once
  // ----------------------------------------------------------
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Generate a new API key (plaintext returned once)' })
  @ApiResponse({
    status: 201,
    description:
      'Key created. Save the plaintext key — it will not be shown again. ' +
      'Omit `scopes` for full access (["read","write"]); pass ["read"] for a read-only key.',
    type: ApiKeyResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed — invalid scope value or bad expiry date.',
  })
  async create(
    @CurrentUser() user: { id: string },
    @Body() dto: CreateApiKeyDto,
  ) {
    const plaintext = randomBytes(20).toString('hex'); // 40 hex chars
    const keyHash = createHash('sha256').update(plaintext).digest('hex');

    // Default to full access when the caller omits scopes
    const scopes: string[] = dto.scopes ?? [...API_KEY_SCOPES];

    const apiKey = await this.prisma.apiKey.create({
      data: {
        userId: user.id,
        keyHash,
        name: dto.name,
        scopes,
        expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
      },
    });

    return {
      id: apiKey.id,
      name: apiKey.name,
      scopes: apiKey.scopes,
      expiresAt: apiKey.expiresAt,
      createdAt: apiKey.createdAt,
      // Only time the plaintext is ever returned
      key: plaintext,
    };
  }

  // ----------------------------------------------------------
  // DELETE /auth/api-keys/:id
  // Revokes a key by setting revokedAt = now()
  // ----------------------------------------------------------
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Revoke an API key' })
  @ApiResponse({ status: 200, description: 'Key revoked successfully.' })
  @ApiResponse({ status: 404, description: 'API key not found.' })
  @ApiResponse({ status: 403, description: 'You do not own this key.' })
  async revoke(
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
  ) {
    const apiKey = await this.prisma.apiKey.findUnique({ where: { id } });

    if (!apiKey || apiKey.revokedAt !== null) {
      throw new NotFoundException('API key not found');
    }

    if (apiKey.userId !== user.id) {
      throw new ForbiddenException('You do not own this API key');
    }

    await this.prisma.apiKey.update({
      where: { id },
      data: { revokedAt: new Date() },
    });

    return { message: 'API key revoked successfully' };
  }
}
