const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const auth = require('../middleware/auth');

// GET /api/contacts
router.get('/', auth, async (req, res, next) => {
    try {
        const { search, source, page = 1, limit = 20 } = req.query;
        const skip = (page - 1) * limit;

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

        res.json({ contacts, total, page: Number(page), totalPages: Math.ceil(total / limit) });
    } catch (error) {
        next(error);
    }
});

// GET /api/contacts/:id
router.get('/:id', auth, async (req, res, next) => {
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
router.post('/', auth, async (req, res, next) => {
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
    } catch (error) {
        next(error);
    }
});

// PUT /api/contacts/:id
router.put('/:id', auth, async (req, res, next) => {
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
    } catch (error) {
        next(error);
    }
});

module.exports = router;
