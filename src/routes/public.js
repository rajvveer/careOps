const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const automation = require('../services/automation');
const { invalidateWorkspaceCache } = require('./dashboard');

// ─── Public Contact Form ───────────────────────────────

// GET /api/public/:workspaceId/contact-form - Get contact form config
router.get('/:workspaceId/contact-form', async (req, res, next) => {
    try {
        const workspace = await prisma.workspace.findUnique({
            where: { id: req.params.workspaceId },
            select: { contactFormFields: true, name: true, isActive: true }
        });
        if (!workspace) {
            return res.status(404).json({ error: 'Workspace not found' });
        }
        const defaultFields = [
            { name: 'Name', type: 'text', required: true },
            { name: 'Email', type: 'email', required: true },
            { name: 'Phone', type: 'tel', required: false },
            { name: 'Message', type: 'textarea', required: true }
        ];
        res.json({
            businessName: workspace.name,
            fields: workspace.contactFormFields || defaultFields
        });
    } catch (error) {
        next(error);
    }
});

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

        // Trigger automation (fire-and-forget — don't block response)
        automation.onContactCreated(workspaceId, contact).catch(err => console.error('Automation error:', err.message));

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

        // Find or create contact — always update with the booker's latest info
        let contact = null;
        if (email) {
            contact = await prisma.contact.findFirst({ where: { workspaceId, email } });
        }
        if (!contact && phone) {
            contact = await prisma.contact.findFirst({ where: { workspaceId, phone } });
        }
        if (contact) {
            // Update contact with booker's current info
            contact = await prisma.contact.update({
                where: { id: contact.id },
                data: {
                    name: name || contact.name,
                    email: email || contact.email,
                    phone: phone || contact.phone
                }
            });
        } else {
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

        // Trigger automation (fire-and-forget — don't block response)
        automation.onBookingCreated(workspaceId, booking, contact).catch(err => console.error('Automation error:', err.message));

        // Invalidate dashboard cache so analytics update immediately
        invalidateWorkspaceCache(workspaceId);

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

        // Clean up any other PENDING submissions for the same contact + template
        // (prevents stale PENDING entries from booking automation)
        if (submission.contactId && submission.formTemplateId) {
            await prisma.formSubmission.deleteMany({
                where: {
                    formTemplateId: submission.formTemplateId,
                    contactId: submission.contactId,
                    status: 'PENDING',
                    id: { not: submission.id }
                }
            });
        }

        res.json({ message: 'Form submitted successfully!', submission });
    } catch (error) {
        next(error);
    }
});

// ─── Public Form Template Access (shareable links) ─────

// GET /api/public/:workspaceId/form-template/:templateId
router.get('/:workspaceId/form-template/:templateId', async (req, res, next) => {
    try {
        const { workspaceId, templateId } = req.params;
        const workspace = await prisma.workspace.findUnique({
            where: { id: workspaceId },
            select: { name: true, isActive: true }
        });
        if (!workspace || !workspace.isActive) {
            return res.status(404).json({ error: 'Business not found' });
        }

        const template = await prisma.formTemplate.findFirst({
            where: { id: templateId, workspaceId },
            select: { id: true, name: true, fields: true, googleFormUrl: true, linkedServiceType: { select: { name: true } } }
        });
        if (!template) {
            return res.status(404).json({ error: 'Form not found' });
        }

        res.json({
            businessName: workspace.name,
            formName: template.name,
            fields: template.fields,
            googleFormUrl: template.googleFormUrl,
            linkedService: template.linkedServiceType?.name || null
        });
    } catch (error) {
        next(error);
    }
});

// POST /api/public/:workspaceId/form-template/:templateId/submit
router.post('/:workspaceId/form-template/:templateId/submit', async (req, res, next) => {
    try {
        const { workspaceId, templateId } = req.params;
        const { data, name, email, phone } = req.body;

        const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });
        if (!workspace || !workspace.isActive) {
            return res.status(404).json({ error: 'Business not found' });
        }

        const template = await prisma.formTemplate.findUnique({ where: { id: templateId } });
        if (!template) {
            return res.status(404).json({ error: 'Form not found' });
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
                    name: name || 'Anonymous',
                    email: email || null,
                    phone: phone || null,
                    source: 'form'
                }
            });
        }

        // Check if there's an existing PENDING submission for this contact+template (created by booking automation)
        let submission = await prisma.formSubmission.findFirst({
            where: {
                formTemplateId: templateId,
                contactId: contact.id,
                status: 'PENDING'
            }
        });

        if (submission) {
            // Update existing PENDING submission instead of creating duplicate
            submission = await prisma.formSubmission.update({
                where: { id: submission.id },
                data: { data: data || {}, status: 'COMPLETED' }
            });
        } else {
            // Create new submission (standalone form, not linked to booking)
            submission = await prisma.formSubmission.create({
                data: {
                    formTemplateId: templateId,
                    contactId: contact.id,
                    data: data || {},
                    status: 'COMPLETED'
                }
            });
        }

        // Clean up any remaining PENDING submissions for the same contact + template
        await prisma.formSubmission.deleteMany({
            where: {
                formTemplateId: templateId,
                contactId: contact.id,
                status: 'PENDING',
                id: { not: submission.id }
            }
        });

        // Create alert for owner
        prisma.alert.create({
            data: {
                workspaceId,
                type: 'SYSTEM',
                message: `New form submission: ${template.name} from ${name || email || 'Anonymous'}`,
                link: '/forms'
            }
        }).catch(() => { });

        // Send email notification to business owner
        try {
            const emailService = require('../services/email');
            const owner = await prisma.user.findFirst({ where: { workspaceId, role: 'OWNER' } });
            if (owner?.email) {
                const submitterName = name || email || 'Anonymous';
                const fieldEntries = data && typeof data === 'object' ? Object.entries(data) : [];
                const fieldsHtml = fieldEntries.map(([key, value], i) =>
                    `<tr style="${i % 2 ? 'background:#f9f9f9;' : ''}"><td style="padding:8px;font-weight:bold;color:#555;">${key}</td><td style="padding:8px;">${value || 'N/A'}</td></tr>`
                ).join('');

                await emailService.send(workspaceId, {
                    to: owner.email,
                    subject: `📋 Form Submitted: ${template.name} by ${submitterName}`,
                    text: `New form submission received!\n\nForm: ${template.name}\nSubmitted by: ${submitterName}\nEmail: ${email || 'N/A'}\nPhone: ${phone || 'N/A'}\n\n${fieldEntries.map(([k, v]) => `${k}: ${v || 'N/A'}`).join('\n')}\n\nView submissions: ${process.env.FRONTEND_URL}/forms`,
                    html: `
                        <h2>📋 New Form Submission</h2>
                        <table style="border-collapse:collapse;width:100%;max-width:500px;">
                            <tr><td style="padding:8px;font-weight:bold;color:#555;">Form</td><td style="padding:8px;">${template.name}</td></tr>
                            <tr style="background:#f9f9f9;"><td style="padding:8px;font-weight:bold;color:#555;">Submitted by</td><td style="padding:8px;">${submitterName}</td></tr>
                            <tr><td style="padding:8px;font-weight:bold;color:#555;">Email</td><td style="padding:8px;">${email || 'N/A'}</td></tr>
                            <tr style="background:#f9f9f9;"><td style="padding:8px;font-weight:bold;color:#555;">Phone</td><td style="padding:8px;">${phone || 'N/A'}</td></tr>
                        </table>
                        ${fieldEntries.length > 0 ? `
                        <h3 style="margin-top:16px;">Form Responses</h3>
                        <table style="border-collapse:collapse;width:100%;max-width:500px;border:1px solid #eee;">
                            ${fieldsHtml}
                        </table>` : ''}
                        <p style="margin-top:16px;"><a href="${process.env.FRONTEND_URL}/forms" style="background:#4F46E5;color:white;padding:10px 20px;border-radius:8px;text-decoration:none;display:inline-block;">View Submissions →</a></p>
                    `
                });
            }
        } catch (emailErr) {
            console.error('Form submission email error:', emailErr.message);
        }

        res.status(201).json({ message: 'Form submitted successfully!', submissionId: submission.id });
    } catch (error) {
        next(error);
    }
});

// ─── Digital Waitlist ──────────────────────────────────

// POST /api/public/:workspaceId/waitlist - Join waitlist for a fully booked slot
router.post('/:workspaceId/waitlist', async (req, res, next) => {
    try {
        const { workspaceId } = req.params;
        const { serviceTypeId, date, name, email, phone } = req.body;

        const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });
        if (!workspace || !workspace.isActive) {
            return res.status(404).json({ error: 'Business not found or not active' });
        }

        if (!serviceTypeId || !date || !name) {
            return res.status(400).json({ error: 'serviceTypeId, date, and name are required' });
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
        if (email) contact = await prisma.contact.findFirst({ where: { workspaceId, email } });
        if (!contact && phone) contact = await prisma.contact.findFirst({ where: { workspaceId, phone } });
        if (!contact) {
            contact = await prisma.contact.create({
                data: { workspaceId, name, email: email || null, phone: phone || null, source: 'waitlist' }
            });
        }

        // Create or find conversation
        let conversation = await prisma.conversation.findFirst({
            where: { contactId: contact.id, workspaceId }
        });
        if (!conversation) {
            conversation = await prisma.conversation.create({
                data: { workspaceId, contactId: contact.id, status: 'open' }
            });
        }

        // Add waitlist message to conversation
        await prisma.message.create({
            data: {
                conversationId: conversation.id,
                direction: 'INBOUND',
                channel: 'SYSTEM',
                content: `Waitlist request: ${name} wants ${serviceType.name} on ${new Date(date).toLocaleDateString()}. Contact: ${email || phone}`,
                metadata: { type: 'waitlist', serviceTypeId, date, status: 'waiting' }
            }
        });

        // Create alert for workspace owner
        await prisma.alert.create({
            data: {
                workspaceId,
                type: 'SYSTEM',
                message: `${name} joined the waitlist for ${serviceType.name} on ${new Date(date).toLocaleDateString()}`,
                link: '/inbox'
            }
        });

        res.status(201).json({
            message: "You've been added to the waitlist! We'll notify you if a spot opens up.",
            position: 'next'
        });
    } catch (error) {
        next(error);
    }
});

module.exports = router;

