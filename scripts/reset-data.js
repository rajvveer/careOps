// Reset ALL data using raw SQL TRUNCATE CASCADE (bypasses FK constraints)
const { PrismaClient } = require('@prisma/client');
require('dotenv').config();

const prisma = new PrismaClient();

async function resetData() {
    console.log('🗑️  Resetting all database data via TRUNCATE CASCADE...\n');

    const tables = [
        'CalendarConnection', 'Alert', 'AutomationLog',
        'FormSubmission', 'FormTemplate',
        'Booking', 'AvailabilitySlot', 'ServiceType',
        'Message', 'Conversation',
        'InventoryItem', 'Contact',
        'StaffPermission', 'StaffInvitation',
        'Integration',
        'User', 'Workspace'
    ];

    for (const table of tables) {
        try {
            await prisma.$executeRawUnsafe(`TRUNCATE TABLE "${table}" CASCADE`);
            console.log(`  ✅ ${table} truncated`);
        } catch (err) {
            console.log(`  ⚠️  ${table}: ${err.message.split('\n')[0]}`);
        }
    }

    console.log('\n🎉 All data wiped! Register a new account to start fresh.');
    await prisma.$disconnect();
}

resetData().catch(e => { console.error(e); process.exit(1); });
