-- DropForeignKey
ALTER TABLE "EnrolledRosterEntry" DROP CONSTRAINT "EnrolledRosterEntry_syncRunId_fkey";

-- AlterTable
ALTER TABLE "EnrolledRosterEntry" ALTER COLUMN "syncRunId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "confirmedAt" TIMESTAMP(3),
ADD COLUMN     "dismissedAt" TIMESTAMP(3);

-- AddForeignKey
ALTER TABLE "EnrolledRosterEntry" ADD CONSTRAINT "EnrolledRosterEntry_syncRunId_fkey" FOREIGN KEY ("syncRunId") REFERENCES "SheetSyncRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
