const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const auth = require('../middleware/auth');
const { checkPermission } = require('../middleware/roleCheck');
const automation = require('../services/automation');

// GET /api/inbox - List conversations
router.get('/', auth, checkPermission('inbox'), async (req, res, next) => {
    try {
        const { status, search, page = 1, limit = 20 } = req.query;
        const skip = (page - 1) * limit;

        const where = { workspaceId: req.workspaceId };
        if (status) where.status = status;

        const conversations = await prisma.conversation.findMany({
            where,
            skip: Number(skip),
            take: Number(limit),
            orderBy: { updatedAt: 'desc' },
            include: {
                contact: true,
                messages: {
                    orderBy: { createdAt: 'desc' },
                    take: 1
                }
            }
        });

        const total = await prisma.conversation.count({ where });

        // Count unanswered (last message is inbound)
        const unanswered = conversations.filter(c =>
            c.messages.length > 0 && c.messages[0].direction === 'INBOUND'
        ).length;

        res.json({
            conversations,
            total,
            unanswered,
            page: Number(page),
            totalPages: Math.ceil(total / limit)
        });
    } catch (error) {
        next(error);
    }
});

// GET /api/inbox/:conversationId - Full message history
router.get('/:conversationId', auth, checkPermission('inbox'), async (req, res, next) => {
    try {
        const conversation = await prisma.conversation.findFirst({
            where: { id: req.params.conversationId, workspaceId: req.workspaceId },
            include: {
                contact: true,
                messages: { orderBy: { createdAt: 'asc' } }
            }
        });

        if (!conversation) {
            return res.status(404).json({ error: 'Conversation not found' });
        }

        res.json(conversation);
    } catch (error) {
        next(error);
    }
});

// POST /api/inbox/:conversationId/reply - Staff reply
router.post('/:conversationId/reply', auth, checkPermission('inbox'), async (req, res, next) => {
    try {
        const { content, channel = 'EMAIL' } = req.body;

        if (!content) {
            return res.status(400).json({ error: 'Message content is required' });
        }

        const conversation = await prisma.conversation.findFirst({
            where: { id: req.params.conversationId, workspaceId: req.workspaceId },
            include: { contact: true }
        });

        if (!conversation) {
            return res.status(404).json({ error: 'Conversation not found' });
        }

        // Create message
        const message = await prisma.message.create({
            data: {
                conversationId: conversation.id,
                direction: 'OUTBOUND',
                channel,
                content
            }
        });

        // Pause automation for this conversation
        await automation.onStaffReply(req.workspaceId, conversation.id);

        // Send via channel
        if (channel === 'EMAIL' && conversation.contact.email) {
            const emailService = require('../services/email');
            await emailService.send(req.workspaceId, {
                to: conversation.contact.email,
                subject: `Message from ${req.user.workspace.name}`,
                text: content,
                html: `<p>${content}</p>`
            });
        }

        if (channel === 'SMS' && conversation.contact.phone) {
            const smsService = require('../services/sms');
            await smsService.send(req.workspaceId, { to: conversation.contact.phone, body: content });
        }

        // Update conversation
        await prisma.conversation.update({
            where: { id: conversation.id },
            data: { updatedAt: new Date() }
        });

        res.status(201).json(message);
    } catch (error) {
        next(error);
    }
});

// PATCH /api/inbox/:conversationId/status
router.patch('/:conversationId/status', auth, checkPermission('inbox'), async (req, res, next) => {
    try {
        const { status } = req.body;
        const conversation = await prisma.conversation.update({
            where: { id: req.params.conversationId },
            data: { status }
        });
        res.json(conversation);
    } catch (error) {
        next(error);
    }
});

module.exports = router;
