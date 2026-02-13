const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const auth = require('../middleware/auth');
const { checkPermission } = require('../middleware/roleCheck');
const { invalidateWorkspaceCache } = require('./dashboard');

// GET /api/contacts
router.get('/', auth, checkPermission('inbox'), async (req, res, next) => {
    try {
        const { search, source, page = 1, limit = 20 } = req.query;
        const pg = Number(page);
        const lim = Number(limit);
        const skip = (pg - 1) * lim;

        const where = { workspaceId: req.workspaceId };
        if (search) {
            where.OR = [
                { name: { contains: search, mode: 'insensitive' } },
                { email: { contains: search, mode: 'insensitive' } },
                { phone: { contains: search } }
            ];
        }
        if (source) where.source = source;

        const [contacts, total] = await Promise.all([
            prisma.contact.findMany({
                where,
                skip: Number(skip),
                take: Number(limit),
                orderBy: { createdAt: 'desc' },
                include: {
                    _count: { select: { bookings: true, conversations: true } }
                }
            }),
            prisma.contact.count({ where })
        ]);

        res.json({ contacts, total, page: pg, totalPages: Math.ceil(total / lim) });
    } catch (error) {
        next(error);
    }
});

// GET /api/contacts/:id
router.get('/:id', auth, checkPermission('inbox'), async (req, res, next) => {
    try {
        const contact = await prisma.contact.findFirst({
            where: { id: req.params.id, workspaceId: req.workspaceId },
            include: {
                conversations: {
                    include: {
                        messages: { orderBy: { createdAt: 'desc' }, take: 5 }
                    }
                },
                bookings: {
                    include: { serviceType: true },
                    orderBy: { dateTime: 'desc' }
                },
                formSubmissions: {
                    include: { formTemplate: true }
                }
            }
        });

        if (!contact) {
            return res.status(404).json({ error: 'Contact not found' });
        }

        res.json(contact);
    } catch (error) {
        next(error);
    }
});

// POST /api/contacts
router.post('/', auth, checkPermission('inbox'), async (req, res, next) => {
    try {
        const { name, email, phone, source } = req.body;

        if (!name) {
            return res.status(400).json({ error: 'Name is required' });
        }
        if (!email && !phone) {
            return res.status(400).json({ error: 'Email or phone is required' });
        }

        const contact = await prisma.contact.create({
            data: {
                workspaceId: req.workspaceId,
                name,
                email: email || null,
                phone: phone || null,
                source: source || 'manual'
            }
        });

        // Create a conversation for this contact
        await prisma.conversation.create({
            data: {
                workspaceId: req.workspaceId,
                contactId: contact.id,
                status: 'open'
            }
        });

        res.status(201).json(contact);
        invalidateWorkspaceCache(req.workspaceId);
    } catch (error) {
        next(error);
    }
});

// PUT /api/contacts/:id
router.put('/:id', auth, checkPermission('inbox'), async (req, res, next) => {
    try {
        const { name, email, phone } = req.body;
        const contact = await prisma.contact.update({
            where: { id: req.params.id },
            data: {
                ...(name && { name }),
                ...(email !== undefined && { email }),
                ...(phone !== undefined && { phone })
            }
        });
        res.json(contact);
        invalidateWorkspaceCache(req.workspaceId);
    } catch (error) {
        next(error);
    }
});

module.exports = router;
