import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Logger,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { EmailAuthService } from './email-auth.service';
import { StellarService } from './stellar.service';
import { AdminActivityRepository, type WalletActionFunction } from './admin-activity.repository';
import { feeBearingAmount } from './wire-args';
import { RequestEmailCodeDto } from './dto/request-email-code.dto';
import { VerifyEmailCodeDto } from './dto/verify-email-code.dto';
import { EmailTradeDto } from './dto/email-trade.dto';
import { messageOf } from './email-auth.message';

const SESSION_COOKIE = 'polaris_session';

/**
 * The email-login counterpart to `WalletController`'s passkey endpoints —
 * see `EmailAuthService`'s doc comment for why this exists and how it maps
 * onto the same on-chain wallet/relay machinery. The session is an
 * httpOnly cookie (never touched by frontend JS, so an XSS bug can't steal
 * it the way reading a token out of `localStorage` would allow) carrying a
 * signed JWT — stateless, no server-side session store needed beyond the
 * `email_wallets` row `trade` looks up to find the custodial key.
 */
@Controller('auth/email')
export class EmailAuthController {
  private readonly logger = new Logger(EmailAuthController.name);

  constructor(
    private readonly emailAuth: EmailAuthService,
    private readonly config: ConfigService,
    private readonly stellar: StellarService,
    private readonly activity: AdminActivityRepository,
  ) {}

  @Post('request')
  @HttpCode(200)
  async request(@Body() dto: RequestEmailCodeDto) {
    try {
      await this.emailAuth.requestCode(dto.email);
    } catch (err) {
      throw new BadRequestException(messageOf(err));
    }
    return { sent: true };
  }

  @Post('verify')
  async verify(@Body() dto: VerifyEmailCodeDto, @Res({ passthrough: true }) res: Response) {
    let result: { address: string; sessionToken: string };
    try {
      result = await this.emailAuth.verifyCode(dto.email, dto.code);
    } catch (err) {
      throw new BadRequestException(messageOf(err));
    }
    res.cookie(SESSION_COOKIE, result.sessionToken, this.cookieOptions());
    return { address: result.address };
  }

  @Post('logout')
  @HttpCode(200)
  logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie(SESSION_COOKIE, this.cookieOptions());
    return { ok: true };
  }

  /** Lets the frontend check "am I already signed in via email" on load, without re-sending a code. */
  @Get('me')
  me(@Req() req: Request) {
    const session = this.emailAuth.verifySession(readCookie(req, SESSION_COOKIE));
    if (!session) {
      throw new UnauthorizedException('not signed in');
    }
    return { email: session.email, address: session.address };
  }

  @Post('trade')
  async trade(@Req() req: Request, @Body() dto: EmailTradeDto) {
    const session = this.emailAuth.verifySession(readCookie(req, SESSION_COOKIE));
    if (!session) {
      throw new UnauthorizedException('not signed in');
    }
    let result: { txHash: string; walletAddress: string };
    try {
      result = await this.emailAuth.signAndSubmitTrade(session.email, dto.contractId, dto.function, dto.args, dto.contractKind);
    } catch (err) {
      throw new BadRequestException(messageOf(err));
    }
    // Best-effort admin-dashboard logging — see wallet.controller.ts's
    // `submit` handler for the identical pattern and why a failure here
    // must never affect the real response.
    try {
      const feeBps = ['buy', 'sell'].includes(dto.function)
        ? await (dto.contractKind === 'perpetual'
            ? this.stellar.getPerpetualFee(dto.contractId)
            : this.stellar.getFee(dto.contractId))
        : undefined;
      this.activity.recordWalletAction({
        contractId: dto.contractId,
        walletAddress: result.walletAddress,
        functionName: dto.function as WalletActionFunction,
        collateralAmount: feeBearingAmount(dto.function, dto.args),
        feeBps,
        txHash: result.txHash,
        source: 'email',
      });
    } catch (err) {
      this.logger.warn(`failed to record admin-activity row for tx ${result.txHash}: ${(err as Error).message}`);
    }
    return { txHash: result.txHash };
  }

  private cookieOptions() {
    const isProd = process.env.NODE_ENV === 'production';
    return {
      httpOnly: true,
      secure: isProd,
      // Cross-site (different domain in a real deployment) cookies need
      // SameSite=None+Secure; same-site dev (localhost:3000 -> :3001) works
      // fine with Lax and doesn't need `Secure` over plain http.
      sameSite: (isProd ? 'none' : 'lax') as 'none' | 'lax',
      maxAge: this.config.get<number>('sessionTtlSecs')! * 1000,
      path: '/',
    };
  }
}

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return undefined;
}
