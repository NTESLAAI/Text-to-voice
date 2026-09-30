import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class PaymentService {
  constructor(private readonly prisma: PrismaService) {}

  async createPayment(
    userId: string,
    planCode: string,
    upgradeOption?: string,
  ) {
    const normalizedPlanCode = planCode.trim().toUpperCase();

    const now = new Date();

    const plan = await this.prisma.plan.findUnique({
      where: {
        code: normalizedPlanCode,
      },
    });

    if (!plan || !plan.isActive) {
      throw new NotFoundException(
        'Gói sử dụng không tồn tại hoặc không còn hoạt động.',
      );
    }

    if (plan.code === 'FREE') {
      throw new BadRequestException('Không thể tạo thanh toán cho gói Free.');
    }

    const activeSubscription = await this.prisma.subscription.findFirst({
      where: {
        userId,
        status: 'ACTIVE',
        startedAt: {
          lte: now,
        },
        expiresAt: {
          gt: now,
        },
      },
      include: {
        plan: true,
        quotaLots: {
          where: {
            charactersRemaining: {
              gt: 0,
            },
            expiresAt: {
              gt: now,
            },
          },
          orderBy: {
            expiresAt: 'asc',
          },
        },
      },
      orderBy: {
        expiresAt: 'desc',
      },
    });

    /*
     * RENEWAL:
     * Subscription Paid đã hết hạn nhưng vẫn còn trong cửa sổ 24 giờ.
     */
    const renewalSubscription = !activeSubscription
      ? await this.prisma.subscription.findFirst({
          where: {
            userId,
            status: 'ACTIVE',
            startedAt: {
              lte: now,
            },
            expiresAt: {
              lte: now,
              gte: new Date(now.getTime() - 24 * 60 * 60 * 1000),
            },
            plan: {
              code: {
                not: 'FREE',
              },
            },
          },
          include: {
            plan: true,
            quotaLots: {
              where: {
                charactersRemaining: {
                  gt: 0,
                },
                rolloverCount: 0,
                expiresAt: {
                  lte: now,
                },
              },
              orderBy: {
                expiresAt: 'asc',
              },
            },
          },
          orderBy: {
            expiresAt: 'desc',
          },
        })
      : null;

    if (!activeSubscription && !renewalSubscription) {
      throw new BadRequestException(
        'Tài khoản chưa có gói sử dụng đang hoạt động hoặc không còn trong thời gian gia hạn 24 giờ.',
      );
    }

    /*
     * ============================================================
     * RENEWAL
     * ============================================================
     *
     * Paid subscription đã hết hạn nhưng vẫn trong cửa sổ 24 giờ.
     * Renewal là giao dịch riêng, không phải Upgrade.
     *
     * - Có thể renew cùng gói.
     * - Thanh toán đầy đủ giá gói mới.
     * - Không sử dụng upgradeOption.
     * - Quota cũ sẽ được rollover khi confirmPayment().
     */
    if (renewalSubscription) {
      if (upgradeOption) {
        throw new BadRequestException(
          'Giao dịch Renewal không sử dụng lựa chọn Upgrade.',
        );
      }

      const payment = await this.prisma.payment.create({
        data: {
          userId,
          planId: plan.id,
          amount: plan.price,
          currency: plan.currency,
          status: 'PENDING',
          provider: 'BANK_TRANSFER',
          paymentType: 'RENEWAL',
        },
        include: {
          plan: true,
        },
      });

      return {
        id: payment.id,
        plan: payment.plan.code,
        planName: payment.plan.name,
        amount: payment.amount,
        currency: payment.currency,
        status: payment.status,
        provider: payment.provider,
        paymentType: payment.paymentType,
        upgradeOption: payment.upgradeOption,
        creditAmount: payment.creditAmount,
        bankName: process.env.BANK_TRANSFER_BANK_NAME,
        accountNumber: process.env.BANK_TRANSFER_ACCOUNT_NUMBER,
        accountName: process.env.BANK_TRANSFER_ACCOUNT_NAME,
        createdAt: payment.createdAt,
      };
    }

    if (!activeSubscription) {
      throw new BadRequestException(
        'Tài khoản không có gói sử dụng đang hoạt động.',
      );
    }

    if (plan.id === activeSubscription.planId) {
      throw new BadRequestException('Bạn đang sử dụng gói này.');
    }

    /*
     * FREE → PAID
     *
     * Đây là đăng ký mới, không phải Upgrade.
     * Không sử dụng upgradeOption.
     */
    if (activeSubscription.plan.code === 'FREE') {
      if (upgradeOption) {
        throw new BadRequestException(
          'Gói Free không sử dụng lựa chọn Upgrade.',
        );
      }

      const payment = await this.prisma.payment.create({
        data: {
          userId,
          planId: plan.id,
          amount: plan.price,
          currency: plan.currency,
          status: 'PENDING',
          provider: 'BANK_TRANSFER',
          paymentType: 'NEW_PURCHASE',
        },
        include: {
          plan: true,
        },
      });

      return {
        id: payment.id,
        plan: payment.plan.code,
        planName: payment.plan.name,
        amount: payment.amount,
        currency: payment.currency,
        status: payment.status,
        provider: payment.provider,
        paymentType: payment.paymentType,
        upgradeOption: payment.upgradeOption,
        creditAmount: payment.creditAmount,
        bankName: process.env.BANK_TRANSFER_BANK_NAME,
        accountNumber: process.env.BANK_TRANSFER_ACCOUNT_NUMBER,
        accountName: process.env.BANK_TRANSFER_ACCOUNT_NAME,
        createdAt: payment.createdAt,
      };
    }

    /*
     * PAID → PAID
     *
     * Đây là Upgrade.
     * Người dùng bắt buộc phải chọn đúng một trong hai phương án:
     *
     * A. TRANSFER_QUOTA
     * B. CONVERT_TO_CREDIT
     */
    if (
      upgradeOption !== 'TRANSFER_QUOTA' &&
      upgradeOption !== 'CONVERT_TO_CREDIT'
    ) {
      throw new BadRequestException(
        'Khi nâng cấp giữa các gói trả phí, bạn phải chọn một trong hai phương án: chuyển quota hoặc quy đổi quota thành tiền.',
      );
    }

    /*
     * Upgrade chỉ được thực hiện khi giá gói mới cao hơn
     * giá gói hiện tại.
     */
    if (plan.price <= activeSubscription.plan.price) {
      throw new BadRequestException(
        'Chỉ có thể nâng cấp lên gói có giá cao hơn gói hiện tại.',
      );
    }

    /*
     * Tổng quota còn lại đủ điều kiện:
     * - thuộc subscription hiện tại
     * - còn ký tự
     * - chưa hết hạn
     */
    const remainingCharacters = activeSubscription.quotaLots.reduce(
      (total, lot) => total + lot.charactersRemaining,
      0,
    );

    let amount = plan.price;
    let creditAmount: number | null = null;

    /*
     * A. CHUYỂN TOÀN BỘ QUOTA
     *
     * Không giảm giá.
     * Người dùng thanh toán đầy đủ giá gói mới.
     */
    if (upgradeOption === 'TRANSFER_QUOTA') {
      amount = plan.price;
      creditAmount = null;
    }

    /*
     * B. QUY ĐỔI QUOTA THÀNH TIỀN
     *
     * Đơn giá ký tự:
     *   giá gói hiện tại / quota gốc của gói hiện tại
     *
     * Credit:
     *   quota còn lại × đơn giá ký tự
     *
     * Số tiền phải thanh toán:
     *   giá gói mới - credit
     */
    if (upgradeOption === 'CONVERT_TO_CREDIT') {
      if (activeSubscription.plan.characterLimit <= 0) {
        throw new BadRequestException(
          'Không xác định được quota gốc của gói hiện tại.',
        );
      }

      const pricePerCharacter =
        activeSubscription.plan.price / activeSubscription.plan.characterLimit;

      creditAmount = remainingCharacters * pricePerCharacter;

      amount = plan.price - creditAmount;

      /*
       * Bảo vệ dữ liệu tài chính khỏi sai số floating point.
       * Đơn vị tiền là VND nên làm tròn đến đồng.
       */
      creditAmount = Math.round(creditAmount);
      amount = Math.round(amount);

      if (amount < 0) {
        amount = 0;
      }
    }

    const payment = await this.prisma.payment.create({
      data: {
        userId,
        planId: plan.id,
        amount,
        currency: plan.currency,
        status: 'PENDING',
        provider: 'BANK_TRANSFER',
        paymentType: 'UPGRADE',
        upgradeOption,
        creditAmount,
      },
      include: {
        plan: true,
      },
    });

    return {
      id: payment.id,
      plan: payment.plan.code,
      planName: payment.plan.name,
      amount: payment.amount,
      currency: payment.currency,
      status: payment.status,
      provider: payment.provider,
      paymentType: payment.paymentType,
      upgradeOption: payment.upgradeOption,
      creditAmount: payment.creditAmount,
      remainingCharacters,
      bankName: process.env.BANK_TRANSFER_BANK_NAME,
      accountNumber: process.env.BANK_TRANSFER_ACCOUNT_NUMBER,
      accountName: process.env.BANK_TRANSFER_ACCOUNT_NAME,
      createdAt: payment.createdAt,
    };
  }
  async confirmPaymentByUser(userId: string, paymentId: string) {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
    });

    if (!payment) {
      throw new NotFoundException('Không tìm thấy giao dịch thanh toán.');
    }

    if (payment.userId !== userId) {
      throw new BadRequestException(
        'Bạn không có quyền xác nhận giao dịch này.',
      );
    }

    if (payment.status !== 'PENDING') {
      throw new BadRequestException(
        'Giao dịch không ở trạng thái chờ thanh toán.',
      );
    }

    return this.prisma.payment.update({
      where: { id: paymentId },
      data: {
        status: 'USER_CONFIRMED',
      },
    });
  }

  async cancelPayment(userId: string, paymentId: string) {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
    });

    if (!payment) {
      throw new NotFoundException('Không tìm thấy giao dịch thanh toán.');
    }

    if (payment.userId !== userId) {
      throw new BadRequestException('Bạn không có quyền hủy giao dịch này.');
    }

    if (payment.status !== 'PENDING') {
      throw new BadRequestException(
        'Chỉ có thể hủy giao dịch đang chờ thanh toán.',
      );
    }

    return this.prisma.payment.update({
      where: { id: paymentId },
      data: {
        status: 'CANCELLED',
      },
    });
  }
  async confirmPayment(paymentId: string) {
    return this.prisma.$transaction(async (tx) => {
      const now = new Date();

      const payment = await tx.payment.findUnique({
        where: {
          id: paymentId,
        },
        include: {
          plan: true,
        },
      });

      if (!payment) {
        throw new NotFoundException('Không tìm thấy giao dịch thanh toán.');
      }

      if (payment.status !== 'PENDING' && payment.status !== 'USER_CONFIRMED') {
        throw new BadRequestException(
          'Giao dịch không ở trạng thái chờ xác nhận.',
        );
      }

      const activeSubscription = await tx.subscription.findFirst({
        where: {
          userId: payment.userId,
          status: 'ACTIVE',
          startedAt: {
            lte: now,
          },
          expiresAt: {
            gt: now,
          },
        },
        include: {
          plan: true,
          quotaLots: {
            where: {
              charactersRemaining: {
                gt: 0,
              },
              expiresAt: {
                gt: now,
              },
            },
            orderBy: {
              expiresAt: 'asc',
            },
          },
        },
        orderBy: {
          expiresAt: 'desc',
        },
      });

      const renewalSubscription =
        payment.paymentType === 'RENEWAL' && !activeSubscription
          ? await tx.subscription.findFirst({
              where: {
                userId: payment.userId,
                status: 'ACTIVE',
                startedAt: {
                  lte: now,
                },
                expiresAt: {
                  lte: now,
                  gte: new Date(now.getTime() - 24 * 60 * 60 * 1000),
                },
                plan: {
                  code: {
                    not: 'FREE',
                  },
                },
              },
              include: {
                plan: true,
                quotaLots: {
                  where: {
                    charactersRemaining: {
                      gt: 0,
                    },
                    rolloverCount: 0,
                    expiresAt: {
                      lte: now,
                    },
                  },
                  orderBy: {
                    expiresAt: 'asc',
                  },
                },
              },
            })
          : null;

      const isFreeToPaid = activeSubscription?.plan.code === 'FREE';

      const isUpgrade = payment.paymentType === 'UPGRADE';
      const isRenewal = payment.paymentType === 'RENEWAL';

      if (isRenewal) {
        if (!renewalSubscription) {
          throw new BadRequestException(
            'Gói sử dụng không còn trong thời gian gia hạn 24 giờ.',
          );
        }
      } else if (!activeSubscription) {
        throw new BadRequestException(
          'Tài khoản không có gói sử dụng đang hoạt động.',
        );
      }

      /*
       * ============================================================
       * RENEWAL
       * ============================================================
       *
       * Paid subscription đã hết hạn nhưng vẫn trong cửa sổ 24 giờ.
       *
       * - Subscription cũ kết thúc.
       * - Tạo subscription mới.
       * - Tạo quota lot mới của plan.
       * - Rollover từng quota lot cũ đủ điều kiện.
       * - Mỗi source lot chỉ được rollover một lần.
       */
      if (isRenewal && renewalSubscription) {
        await tx.subscription.update({
          where: {
            id: renewalSubscription.id,
          },
          data: {
            status: 'EXPIRED',
          },
        });

        const newSubscription = await tx.subscription.create({
          data: {
            userId: payment.userId,
            planId: payment.planId,
            startedAt: now,
            expiresAt: new Date(
              now.getTime() + payment.plan.durationDays * 24 * 60 * 60 * 1000,
            ),
            status: 'ACTIVE',
            characterLimit: payment.plan.characterLimit,
            rolloverCharacters: 0,
            pricePaid: payment.amount,
            currency: payment.currency,
          },
          include: {
            plan: true,
          },
        });

        await tx.quotaLot.create({
          data: {
            subscriptionId: newSubscription.id,
            sourceLotId: null,
            charactersGranted: payment.plan.characterLimit,
            charactersRemaining: payment.plan.characterLimit,
            rolloverCount: 0,
            expiresAt: newSubscription.expiresAt,
          },
        });

        for (const lot of renewalSubscription.quotaLots) {
          if (lot.charactersRemaining <= 0 || lot.rolloverCount > 0) {
            continue;
          }

          await tx.quotaLot.create({
            data: {
              subscriptionId: newSubscription.id,
              sourceLotId: lot.id,
              charactersGranted: lot.charactersRemaining,
              charactersRemaining: lot.charactersRemaining,
              rolloverCount: 0,
              expiresAt: newSubscription.expiresAt,
            },
          });

          await tx.quotaLot.update({
            where: {
              id: lot.id,
            },
            data: {
              rolloverCount: lot.rolloverCount + 1,
            },
          });
        }

        const updatedPayment = await tx.payment.update({
          where: {
            id: payment.id,
          },
          data: {
            status: 'PAID',
            paidAt: now,
          },
          include: {
            plan: true,
          },
        });

        return {
          id: updatedPayment.id,
          plan: updatedPayment.plan.code,
          planName: updatedPayment.plan.name,
          amount: updatedPayment.amount,
          currency: updatedPayment.currency,
          status: updatedPayment.status,
          provider: updatedPayment.provider,
          paymentType: updatedPayment.paymentType,
          upgradeOption: updatedPayment.upgradeOption,
          creditAmount: updatedPayment.creditAmount,
          paidAt: updatedPayment.paidAt,
          subscription: {
            id: newSubscription.id,
            plan: newSubscription.plan.code,
            planName: newSubscription.plan.name,
            status: newSubscription.status,
            startedAt: newSubscription.startedAt,
            expiresAt: newSubscription.expiresAt,
            characterLimit: newSubscription.characterLimit,
            rolloverCharacters: newSubscription.rolloverCharacters,
          },
        };
      }
      if (!activeSubscription) {
        throw new BadRequestException(
          'Tài khoản không có gói sử dụng đang hoạt động.',
        );
      }
      /*
       * ============================================================
       * FREE → PAID
       * ============================================================
       *
       * Đây là đăng ký mới.
       * Không chuyển quota Free sang Paid.
       */
      if (isFreeToPaid) {
        if (isUpgrade) {
          throw new BadRequestException(
            'Giao dịch Upgrade không hợp lệ với tài khoản Free.',
          );
        }

        await tx.subscription.update({
          where: {
            id: activeSubscription.id,
          },
          data: {
            status: 'EXPIRED',
          },
        });

        const newSubscription = await tx.subscription.create({
          data: {
            userId: payment.userId,
            planId: payment.planId,
            startedAt: now,
            expiresAt: new Date(
              now.getTime() + payment.plan.durationDays * 24 * 60 * 60 * 1000,
            ),
            status: 'ACTIVE',
            characterLimit: payment.plan.characterLimit,
            rolloverCharacters: 0,
            pricePaid: payment.amount,
            currency: payment.currency,
          },
          include: {
            plan: true,
          },
        });

        await tx.quotaLot.create({
          data: {
            subscriptionId: newSubscription.id,
            charactersGranted: payment.plan.characterLimit,
            charactersRemaining: payment.plan.characterLimit,
            rolloverCount: 0,
            expiresAt: newSubscription.expiresAt,
          },
        });

        const updatedPayment = await tx.payment.update({
          where: {
            id: payment.id,
          },
          data: {
            status: 'PAID',
            paidAt: now,
          },
        });

        return {
          payment: {
            id: updatedPayment.id,
            status: updatedPayment.status,
            paidAt: updatedPayment.paidAt,
            amount: updatedPayment.amount,
            currency: updatedPayment.currency,
            paymentType: updatedPayment.paymentType,
          },
          subscription: {
            id: newSubscription.id,
            plan: newSubscription.plan.code,
            planName: newSubscription.plan.name,
            characterLimit: newSubscription.characterLimit,
            rolloverCharacters: newSubscription.rolloverCharacters,
            startedAt: newSubscription.startedAt,
            expiresAt: newSubscription.expiresAt,
          },
          previousRemaining: 0,
        };
      }

      /*
       * ============================================================
       * PAID → PAID
       * ============================================================
       *
       * Đây là Upgrade.
       */
      if (!isUpgrade) {
        throw new BadRequestException(
          'Tài khoản trả phí phải sử dụng giao dịch Upgrade.',
        );
      }

      if (
        payment.upgradeOption !== 'TRANSFER_QUOTA' &&
        payment.upgradeOption !== 'CONVERT_TO_CREDIT'
      ) {
        throw new BadRequestException(
          'Giao dịch Upgrade không có lựa chọn quota hợp lệ.',
        );
      }

      if (payment.plan.price <= activeSubscription.plan.price) {
        throw new BadRequestException(
          'Chỉ có thể nâng cấp lên gói có giá cao hơn gói hiện tại.',
        );
      }

      /*
       * Tổng quota còn lại đủ điều kiện tại thời điểm Admin xác nhận.
       */
      const remainingCharacters = activeSubscription.quotaLots.reduce(
        (total, lot) => total + lot.charactersRemaining,
        0,
      );

      /*
       * Với CONVERT_TO_CREDIT:
       *
       * Payment đã được tạo trước đó với một mức credit cụ thể.
       * Nếu người dùng đã sử dụng quota sau khi tạo Payment,
       * số credit hiện tại sẽ thay đổi.
       *
       * Không tự ý thay đổi số tiền giao dịch đã được tạo.
       * Vì vậy yêu cầu tạo lại Payment nếu quota đã thay đổi.
       */
      if (payment.upgradeOption === 'CONVERT_TO_CREDIT') {
        if (activeSubscription.plan.characterLimit <= 0) {
          throw new BadRequestException(
            'Không xác định được quota gốc của gói hiện tại.',
          );
        }

        const pricePerCharacter =
          activeSubscription.plan.price /
          activeSubscription.plan.characterLimit;

        const currentCreditAmount = Math.round(
          remainingCharacters * pricePerCharacter,
        );

        const paymentCreditAmount = Math.round(payment.creditAmount ?? -1);

        if (currentCreditAmount !== paymentCreditAmount) {
          throw new BadRequestException(
            'Quota đã thay đổi kể từ khi tạo giao dịch Upgrade. Vui lòng tạo lại giao dịch để cập nhật số tiền thanh toán.',
          );
        }
      }

      /*
       * ============================================================
       * Kết thúc subscription cũ
       * ============================================================
       */
      await tx.subscription.update({
        where: {
          id: activeSubscription.id,
        },
        data: {
          status: 'EXPIRED',
        },
      });

      /*
       * ============================================================
       * Tạo subscription mới
       * ============================================================
       *
       * A:
       *   rolloverCharacters = toàn bộ quota còn lại
       *
       * B:
       *   rolloverCharacters = 0
       *   quota cũ đã được quy đổi thành credit
       */
      const transferredQuota =
        payment.upgradeOption === 'TRANSFER_QUOTA' ? remainingCharacters : 0;

      const newSubscription = await tx.subscription.create({
        data: {
          userId: payment.userId,
          planId: payment.planId,
          startedAt: now,
          expiresAt: new Date(
            now.getTime() + payment.plan.durationDays * 24 * 60 * 60 * 1000,
          ),
          status: 'ACTIVE',
          characterLimit: payment.plan.characterLimit,
          rolloverCharacters: transferredQuota,
          pricePaid: payment.amount,
          currency: payment.currency,
        },
        include: {
          plan: true,
        },
      });

      /*
       * ============================================================
       * QuotaLot gốc của gói mới
       * ============================================================
       */
      await tx.quotaLot.create({
        data: {
          subscriptionId: newSubscription.id,
          charactersGranted: payment.plan.characterLimit,
          charactersRemaining: payment.plan.characterLimit,
          rolloverCount: 0,
          expiresAt: newSubscription.expiresAt,
        },
      });

      /*
       * ============================================================
       * A — TRANSFER_QUOTA
       *
       * Tạo thêm một QuotaLot chứa toàn bộ quota còn lại
       * của subscription cũ.
       *
       * Transfer toàn bộ quota còn lại theo từng QuotaLot,
       * giữ sourceLotId để đảm bảo mỗi lot nguồn chỉ được chuyển đúng một lần.
       * ============================================================
       */
      if (
        payment.upgradeOption === 'TRANSFER_QUOTA' &&
        remainingCharacters > 0
      ) {
        for (const lot of activeSubscription.quotaLots) {
          if (lot.charactersRemaining <= 0) {
            continue;
          }

          await tx.quotaLot.create({
            data: {
              subscriptionId: newSubscription.id,
              sourceLotId: lot.id,
              charactersGranted: lot.charactersRemaining,
              charactersRemaining: lot.charactersRemaining,
              rolloverCount: 0,
              expiresAt: newSubscription.expiresAt,
            },
          });

          await tx.quotaLot.update({
            where: {
              id: lot.id,
            },
            data: {
              rolloverCount: lot.rolloverCount + 1,
            },
          });
        }
      }

      /*
       * ============================================================
       * Đánh dấu Payment đã thanh toán
       * ============================================================
       */
      const updatedPayment = await tx.payment.update({
        where: {
          id: payment.id,
        },
        data: {
          status: 'PAID',
          paidAt: now,
        },
      });

      return {
        payment: {
          id: updatedPayment.id,
          status: updatedPayment.status,
          paidAt: updatedPayment.paidAt,
          amount: updatedPayment.amount,
          currency: updatedPayment.currency,
          paymentType: updatedPayment.paymentType,
          upgradeOption: updatedPayment.upgradeOption,
          creditAmount: updatedPayment.creditAmount,
        },
        subscription: {
          id: newSubscription.id,
          plan: newSubscription.plan.code,
          planName: newSubscription.plan.name,
          characterLimit: newSubscription.characterLimit,
          rolloverCharacters: newSubscription.rolloverCharacters,
          startedAt: newSubscription.startedAt,
          expiresAt: newSubscription.expiresAt,
        },
        previousRemaining: remainingCharacters,
      };
    });
  }
}
