-- AlterTable
ALTER TABLE "Competition" ADD COLUMN     "current" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "Competition_current_idx" ON "Competition"("current");
