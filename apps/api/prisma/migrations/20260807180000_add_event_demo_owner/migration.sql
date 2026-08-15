-- AlterTable
ALTER TABLE "events" ADD COLUMN     "demoOwnerId" INTEGER;

-- CreateIndex
CREATE UNIQUE INDEX "events_demoOwnerId_key" ON "events"("demoOwnerId");

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_demoOwnerId_fkey" FOREIGN KEY ("demoOwnerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
