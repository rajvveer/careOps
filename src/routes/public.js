const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const automation = require('../services/automation');

// ─── Public Contact Form ───────────────────────────────

// POST /api/public/:workspaceId/contact
router.post('/:workspaceId/contact', async (req, res, next) => {
    try {
        const { workspaceId } = req.params;
        const { name, email, phone, message } = req.body;

        // Validate workspace
        const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });
        if (!workspace || !workspace.isActive) {
            return res.status(404).json({ error: 'Business not found or not active' });
        }

        if (!name) {
            return res.status(400).json({ error: 'Name is required' });
        }
        if (!email && !phone) {
            return res.status(400).json({ error: 'Email or phone is required' });
        }

        // Check for existing contact
        let contact = null;
        if (email) {
            contact = await prisma.contact.findFirst({ where: { workspaceId, email } });
        }
        if (!contact && phone) {
            contact = await prisma.contact.findFirst({ where: { workspaceId, phone } });
        }

        if (!contact) {
            contact = await prisma.contact.create({
                data: {
                    workspaceId,
                    name,
                    email: email || null,
                    phone: phone || null,
                    source: 'contact_form'
                }
            });
        }

        // Create or find conversation
        let conversation = await prisma.conversation.findFirst({
            where: { contactId: contact.id, workspaceId }
        });

        if (!conversation) {
            conversation = await prisma.conversation.create({
                data: {
                    workspaceId,
                    contactId: contact.id,
                    status: 'open'
                }
            });
        }

        // Save the inbound message
        if (message) {
            await prisma.message.create({
                data: {
                    conversationId: conversation.id,
                    direction: 'INBOUND',
                    channel: 'SYSTEM',
                    content: message
                }
            });
        }

        // Trigger automation
        await automation.onContactCreated(workspaceId, contact);

        res.status(201).json({
            message: 'Thank you for reaching out! We will get back to you shortly.',
            contactId: contact.id
        });
    } catch (error) {
        next(error);
    }
});

// ─── Public Booking Page ───────────────────────────────

// GET /api/public/:workspaceId/booking-page
router.get('/:workspaceId/booking-page', async (req, res, next) => {
    try {
        const { workspaceId } = req.params;

        const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });
        if (!workspace || !workspace.isActive) {
            return res.status(404).json({ error: 'Business not found or not active' });
        }

        const serviceTypes = await prisma.serviceType.findMany({
            where: { workspaceId },
            include: { availability: true }
        });

        res.json({
            business: {
                name: workspace.name,
                address: workspace.address,
                timezone: workspace.timezone
            },
            serviceTypes
        });
    } catch (error) {
        next(error);
    }
});

// GET /api/public/:workspaceId/available-slots
router.get('/:workspaceId/available-slots', async (req, res, next) => {
    try {
        const { workspaceId } = req.params;
        const { serviceTypeId, date } = req.query;

        if (!serviceTypeId || !date) {
            return res.status(400).json({ error: 'serviceTypeId and date are required' });
        }

        const serviceType = await prisma.serviceType.findUnique({
            where: { id: serviceTypeId },
            include: { availability: true }
        });

        if (!serviceType) {
            return res.status(404).json({ error: 'Service type not found' });
        }

        const requestedDate = new Date(date);
        const dayOfWeek = requestedDate.getDay();

        // Get availability for this day
        const dayAvailability = serviceType.availability.filter(a => a.dayOfWeek === dayOfWeek);

        if (dayAvailability.length === 0) {
            return res.json({ slots: [], message: 'No availability on this day' });
        }

        // Get existing bookings for this date
        const dayStart = new Date(date);
        dayStart.setHours(0, 0, 0, 0);
        const dayEnd = new Date(date);
        dayEnd.setHours(23, 59, 59, 999);

        const existingBookings = await prisma.booking.findMany({
            where: {
                serviceTypeId,
                dateTime: { gte: dayStart, lte: dayEnd },
                status: { not: 'CANCELLED' }
            }
        });

        // Generate available slots
        const slots = [];
        for (const avail of dayAvailability) {
            const [startH, startM] = avail.startTime.split(':').map(Number);
            const [endH, endM] = avail.endTime.split(':').map(Number);

            let currentMinutes = startH * 60 + startM;
            const endMinutes = endH * 60 + endM;

            while (currentMinutes + serviceType.duration <= endMinutes) {
                const slotHour = Math.floor(currentMinutes / 60);
                const slotMin = currentMinutes % 60;
                const slotTime = `${String(slotHour).padStart(2, '0')}:${String(slotMin).padStart(2, '0')}`;

                // Check if slot is taken
                const slotStart = new Date(date);
                slotStart.setHours(slotHour, slotMin, 0, 0);
                const slotEnd = new Date(slotStart.getTime() + serviceType.duration * 60000);

                const isBooked = existingBookings.some(b => {
                    const bStart = new Date(b.dateTime);
                    const bEnd = new Date(b.endTime);
                    return (slotStart < bEnd && slotEnd > bStart);
                });

                if (!isBooked) {
                    slots.push({
                        time: slotTime,
                        startTime: slotStart.toISOString(),
                        endTime: slotEnd.toISOString()
                    });
                }

                currentMinutes += serviceType.duration;
            }
        }

        res.json({ slots });
    } catch (error) {
        next(error);
    }
});

// POST /api/public/:workspaceId/book
router.post('/:workspaceId/book', async (req, res, next) => {
    try {
        const { workspaceId } = req.params;
        const { serviceTypeId, dateTime, name, email, phone, notes } = req.body;

        const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });
        if (!workspace || !workspace.isActive) {
            return res.status(404).json({ error: 'Business not found or not active' });
        }

        if (!serviceTypeId || !dateTime || !name) {
            return res.status(400).json({ error: 'serviceTypeId, dateTime, and name are required' });
        }
        if (!email && !phone) {
            return res.status(400).json({ error: 'Email or phone is required' });
        }

        const serviceType = await prisma.serviceType.findUnique({ where: { id: serviceTypeId } });
        if (!serviceType) {
            return res.status(404).json({ error: 'Service type not found' });
        }

        // Find or create contact
        let contact = null;
        if (email) {
            contact = await prisma.contact.findFirst({ where: { workspaceId, email } });
        }
        if (!contact && phone) {
            contact = await prisma.contact.findFirst({ where: { workspaceId, phone } });
        }
        if (!contact) {
            contact = await prisma.contact.create({
                data: {
                    workspaceId,
                    name,
                    email: email || null,
                    phone: phone || null,
                    source: 'booking'
                }
            });
        }

        // Ensure conversation exists
        let conversation = await prisma.conversation.findFirst({
            where: { contactId: contact.id, workspaceId }
        });
        if (!conversation) {
            conversation = await prisma.conversation.create({
                data: {
                    workspaceId,
                    contactId: contact.id,
                    status: 'open'
                }
            });
        }

        // Create booking
        const bookingStart = new Date(dateTime);
        const bookingEnd = new Date(bookingStart.getTime() + serviceType.duration * 60000);

        const booking = await prisma.booking.create({
            data: {
                workspaceId,
                contactId: contact.id,
                serviceTypeId,
                dateTime: bookingStart,
                endTime: bookingEnd,
                status: 'CONFIRMED',
                notes: notes || null
            }
        });

        // Trigger automation (confirmation + forms)
        await automation.onBookingCreated(workspaceId, booking, contact);

        res.status(201).json({
            message: 'Booking confirmed! You will receive a confirmation shortly.',
            booking: {
                id: booking.id,
                service: serviceType.name,
                dateTime: booking.dateTime,
                endTime: booking.endTime,
                location: serviceType.location
            }
        });
    } catch (error) {
        next(error);
    }
});

// ─── Public Form Access ────────────────────────────────

// GET /api/public/forms/:submissionId
router.get('/forms/:submissionId', async (req, res, next) => {
    try {
        const submission = await prisma.formSubmission.findUnique({
            where: { id: req.params.submissionId },
            include: {
                formTemplate: true,
                contact: { select: { name: true, email: true } },
                booking: { include: { serviceType: true } }
            }
        });

        if (!submission) {
            return res.status(404).json({ error: 'Form not found' });
        }

        res.json({
            id: submission.id,
            formName: submission.formTemplate.name,
            fields: submission.formTemplate.fields,
            status: submission.status,
            data: submission.data,
            contact: submission.contact,
            booking: submission.booking ? {
                service: submission.booking.serviceType.name,
                dateTime: submission.booking.dateTime
            } : null
        });
    } catch (error) {
        next(error);
    }
});

// POST /api/public/forms/:submissionId
router.post('/forms/:submissionId', async (req, res, next) => {
    try {
        const { data } = req.body;

        const submission = await prisma.formSubmission.update({
            where: { id: req.params.submissionId },
            data: {
                data,
                status: 'COMPLETED'
            }
        });

        res.json({ message: 'Form submitted successfully!', submission });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
