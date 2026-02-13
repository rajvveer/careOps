const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const auth = require('../middleware/auth');

// GET /api/dashboard — OPTIMIZED: all queries run in parallel
router.get('/', auth, async (req, res, next) => {
    try {
        const workspaceId = req.workspaceId;
        const now = new Date();
        const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0);
        const todayEnd = new Date(now); todayEnd.setHours(23, 59, 59, 999);
        const weekFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

        // Run ALL queries in parallel
        const [
            todayBookings, upcomingBookings, completedBookings, noShowBookings,
            newInquiries, openConversations, allConversations,
            pendingForms, overdueForms, completedForms,
            allInventory, alerts, unreadAlerts, todayBookingsList
        ] = await Promise.all([
            prisma.booking.count({ where: { workspaceId, dateTime: { gte: todayStart, lte: todayEnd } } }),
            prisma.booking.count({ where: { workspaceId, dateTime: { gt: todayEnd, lte: weekFromNow }, status: 'CONFIRMED' } }),
            prisma.booking.count({ where: { workspaceId, status: 'COMPLETED' } }),
            prisma.booking.count({ where: { workspaceId, status: 'NO_SHOW' } }),
            prisma.contact.count({ where: { workspaceId, createdAt: { gte: todayStart } } }),
            prisma.conversation.count({ where: { workspaceId, status: 'open' } }),
            prisma.conversation.findMany({
                where: { workspaceId, status: 'open' },
                include: { messages: { orderBy: { createdAt: 'desc' }, take: 1 } }
            }),
            prisma.formSubmission.count({ where: { formTemplate: { workspaceId }, status: 'PENDING' } }),
            prisma.formSubmission.count({ where: { formTemplate: { workspaceId }, status: 'OVERDUE' } }),
            prisma.formSubmission.count({ where: { formTemplate: { workspaceId }, status: 'COMPLETED' } }),
            prisma.inventoryItem.findMany({ where: { workspaceId } }),
            prisma.alert.findMany({ where: { workspaceId }, orderBy: { createdAt: 'desc' }, take: 10 }),
            prisma.alert.count({ where: { workspaceId, isRead: false } }),
            prisma.booking.findMany({
                where: { workspaceId, dateTime: { gte: todayStart, lte: todayEnd } },
                include: { contact: true, serviceType: true },
                orderBy: { dateTime: 'asc' }
            })
        ]);

        const unansweredMessages = allConversations.filter(c =>
            c.messages.length > 0 && c.messages[0].direction === 'INBOUND'
        ).length;
        const lowStockItems = allInventory.filter(item => item.quantity <= item.threshold);
        const criticalItems = allInventory.filter(item => item.quantity === 0);

        res.json({
            bookings: { today: todayBookings, upcoming: upcomingBookings, completed: completedBookings, noShow: noShowBookings, todayList: todayBookingsList },
            leads: { newInquiries, openConversations, unansweredMessages },
            forms: { pending: pendingForms, overdue: overdueForms, completed: completedForms },
            inventory: {
                lowStockItems: lowStockItems.map(i => ({ id: i.id, name: i.name, quantity: i.quantity, threshold: i.threshold, unit: i.unit })),
                criticalCount: criticalItems.length, lowStockCount: lowStockItems.length
            },
            alerts: { recent: alerts, unreadCount: unreadAlerts }
        });
    } catch (error) {
        next(error);
    }
});

// PATCH /api/dashboard/alerts/:id/read
router.patch('/alerts/:id/read', auth, async (req, res, next) => {
    try {
        const alert = await prisma.alert.update({ where: { id: req.params.id }, data: { isRead: true } });
        res.json(alert);
    } catch (error) { next(error); }
});

// PATCH /api/dashboard/alerts/read-all
router.patch('/alerts/read-all', auth, async (req, res, next) => {
    try {
        await prisma.alert.updateMany({ where: { workspaceId: req.workspaceId, isRead: false }, data: { isRead: true } });
        res.json({ message: 'All alerts marked as read' });
    } catch (error) { next(error); }
});

// GET /api/dashboard/analytics — Historical data for charts
router.get('/analytics', auth, async (req, res, next) => {
    try {
        const workspaceId = req.workspaceId;
        const now = new Date();

        // Last 30 days data
        const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

        const [
            allBookings, allContacts, serviceTypes,
            allForms, inventory, conversations
        ] = await Promise.all([
            prisma.booking.findMany({
                where: { workspaceId, dateTime: { gte: thirtyDaysAgo } },
                include: { serviceType: true },
                orderBy: { dateTime: 'asc' }
            }),
            prisma.contact.findMany({
                where: { workspaceId, createdAt: { gte: thirtyDaysAgo } },
                orderBy: { createdAt: 'asc' }
            }),
            prisma.serviceType.findMany({
                where: { workspaceId },
                include: { _count: { select: { bookings: true } } }
            }),
            prisma.formSubmission.findMany({
                where: { formTemplate: { workspaceId }, createdAt: { gte: thirtyDaysAgo } }
            }),
            prisma.inventoryItem.findMany({ where: { workspaceId } }),
            prisma.conversation.count({ where: { workspaceId, createdAt: { gte: thirtyDaysAgo } } })
        ]);

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
            if (revByDay[key] !== undefined) revByDay[key] += Number(b.serviceType?.price || 0);
        });

        // Bookings by day-of-week
        const dayOfWeek = [0, 0, 0, 0, 0, 0, 0]; // Sun=0 .. Sat=6
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

        const totalRevenue = allBookings.reduce((s, b) => s + Number(b.serviceType?.price || 0), 0);
        const thisWeekRevenue = allBookings.filter(b => new Date(b.dateTime) >= sevenDaysAgo)
            .reduce((s, b) => s + Number(b.serviceType?.price || 0), 0);

        res.json({
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
                newContacts: allContacts.length,
                newConversations: conversations,
                totalForms: allForms.length,
                inventoryItems: inventory.length,
                lowStock: inventory.filter(i => i.quantity <= i.threshold).length
            }
        });
    } catch (error) { next(error); }
});

// GET /api/dashboard/weekly-report — AI weekly summary
router.get('/weekly-report', auth, async (req, res, next) => {
    try {
        const workspaceId = req.workspaceId;
        const now = new Date();
        const sevenDaysAgo = new Date(now.getTime() - 7 * 86400000);
        const fourteenDaysAgo = new Date(now.getTime() - 14 * 86400000);

        const [
            thisWeekBookings, lastWeekBookings,
            thisWeekContacts, lastWeekContacts,
            openConversations, pendingForms, overdueForms,
            allInventory, workspace
        ] = await Promise.all([
            prisma.booking.findMany({ where: { workspaceId, dateTime: { gte: sevenDaysAgo } }, include: { serviceType: true } }),
            prisma.booking.count({ where: { workspaceId, dateTime: { gte: fourteenDaysAgo, lt: sevenDaysAgo } } }),
            prisma.contact.count({ where: { workspaceId, createdAt: { gte: sevenDaysAgo } } }),
            prisma.contact.count({ where: { workspaceId, createdAt: { gte: fourteenDaysAgo, lt: sevenDaysAgo } } }),
            prisma.conversation.count({ where: { workspaceId, status: 'open' } }),
            prisma.formSubmission.count({ where: { formTemplate: { workspaceId }, status: 'PENDING' } }),
            prisma.formSubmission.count({ where: { formTemplate: { workspaceId }, status: 'OVERDUE' } }),
            prisma.inventoryItem.findMany({ where: { workspaceId } }),
            prisma.workspace.findUnique({ where: { id: workspaceId }, select: { name: true } })
        ]);

        const thisWeekRevenue = thisWeekBookings.reduce((s, b) => s + Number(b.serviceType?.price || 0), 0);
        const noShows = thisWeekBookings.filter(b => b.status === 'NO_SHOW').length;
        const completed = thisWeekBookings.filter(b => b.status === 'COMPLETED').length;
        const bookingGrowth = lastWeekBookings > 0 ? Math.round(((thisWeekBookings.length - lastWeekBookings) / lastWeekBookings) * 100) : 0;
        const contactGrowth = lastWeekContacts > 0 ? Math.round(((thisWeekContacts - lastWeekContacts) / lastWeekContacts) * 100) : 0;
        const lowStockCount = allInventory.filter(i => i.quantity <= i.threshold).length;

        // Try AI-generated summary
        let aiSummary = '';
        try {
            const Groq = require('groq-sdk');
            if (process.env.GROQ_API_KEY) {
                const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
                const prompt = `You are Cara, a business analytics AI. Generate a concise weekly report for "${workspace?.name || 'this business'}".

Stats this week:
- ${thisWeekBookings.length} bookings (${bookingGrowth > 0 ? '+' : ''}${bookingGrowth}% vs last week)
- $${thisWeekRevenue} revenue
- ${completed} completed, ${noShows} no-shows
- ${thisWeekContacts} new contacts (${contactGrowth > 0 ? '+' : ''}${contactGrowth}% vs last week)
- ${openConversations} open conversations
- ${pendingForms} pending forms, ${overdueForms} overdue
- Low stock items: ${lowStockCount}

Rules:
- 3-4 short sentences max
- Highlight wins first, then concerns
- Be specific with numbers
- Sound like a smart, friendly analyst
- No markdown or emojis`;

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

// GET /api/dashboard/export/:type — CSV export
router.get('/export/:type', auth, async (req, res, next) => {
    try {
        const workspaceId = req.workspaceId;
        const type = req.params.type;

        if (type === 'bookings') {
            const bookings = await prisma.booking.findMany({
                where: { workspaceId },
                include: { contact: true, serviceType: true },
                orderBy: { dateTime: 'desc' }
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
                orderBy: { createdAt: 'desc' }
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
                orderBy: { name: 'asc' }
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

module.exports = router;

