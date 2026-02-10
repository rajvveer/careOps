const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const auth = require('../middleware/auth');

// GET /api/dashboard
router.get('/', auth, async (req, res, next) => {
    try {
        const workspaceId = req.workspaceId;
        const now = new Date();
        const todayStart = new Date(now);
        todayStart.setHours(0, 0, 0, 0);
        const todayEnd = new Date(now);
        todayEnd.setHours(23, 59, 59, 999);
        const weekFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

        // ─── Booking Overview ──────────────────────
        const [todayBookings, upcomingBookings, completedBookings, noShowBookings] = await Promise.all([
            prisma.booking.count({
                where: { workspaceId, dateTime: { gte: todayStart, lte: todayEnd } }
            }),
            prisma.booking.count({
                where: { workspaceId, dateTime: { gt: todayEnd, lte: weekFromNow }, status: 'CONFIRMED' }
            }),
            prisma.booking.count({
                where: { workspaceId, status: 'COMPLETED' }
            }),
            prisma.booking.count({
                where: { workspaceId, status: 'NO_SHOW' }
            })
        ]);

        // ─── Leads & Conversations ─────────────────
        const [newInquiries, openConversations, allConversations] = await Promise.all([
            prisma.contact.count({
                where: { workspaceId, createdAt: { gte: todayStart } }
            }),
            prisma.conversation.count({
                where: { workspaceId, status: 'open' }
            }),
            prisma.conversation.findMany({
                where: { workspaceId, status: 'open' },
                include: { messages: { orderBy: { createdAt: 'desc' }, take: 1 } }
            })
        ]);

        const unansweredMessages = allConversations.filter(c =>
            c.messages.length > 0 && c.messages[0].direction === 'INBOUND'
        ).length;

        // ─── Forms Status ──────────────────────────
        const [pendingForms, overdueForms, completedForms] = await Promise.all([
            prisma.formSubmission.count({
                where: { formTemplate: { workspaceId }, status: 'PENDING' }
            }),
            prisma.formSubmission.count({
                where: { formTemplate: { workspaceId }, status: 'OVERDUE' }
            }),
            prisma.formSubmission.count({
                where: { formTemplate: { workspaceId }, status: 'COMPLETED' }
            })
        ]);

        // ─── Inventory Alerts ──────────────────────
        const allInventory = await prisma.inventoryItem.findMany({
            where: { workspaceId }
        });
        const lowStockItems = allInventory.filter(item => item.quantity <= item.threshold);
        const criticalItems = allInventory.filter(item => item.quantity === 0);

        // ─── Recent Alerts ─────────────────────────
        const alerts = await prisma.alert.findMany({
            where: { workspaceId },
            orderBy: { createdAt: 'desc' },
            take: 10
        });

        const unreadAlerts = await prisma.alert.count({
            where: { workspaceId, isRead: false }
        });

        // ─── Today's Bookings Detail ───────────────
        const todayBookingsList = await prisma.booking.findMany({
            where: { workspaceId, dateTime: { gte: todayStart, lte: todayEnd } },
            include: { contact: true, serviceType: true },
            orderBy: { dateTime: 'asc' }
        });

        res.json({
            bookings: {
                today: todayBookings,
                upcoming: upcomingBookings,
                completed: completedBookings,
                noShow: noShowBookings,
                todayList: todayBookingsList
            },
            leads: {
                newInquiries,
                openConversations,
                unansweredMessages
            },
            forms: {
                pending: pendingForms,
                overdue: overdueForms,
                completed: completedForms
            },
            inventory: {
                lowStockItems: lowStockItems.map(i => ({ id: i.id, name: i.name, quantity: i.quantity, threshold: i.threshold, unit: i.unit })),
                criticalCount: criticalItems.length,
                lowStockCount: lowStockItems.length
            },
            alerts: {
                recent: alerts,
                unreadCount: unreadAlerts
            }
        });
    } catch (error) {
        next(error);
    }
});

// PATCH /api/dashboard/alerts/:id/read
router.patch('/alerts/:id/read', auth, async (req, res, next) => {
    try {
        const alert = await prisma.alert.update({
            where: { id: req.params.id },
            data: { isRead: true }
        });
        res.json(alert);
    } catch (error) {
        next(error);
    }
});

// PATCH /api/dashboard/alerts/read-all
router.patch('/alerts/read-all', auth, async (req, res, next) => {
    try {
        await prisma.alert.updateMany({
            where: { workspaceId: req.workspaceId, isRead: false },
            data: { isRead: true }
        });
        res.json({ message: 'All alerts marked as read' });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
