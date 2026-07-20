-- AlterTable
ALTER TABLE "reservations" ADD COLUMN     "idempotencyKey" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "reservations_userId_idempotencyKey_key" ON "reservations"("userId", "idempotencyKey");

