import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    const exceptionResponse =
      exception instanceof HttpException ? exception.getResponse() : null;

    // Do not log URLs, query strings, bodies or raw exceptions from providers.
    this.logger.error(`HTTP_REQUEST_FAILED status=${status}`);

    let message = 'Lỗi kết nối, xin vui lòng thử lại.';

    if (exception instanceof HttpException && status < 500) {
      if (typeof exceptionResponse === 'string') {
        message = exceptionResponse;
      } else if (
        exceptionResponse &&
        typeof exceptionResponse === 'object' &&
        'message' in exceptionResponse
      ) {
        const responseMessage = exceptionResponse.message;

        message = Array.isArray(responseMessage)
          ? responseMessage.join(', ')
          : String(responseMessage);
      }
    }

    // Explicit protocol fields only; never spread an exception response.
    const protocol: Record<string, string> = {};
    if (exceptionResponse && typeof exceptionResponse === 'object') {
      const body = exceptionResponse as Record<string, unknown>;
      if (status === 500 && body.code === 'PAYMENT_ACTIVATION_FAILED') {
        protocol.code = 'PAYMENT_ACTIVATION_FAILED';
        if (body.receiptStatus === 'MATCHED')
          protocol.receiptStatus = 'MATCHED';
        if (body.activationStatus === 'FAILED')
          protocol.activationStatus = 'FAILED';
      } else if (status === 400 && body.code === 'PAYMENT_UNDERFUNDED') {
        protocol.code = 'PAYMENT_UNDERFUNDED';
      }
    }

    response.status(status).json({
      statusCode: status,
      message,
      ...protocol,
    });
  }
}
