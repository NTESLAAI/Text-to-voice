/*
  Warnings:

  - A unique constraint covering the columns `[sourceLotId]` on the table `QuotaLot` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "QuotaLot" ADD COLUMN     "sourceLotId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "QuotaLot_sourceLotId_key" ON "QuotaLot"("sourceLotId");

-- AddForeignKey
ALTER TABLE "QuotaLot" ADD CONSTRAINT "QuotaLot_sourceLotId_fkey" FOREIGN KEY ("sourceLotId") REFERENCES "QuotaLot"("id") ON DELETE SET NULL ON UPDATE CASCADE;
