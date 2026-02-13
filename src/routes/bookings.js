const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const auth = require('../middleware/auth');
const { ownerOnly, checkPermission } = require('../middleware/roleCheck');

// ─── Service Types ─────────────────────────────────────

// GET /api/bookings/service-types
router.get('/service-types', auth, async (req, res, next) => {
    try {
        const serviceTypes = await prisma.serviceType.findMany({
            where: { workspaceId: req.workspaceId },
            include: {
                availability: true,
                _count: { select: { bookings: true } }
            }
        });
        res.json(serviceTypes);
    } catch (error) {
        next(error);
    }
});

// POST /api/bookings/service-types
router.post('/service-types', auth, ownerOnly, async (req, res, next) => {
    try {
        const { name, description, duration, price, location } = req.body;

        if (!name || !duration) {
            return res.status(400).json({ error: 'Name and duration are required' });
        }

        const serviceType = await prisma.serviceType.create({
            data: {
                workspaceId: req.workspaceId,
                name,
                description: description || null,
                duration: Number(duration),
                price: price !== undefined ? Number(price) : 0,
                location: location || null
            }
        });

        // Update onboarding step
        await prisma.workspace.update({
            where: { id: req.workspaceId },
            data: { onboardingStep: { set: Math.max(4, req.user.workspace.onboardingStep) } }
        });

        res.status(201).json(serviceType);
    } catch (error) {
        next(error);
    }
});

// PUT /api/bookings/service-types/:id
router.put('/service-types/:id', auth, ownerOnly, async (req, res, next) => {
    try {
        const { name, description, duration, price, location } = req.body;
        const serviceType = await prisma.serviceType.update({
            where: { id: req.params.id },
            data: {
                ...(name && { name }),
                ...(description !== undefined && { description }),
                ...(duration && { duration: Number(duration) }),
                ...(price !== undefined && { price: Number(price) }),
                ...(location !== undefined && { location })
            }
        });
        res.json(serviceType);
    } catch (error) {
        next(error);
    }
});

// DELETE /api/bookings/service-types/:id
router.delete('/service-types/:id', auth, ownerOnly, async (req, res, next) => {
    try {
        await prisma.serviceType.delete({ where: { id: req.params.id } });
        res.json({ message: 'Service type deleted' });
    } catch (error) {
        next(error);
    }
});

// ─── Availability ──────────────────────────────────────

// POST /api/bookings/availability
router.post('/availability', auth, ownerOnly, async (req, res, next) => {
    try {
        const { serviceTypeId, slots } = req.body;
        // slots: [{ dayOfWeek: 0, startTime: "09:00", endTime: "17:00" }]

        if (!serviceTypeId || !slots || !slots.length) {
            return res.status(400).json({ error: 'serviceTypeId and slots are required' });
        }

        // Delete existing availability for this service type
        await prisma.availability.deleteMany({ where: { serviceTypeId } });

        // Create new slots
        const created = await prisma.availability.createMany({
            data: slots.map(slot => ({
                serviceTypeId,
                dayOfWeek: slot.dayOfWeek,
                startTime: slot.startTime,
                endTime: slot.endTime
            }))
        });

        const availability = await prisma.availability.findMany({ where: { serviceTypeId } });

        res.status(201).json(availability);
    } catch (error) {
        next(error);
    }
});

// GET /api/bookings/availability/:serviceTypeId
router.get('/availability/:serviceTypeId', auth, async (req, res, next) => {
    try {
        const availability = await prisma.availability.findMany({
            where: { serviceTypeId: req.params.serviceTypeId }
        });
        res.json(availability);
    } catch (error) {
        next(error);
    }
});

// POST /api/bookings/availability/add - Add slots without deleting existing ones
router.post('/availability/add', auth, ownerOnly, async (req, res, next) => {
    try {
        const { serviceTypeId, slots } = req.body;

        if (!serviceTypeId || !slots || !slots.length) {
            return res.status(400).json({ error: 'serviceTypeId and slots are required' });
        }

        // Filter out duplicates — skip slots that already exist
        const existing = await prisma.availability.findMany({ where: { serviceTypeId } });
        const newSlots = slots.filter(slot => !existing.some(
            e => e.dayOfWeek === slot.dayOfWeek && e.startTime === slot.startTime && e.endTime === slot.endTime
        ));

        if (newSlots.length === 0) {
            return res.status(400).json({ error: 'This slot already exists for this service' });
        }

        await prisma.availability.createMany({
            data: newSlots.map(slot => ({
                serviceTypeId,
                dayOfWeek: slot.dayOfWeek,
                startTime: slot.startTime,
                endTime: slot.endTime
            }))
        });

        const availability = await prisma.availability.findMany({ where: { serviceTypeId } });
        res.status(201).json(availability);
    } catch (error) {
        next(error);
    }
});

// DELETE /api/bookings/availability/:id - Remove a single slot
router.delete('/availability/:id', auth, ownerOnly, async (req, res, next) => {
    try {
        await prisma.availability.delete({ where: { id: req.params.id } });
        res.json({ message: 'Slot removed' });
    } catch (error) {
        next(error);
    }
});

// ─── Bookings ──────────────────────────────────────────

// GET /api/bookings
router.get('/', auth, checkPermission('bookings'), async (req, res, next) => {
    try {
        const { status, date, page = 1, limit = 20 } = req.query;
        const skip = (page - 1) * limit;

        const where = { workspaceId: req.workspaceId };
        if (status) where.status = status;
        if (date) {
            const start = new Date(date);
            const end = new Date(date);
            end.setDate(end.getDate() + 1);
            where.dateTime = { gte: start, lt: end };
        }

        const [bookings, total] = await Promise.all([
            prisma.booking.findMany({
                where,
                skip: Number(skip),
                take: Number(limit),
                orderBy: { dateTime: 'asc' },
                include: {
                    contact: true,
                    serviceType: true,
                    _count: { select: { formSubmissions: true } }
                }
            }),
            prisma.booking.count({ where })
        ]);

        res.json({ bookings, total, page: Number(page), totalPages: Math.ceil(total / limit) });
    } catch (error) {
        next(error);
    }
});

// GET /api/bookings/:id
router.get('/:id', auth, checkPermission('bookings'), async (req, res, next) => {
    try {
        const booking = await prisma.booking.findFirst({
            where: { id: req.params.id, workspaceId: req.workspaceId },
            include: {
                contact: true,
                serviceType: true,
                formSubmissions: { include: { formTemplate: true } }
            }
        });

        if (!booking) {
            return res.status(404).json({ error: 'Booking not found' });
        }

        res.json(booking);
    } catch (error) {
        next(error);
    }
});

// PATCH /api/bookings/:id/status
router.patch('/:id/status', auth, checkPermission('bookings'), async (req, res, next) => {
    try {
        const { status } = req.body;

        if (!['CONFIRMED', 'COMPLETED', 'NO_SHOW', 'CANCELLED'].includes(status)) {
            return res.status(400).json({ error: 'Invalid status' });
        }

        const booking = await prisma.booking.update({
            where: { id: req.params.id },
            data: { status },
            include: { contact: true, serviceType: true }
        });

        res.json(booking);
    } catch (error) {
        next(error);
    }
});

module.exports = router;
