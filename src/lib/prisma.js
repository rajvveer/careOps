const { PrismaClient } = require('@prisma/client');

// Singleton Prisma client — reuse one connection pool across the entire app
const prisma = new PrismaClient({
    datasources: {
        db: {
            url: process.env.DATABASE_URL,
        },
    },
    log:
        process.env.NODE_ENV === 'development'
            ? [
                { emit: 'event', level: 'query' },
                { emit: 'stdout', level: 'warn' },
                { emit: 'stdout', level: 'error' },
            ]
            : ['error'],
});

// Log slow queries (> 500ms) in development
if (process.env.NODE_ENV === 'development') {
    prisma.$on('query', (e) => {
        if (e.duration > 500) {
            console.warn(`⚠️ Slow query (${e.duration}ms): ${e.query}`);
        }
    });
}

module.exports = prisma;
