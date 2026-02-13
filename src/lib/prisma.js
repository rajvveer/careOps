const { PrismaClient } = require('@prisma/client');

// Singleton Prisma client — reuse one connection pool across the entire app
const prisma = new PrismaClient({
    datasources: {
        db: {
            url: process.env.DATABASE_URL,
        },
    },
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
});

module.exports = prisma;
