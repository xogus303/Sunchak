-- AlterTable
ALTER TABLE "events" ADD COLUMN     "loadTestOwnerId" INTEGER;

-- CreateIndex
CREATE UNIQUE INDEX "events_loadTestOwnerId_key" ON "events"("loadTestOwnerId");

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_loadTestOwnerId_fkey" FOREIGN KEY ("loadTestOwnerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
