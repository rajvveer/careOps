const { PrismaClient } = require('@prisma/client');
require('dotenv').config();
const prisma = new PrismaClient();

async function run() {
    try {
        await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "CalendarConnection" (
        "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
        "workspaceId" TEXT NOT NULL,
        "provider" TEXT NOT NULL DEFAULT 'google',
        "accessToken" TEXT,
        "refreshToken" TEXT,
        "calendarId" TEXT,
        "expiresAt" TIMESTAMP(3),
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "CalendarConnection_pkey" PRIMARY KEY ("id")
      )
    `);
        console.log('✅ Table created');

        await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "CalendarConnection_workspaceId_idx" ON "CalendarConnection"("workspaceId")`);
        console.log('✅ Index created');

        await prisma.$executeRawUnsafe(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CalendarConnection_workspaceId_fkey') THEN
          ALTER TABLE "CalendarConnection" ADD CONSTRAINT "CalendarConnection_workspaceId_fkey"
          FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
        END IF;
      END $$
    `);
        console.log('✅ FK constraint added');
        console.log('🎉 CalendarConnection table ready!');
    } catch (e) {
        console.error('Error:', e.message);
    }
    await prisma.$disconnect();
}
run();
