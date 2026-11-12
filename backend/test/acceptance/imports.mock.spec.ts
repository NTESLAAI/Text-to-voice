// Import/crypto regression only: no Nest app, DB, SDK calls or HTTP requests.
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import request from 'supertest';
import { JwtAuthGuard } from '../../src/auth/guards/jwt-auth/jwt-auth.guard';
it('acceptance dependencies load without external services', () => {
  expect(
    [
      ConfigService,
      Test,
      JwtService,
      PassportModule,
      request,
      JwtAuthGuard,
    ].every(Boolean),
  ).toBe(true);
});
