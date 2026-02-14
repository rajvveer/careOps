const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const auth = require('../middleware/auth');

// ─── In-Memory Response Cache ────────────────────────────
const cache = new Map();

function getCached(key, ttlMs) {
    const entry = cache.get(key);
    if (entry && Date.now() - entry.ts < ttlMs) return entry.data;
    return null;
}

function setCache(key, data) {
    cache.set(key, { data, ts: Date.now() });
}

// Invalidate all caches for a workspace (called from other routes on mutations)
function invalidateWorkspaceCache(workspaceId) {
    cache.delete(`dash:${workspaceId}`);
    cache.delete(`analytics:${workspaceId}`);
}

// GET /api/dashboard — OPTIMIZED: 4 bulk queries + in-memory counting
router.get('/', auth, async (req, res, next) => {
    try {
        const workspaceId = req.workspaceId;
        const cacheKey = `dash:${workspaceId}`;
        const cached = getCached(cacheKey, 10_000); // 10s TTL — fast refresh
        if (cached) return res.json(cached);

        const now = new Date();
        const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0);
        const todayEnd = new Date(now); todayEnd.setHours(23, 59, 59, 999);
        const weekFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

        // 4 bulk queries instead of 14 individual ones
        const [allBookings, allConversations, allFormSubmissions, allInventory, alerts, unreadAlerts] = await Promise.all([
            // 1. Bookings from last 30 days (covers today + upcoming + historical counts)
            prisma.booking.findMany({
                where: { workspaceId, dateTime: { gte: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000) } },
                include: { contact: true, serviceType: true },
                orderBy: { dateTime: 'asc' }
            }),
            // 2. Open conversations with last message
            prisma.conversation.findMany({
                where: { workspaceId, status: 'open' },
                include: { messages: { orderBy: { createdAt: 'desc' }, take: 1 } }
            }),
            // 3. All form submissions for this workspace
            prisma.formSubmission.findMany({
                where: { formTemplate: { workspaceId } },
                select: { status: true }
            }),
            // 4. All inventory items
            prisma.inventoryItem.findMany({ where: { workspaceId } }),
            // Alerts (already efficient — small take)
            prisma.alert.findMany({ where: { workspaceId }, orderBy: { createdAt: 'desc' }, take: 10 }),
            prisma.alert.count({ where: { workspaceId, isRead: false } })
        ]);

        // In-memory counting — replaces 10+ database count queries
        const todayBookings = allBookings.filter(b => {
            const dt = new Date(b.dateTime);
            return dt >= todayStart && dt <= todayEnd;
        });
        const upcomingBookings = allBookings.filter(b => {
            const dt = new Date(b.dateTime);
            return dt > todayEnd && dt <= weekFromNow && b.status === 'CONFIRMED';
        }).length;
        const completedBookings = allBookings.filter(b => b.status === 'COMPLETED').length;
        const noShowBookings = allBookings.filter(b => b.status === 'NO_SHOW').length;

        const newInquiriesCount = allConversations.length; // open convos are the best proxy
        const unansweredMessages = allConversations.filter(c =>
            c.messages.length > 0 && c.messages[0].direction === 'INBOUND'
        ).length;

        const pendingForms = allFormSubmissions.filter(f => f.status === 'PENDING').length;
        const overdueForms = allFormSubmissions.filter(f => f.status === 'OVERDUE').length;
        const completedForms = allFormSubmissions.filter(f => f.status === 'COMPLETED').length;

        const lowStockItems = allInventory.filter(item => item.quantity <= item.threshold);
        const criticalItems = allInventory.filter(item => item.quantity === 0);

        // New inquiries — contacts created today (use a lightweight count)
        const newInquiries = await prisma.contact.count({ where: { workspaceId, createdAt: { gte: todayStart } } });

        const result = {
            bookings: {
                today: todayBookings.length,
                upcoming: upcomingBookings,
                completed: completedBookings,
                noShow: noShowBookings,
                todayList: todayBookings
            },
            leads: { newInquiries, openConversations: allConversations.length, unansweredMessages },
            forms: { pending: pendingForms, overdue: overdueForms, completed: completedForms },
            inventory: {
                lowStockItems: lowStockItems.map(i => ({ id: i.id, name: i.name, quantity: i.quantity, threshold: i.threshold, unit: i.unit })),
                criticalCount: criticalItems.length, lowStockCount: lowStockItems.length
            },
            alerts: { recent: alerts, unreadCount: unreadAlerts }
        };

        setCache(cacheKey, result);
        res.json(result);
    } catch (error) {
        next(error);
    }
});

// PATCH /api/dashboard/alerts/:id/read
router.patch('/alerts/:id/read', auth, async (req, res, next) => {
    try {
        const alert = await prisma.alert.update({ where: { id: req.params.id }, data: { isRead: true } });
        // Invalidate dashboard cache for this workspace
        invalidateWorkspaceCache(req.workspaceId);
        res.json(alert);
    } catch (error) { next(error); }
});

// PATCH /api/dashboard/alerts/read-all
router.patch('/alerts/read-all', auth, async (req, res, next) => {
    try {
        await prisma.alert.updateMany({ where: { workspaceId: req.workspaceId, isRead: false }, data: { isRead: true } });
        invalidateWorkspaceCache(req.workspaceId);
        res.json({ message: 'All alerts marked as read' });
    } catch (error) { next(error); }
});

// GET /api/dashboard/analytics — Historical data for charts (5-min cache)
router.get('/analytics', auth, async (req, res, next) => {
    try {
        const workspaceId = req.workspaceId;
        const cacheKey = `analytics:${workspaceId}`;
        const cached = getCached(cacheKey, 30_000); // 30s TTL
        if (cached) return res.json(cached);

        const now = new Date();
        const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

        const [allBookings, allContacts, serviceTypes, formCount, inventory, conversations] = await Promise.all([
            prisma.booking.findMany({
                where: { workspaceId, dateTime: { gte: thirtyDaysAgo } },
                select: { dateTime: true, status: true, serviceTypeId: true },
                orderBy: { dateTime: 'asc' }
            }),
            prisma.contact.count({
                where: { workspaceId, createdAt: { gte: thirtyDaysAgo } }
            }),
            prisma.serviceType.findMany({
                where: { workspaceId },
                select: { id: true, name: true, price: true, _count: { select: { bookings: true } } }
            }),
            prisma.formSubmission.count({
                where: { formTemplate: { workspaceId }, createdAt: { gte: thirtyDaysAgo } }
            }),
            prisma.inventoryItem.findMany({ where: { workspaceId } }),
            prisma.conversation.count({ where: { workspaceId, createdAt: { gte: thirtyDaysAgo } } })
        ]);

        // Build a price lookup from serviceTypes
        const priceMap = {};
        serviceTypes.forEach(st => { priceMap[st.id] = Number(st.price || 0); });

        // Bookings by day (last 30 days)
        const bookingsByDay = {};
        const revByDay = {};
        for (let i = 29; i >= 0; i--) {
            const d = new Date(now.getTime() - i * 86400000);
            const key = d.toISOString().slice(0, 10);
            bookingsByDay[key] = 0;
            revByDay[key] = 0;
        }
        allBookings.forEach(b => {
            const key = new Date(b.dateTime).toISOString().slice(0, 10);
            if (bookingsByDay[key] !== undefined) bookingsByDay[key]++;
            if (revByDay[key] !== undefined) revByDay[key] += priceMap[b.serviceTypeId] || 0;
        });

        // Bookings by day-of-week
        const dayOfWeek = [0, 0, 0, 0, 0, 0, 0];
        allBookings.forEach(b => { dayOfWeek[new Date(b.dateTime).getDay()]++; });

        // Status breakdown
        const statusCounts = { CONFIRMED: 0, COMPLETED: 0, CANCELLED: 0, NO_SHOW: 0 };
        allBookings.forEach(b => { if (statusCounts[b.status] !== undefined) statusCounts[b.status]++; });

        // Top services
        const topServices = serviceTypes
            .map(st => ({ name: st.name, bookings: st._count.bookings, revenue: st._count.bookings * Number(st.price || 0) }))
            .sort((a, b) => b.bookings - a.bookings)
            .slice(0, 5);

        // This week vs last week
        const thisWeekBookings = allBookings.filter(b => new Date(b.dateTime) >= sevenDaysAgo).length;
        const lastWeekStart = new Date(now.getTime() - 14 * 86400000);
        const lastWeekBookings = allBookings.filter(b => {
            const d = new Date(b.dateTime);
            return d >= lastWeekStart && d < sevenDaysAgo;
        }).length;
        const growthPct = lastWeekBookings > 0 ? Math.round(((thisWeekBookings - lastWeekBookings) / lastWeekBookings) * 100) : thisWeekBookings > 0 ? 100 : 0;

        const totalRevenue = allBookings.reduce((s, b) => s + (priceMap[b.serviceTypeId] || 0), 0);
        const thisWeekRevenue = allBookings.filter(b => new Date(b.dateTime) >= sevenDaysAgo)
            .reduce((s, b) => s + (priceMap[b.serviceTypeId] || 0), 0);

        const result = {
            bookingsByDay: Object.entries(bookingsByDay).map(([date, count]) => ({ date, count })),
            revenueByDay: Object.entries(revByDay).map(([date, revenue]) => ({ date, revenue })),
            dayOfWeek: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d, i) => ({ day: d, count: dayOfWeek[i] })),
            statusBreakdown: Object.entries(statusCounts).map(([status, count]) => ({ status, count })),
            topServices,
            summary: {
                totalBookings: allBookings.length,
                totalRevenue,
                thisWeekBookings,
                thisWeekRevenue,
                growthPct,
                newContacts: allContacts,
                newConversations: conversations,
                totalForms: formCount,
                inventoryItems: inventory.length,
                lowStock: inventory.filter(i => i.quantity <= i.threshold).length
            }
        };

        setCache(cacheKey, result);
        res.json(result);
    } catch (error) { next(error); }
});

// GET /api/dashboard/weekly-report — OPTIMIZED: 4 queries instead of 9
router.get('/weekly-report', auth, async (req, res, next) => {
    try {
        const workspaceId = req.workspaceId;
        const now = new Date();
        const sevenDaysAgo = new Date(now.getTime() - 7 * 86400000);
        const fourteenDaysAgo = new Date(now.getTime() - 14 * 86400000);

        // 4 queries instead of 9
        const [allRecentBookings, allRecentContacts, openConvAndForms, allInventory, workspace] = await Promise.all([
            // 1. All bookings in last 14 days (split in-memory)
            prisma.booking.findMany({
                where: { workspaceId, dateTime: { gte: fourteenDaysAgo } },
                include: { serviceType: true }
            }),
            // 2. All contacts in last 14 days (split in-memory)
            prisma.contact.findMany({
                where: { workspaceId, createdAt: { gte: fourteenDaysAgo } },
                select: { id: true, createdAt: true }
            }),
            // 3. Open conversations + form counts in parallel
            Promise.all([
                prisma.conversation.count({ where: { workspaceId, status: 'open' } }),
                prisma.formSubmission.count({ where: { formTemplate: { workspaceId }, status: 'PENDING' } }),
                prisma.formSubmission.count({ where: { formTemplate: { workspaceId }, status: 'OVERDUE' } })
            ]),
            // 4. Inventory
            prisma.inventoryItem.findMany({ where: { workspaceId } }),
            prisma.workspace.findUnique({ where: { id: workspaceId }, select: { name: true } })
        ]);

        const [openConversations, pendingForms, overdueForms] = openConvAndForms;

        // Split bookings in-memory
        const thisWeekBookings = allRecentBookings.filter(b => new Date(b.dateTime) >= sevenDaysAgo);
        const lastWeekBookingsCount = allRecentBookings.filter(b => {
            const d = new Date(b.dateTime);
            return d >= fourteenDaysAgo && d < sevenDaysAgo;
        }).length;

        // Split contacts in-memory
        const thisWeekContacts = allRecentContacts.filter(c => new Date(c.createdAt) >= sevenDaysAgo).length;
        const lastWeekContacts = allRecentContacts.filter(c => {
            const d = new Date(c.createdAt);
            return d >= fourteenDaysAgo && d < sevenDaysAgo;
        }).length;

        const thisWeekRevenue = thisWeekBookings.reduce((s, b) => s + Number(b.serviceType?.price || 0), 0);
        const noShows = thisWeekBookings.filter(b => b.status === 'NO_SHOW').length;
        const completed = thisWeekBookings.filter(b => b.status === 'COMPLETED').length;
        const bookingGrowth = lastWeekBookingsCount > 0 ? Math.round(((thisWeekBookings.length - lastWeekBookingsCount) / lastWeekBookingsCount) * 100) : thisWeekBookings.length > 0 ? 100 : 0;
        const contactGrowth = lastWeekContacts > 0 ? Math.round(((thisWeekContacts - lastWeekContacts) / lastWeekContacts) * 100) : thisWeekContacts > 0 ? 100 : 0;
        const lowStockCount = allInventory.filter(i => i.quantity <= i.threshold).length;

        // Try AI-generated summary
        let aiSummary = '';
        try {
            const Groq = require('groq-sdk');
            if (process.env.GROQ_API_KEY) {
                const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
                const prompt = `You are Cara, a warm and emotionally expressive business analytics AI. Generate a concise weekly report for "${workspace?.name || 'this business'}".\r\n\r\nStats this week:\r\n- ${thisWeekBookings.length} bookings (${bookingGrowth > 0 ? '+' : ''}${bookingGrowth}% vs last week)\r\n- $${thisWeekRevenue} revenue\r\n- ${completed} completed, ${noShows} no-shows\r\n- ${thisWeekContacts} new contacts (${contactGrowth > 0 ? '+' : ''}${contactGrowth}% vs last week)\r\n- ${openConversations} open conversations\r\n- ${pendingForms} pending forms, ${overdueForms} overdue\r\n- Low stock items: ${lowStockCount}\r\n\r\nRules:\r\n- 3-4 short sentences max\r\n- Show genuine emotion — celebrate wins enthusiastically, express real concern about problems\r\n- Use warm, conversational language (\"honestly\", \"love to see\", \"heads up\")\r\n- Be specific with numbers, weave them into natural sentences\r\n- Sound like a caring friend who's also brilliant with data\r\n- Use 1-2 emojis naturally (🎉 📈 ⚡ 💪) but don't overdo it\r\n- No markdown formatting`;

                const completion = await groq.chat.completions.create({
                    messages: [{ role: 'user', content: prompt }],
                    model: 'llama-3.3-70b-versatile',
                    temperature: 0.7,
                    max_tokens: 200,
                });
                aiSummary = completion.choices[0]?.message?.content || '';
            }
        } catch { /* fallback below */ }

        res.json({
            period: { start: sevenDaysAgo.toISOString(), end: now.toISOString() },
            bookings: thisWeekBookings.length,
            bookingGrowth,
            revenue: thisWeekRevenue,
            completed,
            noShows,
            newContacts: thisWeekContacts,
            contactGrowth,
            openConversations,
            pendingForms,
            overdueForms,
            lowStockItems: lowStockCount,
            aiSummary,
        });
    } catch (error) { next(error); }
});

// GET /api/dashboard/export/:type — CSV export with pagination
router.get('/export/:type', auth, async (req, res, next) => {
    try {
        const workspaceId = req.workspaceId;
        const type = req.params.type;
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(5000, Math.max(1, parseInt(req.query.limit) || 1000));
        const skip = (page - 1) * limit;

        if (type === 'bookings') {
            const bookings = await prisma.booking.findMany({
                where: { workspaceId },
                include: { contact: true, serviceType: true },
                orderBy: { dateTime: 'desc' },
                skip,
                take: limit
            });
            const csv = [
                'Date,Time,Client,Email,Service,Duration,Price,Status',
                ...bookings.map(b => {
                    const dt = new Date(b.dateTime);
                    return `${dt.toLocaleDateString()},${dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })},${b.contact?.name || ''},${b.contact?.email || ''},${b.serviceType?.name || ''},${b.serviceType?.duration || ''}min,$${b.serviceType?.price || 0},${b.status}`;
                })
            ].join('\n');
            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', 'attachment; filename=bookings.csv');
            return res.send(csv);
        }

        if (type === 'contacts') {
            const contacts = await prisma.contact.findMany({
                where: { workspaceId },
                orderBy: { createdAt: 'desc' },
                skip,
                take: limit
            });
            const csv = [
                'Name,Email,Phone,Source,Created',
                ...contacts.map(c => `${c.name},${c.email || ''},${c.phone || ''},${c.source || ''},${new Date(c.createdAt).toLocaleDateString()}`)
            ].join('\n');
            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', 'attachment; filename=contacts.csv');
            return res.send(csv);
        }

        if (type === 'inventory') {
            const items = await prisma.inventoryItem.findMany({
                where: { workspaceId },
                orderBy: { name: 'asc' },
                skip,
                take: limit
            });
            const csv = [
                'Item,Quantity,Unit,Threshold,Status',
                ...items.map(i => `${i.name},${i.quantity},${i.unit},${i.threshold},${i.quantity <= i.threshold ? 'LOW STOCK' : 'OK'}`)
            ].join('\n');
            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', 'attachment; filename=inventory.csv');
            return res.send(csv);
        }

        res.status(400).json({ error: 'Invalid export type. Use: bookings, contacts, inventory' });
    } catch (error) { next(error); }
});

// GET /api/dashboard/activity — Activity log / audit trail
router.get('/activity', auth, async (req, res, next) => {
    try {
        const workspaceId = req.workspaceId;
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
        const skip = (page - 1) * limit;

        const [logs, total] = await Promise.all([
            prisma.automationLog.findMany({
                where: { workspaceId },
                orderBy: { createdAt: 'desc' },
                skip,
                take: limit
            }),
            prisma.automationLog.count({ where: { workspaceId } })
        ]);

        res.json({
            logs,
            pagination: { page, limit, total, pages: Math.ceil(total / limit) }
        });
    } catch (error) { next(error); }
});

module.exports = { router, invalidateWorkspaceCache };

