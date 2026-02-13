const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const prisma = require('../lib/prisma');
const auth = require('../middleware/auth');

// POST /api/auth/register
router.post('/register', async (req, res, next) => {
    try {
        const { email, password, name, businessName, address, timezone, contactEmail } = req.body;

        if (!email || !password || !name || !businessName) {
            return res.status(400).json({ error: 'Email, password, name, and business name are required' });
        }

        const existingUser = await prisma.user.findUnique({ where: { email } });
        if (existingUser) {
            return res.status(409).json({ error: 'Email already registered' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        // Create workspace and owner in a transaction
        const result = await prisma.$transaction(async (tx) => {
            const workspace = await tx.workspace.create({
                data: {
                    name: businessName,
                    address: address || null,
                    timezone: timezone || 'UTC',
                    contactEmail: contactEmail || email,
                    onboardingStep: 1
                }
            });

            const user = await tx.user.create({
                data: {
                    email,
                    password: hashedPassword,
                    name,
                    role: 'OWNER',
                    workspaceId: workspace.id
                }
            });

            return { user, workspace };
        });

        const token = jwt.sign({ userId: result.user.id }, process.env.JWT_SECRET, {
            expiresIn: process.env.JWT_EXPIRES_IN || '7d'
        });

        res.status(201).json({
            token,
            user: {
                id: result.user.id,
                email: result.user.email,
                name: result.user.name,
                role: result.user.role,
                workspaceId: result.workspace.id
            },
            workspace: result.workspace
        });
    } catch (error) {
        next(error);
    }
});

// POST /api/auth/login
router.post('/login', async (req, res, next) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required' });
        }

        const user = await prisma.user.findUnique({
            where: { email },
            include: { workspace: true, permissions: true }
        });

        if (!user) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, {
            expiresIn: process.env.JWT_EXPIRES_IN || '7d'
        });

        res.json({
            token,
            user: {
                id: user.id,
                email: user.email,
                name: user.name,
                role: user.role,
                workspaceId: user.workspaceId,
                permissions: user.permissions
            },
            workspace: user.workspace
        });
    } catch (error) {
        next(error);
    }
});

// GET /api/auth/me
router.get('/me', auth, async (req, res) => {
    res.json({
        user: {
            id: req.user.id,
            email: req.user.email,
            name: req.user.name,
            role: req.user.role,
            workspaceId: req.user.workspaceId,
            permissions: req.user.permissions
        },
        workspace: req.user.workspace
    });
});

// DELETE /api/auth/account — delete user account + workspace
router.delete('/account', auth, async (req, res, next) => {
    try {
        const user = req.user;
        if (user.role !== 'OWNER') {
            return res.status(403).json({ error: 'Only workspace owners can delete accounts' });
        }

        const wId = user.workspaceId;

        // Delete in dependency order (leaf tables first), individually to avoid transaction timeout
        await prisma.automationLog.deleteMany({ where: { workspaceId: wId } });
        await prisma.alert.deleteMany({ where: { workspaceId: wId } });
        await prisma.message.deleteMany({ where: { conversation: { workspaceId: wId } } });
        await prisma.conversation.deleteMany({ where: { workspaceId: wId } });
        await prisma.availability.deleteMany({ where: { serviceType: { workspaceId: wId } } });
        await prisma.formSubmission.deleteMany({ where: { formTemplate: { workspaceId: wId } } });
        await prisma.booking.deleteMany({ where: { workspaceId: wId } });
        await prisma.formTemplate.deleteMany({ where: { workspaceId: wId } });
        await prisma.serviceType.deleteMany({ where: { workspaceId: wId } });
        await prisma.inventoryItem.deleteMany({ where: { workspaceId: wId } });
        await prisma.contact.deleteMany({ where: { workspaceId: wId } });
        await prisma.integration.deleteMany({ where: { workspaceId: wId } });
        await prisma.staffInvitation.deleteMany({ where: { workspaceId: wId } });
        await prisma.calendarConnection.deleteMany({ where: { workspaceId: wId } });
        await prisma.staffPermission.deleteMany({ where: { user: { workspaceId: wId } } });
        await prisma.user.deleteMany({ where: { workspaceId: wId } });
        await prisma.workspace.delete({ where: { id: wId } });

        res.json({ message: 'Account deleted successfully' });
    } catch (error) {
        next(error);
    }
});

module.exports = router;

