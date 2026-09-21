import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    const exceptionResponse =
      exception instanceof HttpException ? exception.getResponse() : null;

    this.logger.error(
      `[${status}] ${request.method} ${request.url}`,
      exception instanceof Error ? exception.stack : String(exception),
    );

    let message = 'Lỗi kết nối, xin vui lòng thử lại.';

    if (exception instanceof HttpException) {
      if (typeof exceptionResponse === 'string') {
        message = exceptionResponse;
      } else if (
        exceptionResponse &&
        typeof exceptionResponse === 'object' &&
        'message' in exceptionResponse
      ) {
        const responseMessage = (exceptionResponse as { message: unknown })
          .message;

        message = Array.isArray(responseMessage)
          ? responseMessage.join(', ')
          : String(responseMessage);
      }
    }

    response.status(status).json({
      statusCode: status,
      message,
    });
  }
}
