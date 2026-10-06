/*
  Warnings:

  - A unique constraint covering the columns `[transferCode]` on the table `Payment` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "transferCode" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Payment_transferCode_key" ON "Payment"("transferCode");
